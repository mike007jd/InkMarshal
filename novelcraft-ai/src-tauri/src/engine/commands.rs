//! The 7 #[tauri::command] entry points. engine_start orchestrates spawn +
//! budget admission + registry + readiness + logging; the rest are thin
//! queries / stop verbs over the registry.

use super::budget::{
    admit_estimated_footprint, budget_available_bytes, engine_memory_unavailable_error,
    estimate_footprint_inner, host_headroom_bytes, normalize_engine_model_path_for_match,
    validate_engine_model_path,
};
use super::log::{
    engine_log_dir, engine_log_path, engine_log_targets, read_log_tail, MAX_ENGINE_LOG_TAIL_BYTES,
};
use super::readiness::wait_engine_ready;
use super::registry::{
    prune_exited_engines, register_running_engine, stop_engine_inner, terminate_running_engine,
    EngineRegistry, RegisterEngineResult, RunningEngine,
};
use super::spawn::{
    apply_engine_env_allowlist, engine_binary_path, make_engine_id, normalize_engine_label,
    pick_free_port,
};
use super::{
    EngineBudget, EngineFootprint, EngineFormat, EngineInfo, EngineStartArgs, RunningEngineSummary,
};
use crate::model_manager::registered_model_path;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

#[cfg(windows)]
use super::spawn::WindowsJob;

#[tauri::command]
pub async fn engine_start(
    args: EngineStartArgs,
    app: tauri::AppHandle,
    registry: tauri::State<'_, EngineRegistry>,
) -> Result<EngineInfo, String> {
    let bin = engine_binary_path(&app, args.format)?;
    let registered_path = registered_model_path(&app, &args.model_path)?;
    let model_path = validate_engine_model_path(&registered_path, args.format)?;
    let model_path_string = model_path.to_string_lossy().into_owned();
    let engine_label = normalize_engine_label(args.engine_label)?;
    let engine_id = make_engine_id(args.format, &model_path_string, &engine_label);

    let cached = if let Ok(mut map) = registry.0.lock() {
        if let Some(running) = map.get_mut(&engine_id) {
            match running.child.try_wait() {
                Ok(None) => Some(running.info.clone()),
                Ok(Some(_)) | Err(_) => {
                    map.remove(&engine_id);
                    None
                }
            }
        } else {
            None
        }
    } else {
        None
    };
    if let Some(info) = cached {
        // An already-registered engine has previously become ready, so it
        // should answer almost immediately. Use a short readiness window
        // (with try_wait fast-fail) rather than re-blocking the full 180s
        // ceiling that only a cold first load needs.
        match wait_engine_ready(&registry, &engine_id, info.port, Duration::from_secs(10)).await {
            Ok(true) => return Ok(info),
            Err(error) => {
                stop_engine_inner(&registry, &engine_id);
                return Err(format!(
                    "Engine '{}' could not load the model: {error}",
                    info.engine_id
                ));
            }
            Ok(false) => {}
        }
        stop_engine_inner(&registry, &engine_id);
        return Err(format!(
            "Engine '{}' was registered but is no longer responding — process cleaned up",
            info.engine_id
        ));
    }

    // Measure footprint then admit atomically. Estimation failure is fail-closed
    // (`ENGINE_FOOTPRINT_UNKNOWN`) — never coerce unknown size to 0 and admit.
    // Memory-snapshot failure is likewise fail-closed (`ENGINE_MEMORY_UNAVAILABLE`)
    // and never reaches spawn. A genuinely measured zero may still be admitted
    // (contributes 0). The reservation stays held through cold load until
    // readiness succeeds (released exactly once below) or any failing exit path
    // drops the guard. The TS-side budget check remains an advisory UX fast-path.
    let (footprint, reservation) =
        admit_estimated_footprint(&registry, &model_path, args.format, &engine_id)?;

    let port = pick_free_port()?;
    let mut cmd = Command::new(&bin);
    apply_engine_env_allowlist(&mut cmd, &bin);
    cmd.arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string());
    match args.format {
        EngineFormat::Gguf => {
            cmd.arg("--timeout").arg("300").arg("-m").arg(&model_path);
        }
        EngineFormat::Mlx => {
            cmd.arg("--model").arg(&model_path);
        }
    }
    // Engine stdout/stderr → a per-engine rotating log so a crash (bad model,
    // OOM, wrong arch) leaves a diagnostic instead of vanishing into null.
    let (engine_out, engine_err) = engine_log_targets(&app, &engine_id);
    cmd.stdin(Stdio::null())
        .stdout(engine_out)
        .stderr(engine_err);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    #[cfg(windows)]
    let job = WindowsJob::new()?;

    let child = cmd
        .spawn()
        .map_err(|e| format!("Cannot start the bundled engine: {e}"))?;
    #[cfg(windows)]
    let child = {
        let mut child = child;
        if let Err(error) = job.assign_child(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        child
    };
    #[cfg(unix)]
    let pgid = child.id() as i32;

    let info = EngineInfo {
        engine_id: engine_id.clone(),
        format: args.format,
        model_path: model_path_string,
        port,
        footprint_bytes: footprint,
        engine_label,
    };

    // Wave 4 commit A: we no longer call `stop_all` here. Multiple engines for
    // distinct models can co-exist; admit/deny is the caller's job using
    // `engine_resource_budget` + `engine_estimate_footprint`.
    let running = RunningEngine {
        info: info.clone(),
        child,
        #[cfg(unix)]
        pgid,
        #[cfg(windows)]
        job,
    };
    match register_running_engine(&registry, engine_id.clone(), running)? {
        RegisterEngineResult::Inserted => {
            // Keep the reservation through cold load. OS available may not yet
            // reflect pages still on disk; the reservation protects concurrent
            // starts until readiness succeeds and we release it exactly once.
        }
        RegisterEngineResult::Duplicate { existing, rejected } => {
            terminate_running_engine(*rejected);
            // Our spawn lost the race — free our reservation immediately so it
            // cannot block siblings while we wait on the winner.
            drop(reservation);
            // The existing engine won the race; it may still be on its cold
            // load, so give it the full ceiling — but the try_wait fast-fail
            // inside wait_engine_ready bails early if it has already died.
            match wait_engine_ready(
                &registry,
                &engine_id,
                existing.port,
                Duration::from_secs(180),
            )
            .await
            {
                Ok(true) => return Ok(existing),
                Err(error) => {
                    stop_engine_inner(&registry, &engine_id);
                    return Err(format!(
                        "Engine '{}' could not load the model: {error}",
                        existing.engine_id
                    ));
                }
                Ok(false) => {}
            }
            stop_engine_inner(&registry, &engine_id);
            return Err(format!(
                "Engine '{}' did not become ready within 180s — process cleaned up",
                existing.engine_id
            ));
        }
    }

    // Cold-disk load of a multi-GB GGUF / MLX model can take well over 30s on
    // first run; the loop polls every 400ms so a ready engine still returns
    // promptly — the long ceiling only bounds a genuinely stuck spawn. The
    // try_wait fast-fail inside wait_engine_ready means a process that dies on
    // startup (bad model, OOM, wrong arch) fails in <1s, not after 180s.
    match wait_engine_ready(&registry, &engine_id, port, Duration::from_secs(180)).await {
        Ok(true) => {
            // Ready and resident — OS available now reflects usage; release the
            // cold-load reservation exactly once. Failure paths rely on Drop.
            drop(reservation);
            return Ok(info);
        }
        Err(error) => {
            stop_engine_inner(&registry, &engine_id);
            return Err(format!(
                "Engine '{engine_id}' could not load the model: {error}"
            ));
        }
        Ok(false) => {}
    }
    // stop_engine_inner polls + waits, so on return the child is reaped and
    // the registry slot is free — no zombie lingers. Reservation frees on Drop.
    stop_engine_inner(&registry, &engine_id);
    Err(format!(
        "Engine '{engine_id}' did not become ready within 180s — process cleaned up"
    ))
}

#[tauri::command]
pub fn engine_stop(
    engine_id: String,
    registry: tauri::State<EngineRegistry>,
) -> Result<(), String> {
    stop_engine_inner(&registry, &engine_id);
    Ok(())
}

#[tauri::command]
pub fn engine_status(registry: tauri::State<EngineRegistry>) -> Vec<EngineInfo> {
    registry
        .0
        .lock()
        .map(|mut m| {
            prune_exited_engines(&mut m);
            m.values().map(|e| e.info.clone()).collect()
        })
        .unwrap_or_default()
}

/// Stop every running engine whose `model_path` matches the given path. Used
/// when the caller has *explicit* "replace this model" intent (e.g. the
/// LocalModelsPanel "Restart" button); never called from `engine_start`.
#[tauri::command]
pub fn stop_others_for_path(
    model_path: String,
    registry: tauri::State<EngineRegistry>,
) -> Result<u32, String> {
    let model_path = normalize_engine_model_path_for_match(&model_path)?;
    let ids: Vec<String> = registry
        .0
        .lock()
        .map(|mut m| {
            prune_exited_engines(&mut m);
            m.values()
                .filter(|e| e.info.model_path == model_path)
                .map(|e| e.info.engine_id.clone())
                .collect()
        })
        .unwrap_or_default();
    let count = ids.len() as u32;
    for id in ids {
        stop_engine_inner(&registry, &id);
    }
    Ok(count)
}

#[tauri::command]
pub fn engine_estimate_footprint(
    model_path: String,
    format: EngineFormat,
) -> Result<EngineFootprint, String> {
    let model_path = validate_engine_model_path(Path::new(&model_path), format)?;
    estimate_footprint_inner(&model_path, format)
}

#[tauri::command]
pub fn engine_resource_budget(
    registry: tauri::State<EngineRegistry>,
) -> Result<EngineBudget, String> {
    let memory =
        crate::system_memory().map_err(|reason| engine_memory_unavailable_error(&reason))?;
    let running: Vec<RunningEngineSummary> = registry
        .0
        .lock()
        .map(|mut m| {
            prune_exited_engines(&mut m);
            m.values()
                .map(|e| RunningEngineSummary {
                    engine_id: e.info.engine_id.clone(),
                    model_path: e.info.model_path.clone(),
                    footprint_bytes: e.info.footprint_bytes,
                })
                .collect()
        })
        .unwrap_or_default();

    // Count in-flight reservations (admitted / cold-loading) so a poll mid-load
    // reflects the pending commitment. Do not subtract running footprints —
    // OS available already includes their resident usage. saturating_add on the
    // reservation sum (and saturating_sub below) keeps the math honest on an
    // over-committed or adversarially large box (never panic / wrap-around).
    let reserved_sum: u64 = registry.1.lock().map(|r| r.reserved_sum()).unwrap_or(0);
    let headroom = host_headroom_bytes(memory.total_bytes);
    let available = budget_available_bytes(memory.available_bytes, headroom, reserved_sum);

    Ok(EngineBudget {
        total_ram_bytes: memory.total_bytes,
        available_ram_bytes: available,
        reserved_for_os_bytes: headroom,
        running,
    })
}

/// Return the tail of an engine's stdout/stderr log so the UI can surface a
/// crashed-engine diagnostic. Bounded so a renderer can't pull an unbounded blob.
#[tauri::command]
pub fn engine_log_tail(
    app: tauri::AppHandle,
    engine_id: String,
    max_bytes: Option<u64>,
) -> Result<String, String> {
    let dir = engine_log_dir(&app)?;
    let path = engine_log_path(&dir, &engine_id);
    // Defense-in-depth: the file name is a sha256 hex so it cannot traverse, but
    // confirm the resolved path stays directly under the engines log dir.
    if path.parent() != Some(dir.as_path()) {
        return Err("Invalid engine log path".to_string());
    }
    read_log_tail(&path, max_bytes.unwrap_or(MAX_ENGINE_LOG_TAIL_BYTES))
}
