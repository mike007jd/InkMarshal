//! The engine registry: the running-engine map + admission-reservation map (see
//! the EngineRegistry doc for the lock order), registration, pruning, and the
//! process-group / job-object teardown of stopped engines.

use super::EngineInfo;
use std::collections::HashMap;
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;

#[cfg(windows)]
use super::spawn::WindowsJob;

pub(super) struct RunningEngine {
    pub(super) info: EngineInfo,
    pub(super) child: Child,
    #[cfg(unix)]
    pub(super) pgid: i32,
    #[cfg(windows)]
    pub(super) job: WindowsJob,
}

/// Engine registry. `.0` is the live running-engine map; `.1` is the admission
/// reservation map (engine_id → footprint bytes) holding footprints that have
/// passed budget admission but aren't yet in the running map (spawn + cold load
/// in flight). Counting it closes the budget TOCTOU so two concurrent starts
/// can't double-spend the same free RAM. See `admit_engine`.
///
/// Lock order, to stay deadlock-free: `admit_engine` is the ONLY place that
/// holds both locks, and it takes `.1` (admission) THEN `.0` (running). Every
/// other path either takes a single lock or takes them strictly sequentially
/// (acquire-release-acquire), never `.0`-then-`.1` while still holding `.0`.
#[derive(Default)]
pub struct EngineRegistry(
    pub(super) Mutex<HashMap<String, RunningEngine>>,
    pub(super) Mutex<HashMap<String, u64>>,
);

pub(super) enum RegisterEngineResult {
    Inserted,
    Duplicate {
        existing: EngineInfo,
        rejected: Box<RunningEngine>,
    },
}

/// Returns `true` if the registered engine's child process has already exited
/// (or the slot has been removed). A still-running child returns `false`; an
/// unknown `engine_id` returns `true` so callers stop waiting on a vanished
/// engine. A poisoned registry lock is treated as "cannot confirm running" →
/// `false`, so we don't fast-fail on a transient lock issue.
pub(super) fn engine_process_exited(registry: &EngineRegistry, engine_id: &str) -> bool {
    match registry.0.lock() {
        Ok(mut map) => match map.get_mut(engine_id) {
            Some(running) => !matches!(running.child.try_wait(), Ok(None)),
            None => true,
        },
        Err(_) => false,
    }
}

pub(super) fn register_running_engine(
    registry: &EngineRegistry,
    engine_id: String,
    engine: RunningEngine,
) -> Result<RegisterEngineResult, String> {
    let mut map = registry
        .0
        .lock()
        .map_err(|_| "engine registry poisoned".to_string())?;
    if let Some(existing) = map.get_mut(&engine_id) {
        match existing.child.try_wait() {
            Ok(None) => {
                return Ok(RegisterEngineResult::Duplicate {
                    existing: existing.info.clone(),
                    rejected: Box::new(engine),
                });
            }
            Ok(Some(_)) | Err(_) => {
                map.remove(&engine_id);
            }
        }
    }
    map.insert(engine_id, engine);
    Ok(RegisterEngineResult::Inserted)
}

pub(super) fn prune_exited_engines(map: &mut HashMap<String, RunningEngine>) {
    map.retain(|_, engine| matches!(engine.child.try_wait(), Ok(None)));
}

pub(super) fn terminate_running_engine(mut engine: RunningEngine) {
    #[cfg(unix)]
    unsafe {
        libc::killpg(engine.pgid, libc::SIGTERM);
    }
    #[cfg(windows)]
    engine.job.terminate();
    // Poll for graceful exit up to 2s before escalating to SIGKILL.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        match engine.child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() >= deadline => {
                #[cfg(unix)]
                unsafe {
                    libc::killpg(engine.pgid, libc::SIGKILL);
                }
                #[cfg(windows)]
                engine.job.terminate();
                let _ = engine.child.kill();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    let _ = engine.child.wait();
}

pub(super) fn stop_engine_inner(registry: &EngineRegistry, engine_id: &str) {
    if let Ok(mut map) = registry.0.lock() {
        if let Some(engine) = map.remove(engine_id) {
            terminate_running_engine(engine);
        }
    }
}

pub fn stop_all(registry: &EngineRegistry) {
    let ids: Vec<String> = registry
        .0
        .lock()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        stop_engine_inner(registry, &id);
    }
}
