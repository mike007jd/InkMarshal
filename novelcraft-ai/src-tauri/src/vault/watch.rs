//! Per-novel filesystem watcher with a 500ms debounce thread that emits
//! `vault://changed` events for the TS layer to react to.

use super::path::{to_posix_relative, vault_root};
use super::VaultChangedEvent;
use notify::{
    event::{ModifyKind, RenameMode},
    EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// One running watcher per novel_id. We don't share a single global watcher
/// because different novels may live on different filesystems with different
/// reliability characteristics (one on local SSD, one on Seafile).
#[derive(Default)]
pub struct VaultWatchers {
    inner: Arc<Mutex<HashMap<String, RunningVaultWatcher>>>,
}

struct RunningVaultWatcher {
    root: PathBuf,
    watch_id: Option<String>,
    _watcher: RecommendedWatcher,
    alive: Arc<AtomicBool>,
    _timer: std::thread::JoinHandle<()>,
}

impl RunningVaultWatcher {
    fn new(
        root: PathBuf,
        watch_id: Option<String>,
        watcher: RecommendedWatcher,
        alive: Arc<AtomicBool>,
        timer: std::thread::JoinHandle<()>,
    ) -> Self {
        Self {
            root,
            watch_id,
            _watcher: watcher,
            alive,
            _timer: timer,
        }
    }
}

impl Drop for RunningVaultWatcher {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone)]
struct DebounceState {
    paths: Vec<String>,
    kind: String,
    deadline: Instant,
}

impl DebounceState {
    fn merge(&mut self, paths: Vec<String>, kind: String) {
        for p in paths {
            if !self.paths.contains(&p) {
                self.paths.push(p);
            }
        }
        // Coarsen: any non-modify wins over modify, since rename/remove forces
        // a full walk on the TS side anyway.
        if self.kind == "modify" && kind != "modify" {
            self.kind = kind;
        }
    }
}

#[tauri::command]
pub fn vault_watch_start(
    app: tauri::AppHandle,
    novel_id: String,
    vault_path: String,
    watch_id: Option<String>,
    watchers: tauri::State<VaultWatchers>,
) -> Result<(), String> {
    let root = vault_root(&vault_path)?;

    {
        let map = watchers
            .inner
            .lock()
            .map_err(|_| "watcher registry poisoned".to_string())?;
        if map
            .get(&novel_id)
            .map(|watcher| same_watch_generation(watcher, &root, watch_id.as_deref()))
            .unwrap_or(false)
        {
            return Ok(()); // Idempotent: already watching this novel.
        }
    }

    let pending: Arc<Mutex<Option<DebounceState>>> = Arc::new(Mutex::new(None));
    let pending_for_handler = Arc::clone(&pending);
    let pending_for_timer = Arc::clone(&pending);
    let alive = Arc::new(AtomicBool::new(true));
    let alive_for_handler = Arc::clone(&alive);
    let alive_for_timer = Arc::clone(&alive);
    let root_for_handler = root.clone();
    let novel_id_for_handler = novel_id.clone();
    let novel_id_for_timer = novel_id.clone();
    let app_for_timer = app.clone();

    // Background thread to flush the debounced buffer every ~500 ms. Using a
    // dedicated thread instead of notify's internal debouncer because notify
    // v6's `Debouncer` API surface differs across cargo-resolved minors and
    // we want a stable contract for the event payload.
    let timer = std::thread::spawn(move || loop {
        if !alive_for_timer.load(Ordering::Acquire) {
            return;
        }
        std::thread::sleep(Duration::from_millis(150));
        if !alive_for_timer.load(Ordering::Acquire) {
            return;
        }
        let to_emit = {
            let mut guard = match pending_for_timer.lock() {
                Ok(g) => g,
                Err(_) => return, // Poisoned — give up; watcher will be replaced.
            };
            match guard.as_ref() {
                Some(state) if Instant::now() >= state.deadline => guard.take(),
                _ => None,
            }
        };
        if let Some(state) = to_emit {
            if !alive_for_timer.load(Ordering::Acquire) {
                return;
            }
            let payload = VaultChangedEvent {
                novel_id: novel_id_for_timer.clone(),
                paths: state.paths,
                kind: state.kind,
            };
            // Best-effort emit; if no listener is attached the result is Ok
            // anyway, so an error here is genuinely something we should log.
            if let Err(err) = app_for_timer.emit("vault://changed", payload) {
                log::warn!("vault://changed emit failed: {err}");
            }
        }
    });

    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if !alive_for_handler.load(Ordering::Acquire) {
                return;
            }
            let event = match res {
                Ok(e) => e,
                Err(err) => {
                    log::warn!("vault watcher error: {err}");
                    return;
                }
            };
            let kind = classify_kind(&event.kind);
            let mut paths: Vec<String> = Vec::new();
            for p in &event.paths {
                if let Some(rel) = to_posix_relative(&root_for_handler, p) {
                    if !rel.is_empty() {
                        paths.push(rel);
                    }
                }
            }
            if paths.is_empty() {
                return;
            }
            // Push into the debounce buffer; the timer thread flushes.
            if let Ok(mut guard) = pending_for_handler.lock() {
                if !alive_for_handler.load(Ordering::Acquire) {
                    return;
                }
                let deadline = Instant::now() + Duration::from_millis(500);
                if let Some(state) = guard.as_mut() {
                    state.merge(paths, kind);
                    state.deadline = deadline;
                } else {
                    *guard = Some(DebounceState {
                        paths,
                        kind,
                        deadline,
                    });
                }
            }
            // Suppress unused warning for novel_id_for_handler in builds where
            // log level filters out the warn macro entirely.
            let _ = &novel_id_for_handler;
        })
        .map_err(|e| format!("Cannot create vault watcher: {e}"))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("Cannot start watching '{}': {e}", root.display()))?;

    let mut map = watchers
        .inner
        .lock()
        .map_err(|_| "watcher registry poisoned".to_string())?;
    map.insert(
        novel_id,
        RunningVaultWatcher::new(root, watch_id, watcher, alive, timer),
    );
    Ok(())
}

#[tauri::command]
pub fn vault_watch_stop(
    novel_id: String,
    vault_path: Option<String>,
    watch_id: Option<String>,
    watchers: tauri::State<VaultWatchers>,
) -> Result<(), String> {
    let requested_root = vault_path.as_deref().map(vault_root).transpose()?;
    let mut map = watchers
        .inner
        .lock()
        .map_err(|_| "watcher registry poisoned".to_string())?;
    // Dropping the registry entry stops both the OS watch handle and the
    // debounce timer thread owned by `RunningVaultWatcher`.
    if requested_root
        .as_ref()
        .map(|root| {
            map.get(&novel_id)
                .map(|watcher| same_watch_generation(watcher, root, watch_id.as_deref()))
                .unwrap_or(false)
        })
        .unwrap_or(true)
    {
        map.remove(&novel_id);
    }
    Ok(())
}

fn same_watch_root(existing: &Path, requested: &Path) -> bool {
    existing == requested
}

fn same_watch_id(existing: Option<&str>, requested: Option<&str>) -> bool {
    requested.map(|id| existing == Some(id)).unwrap_or(true)
}

fn same_watch_generation(
    existing: &RunningVaultWatcher,
    requested_root: &Path,
    requested_watch_id: Option<&str>,
) -> bool {
    same_watch_generation_parts(
        &existing.root,
        existing.watch_id.as_deref(),
        requested_root,
        requested_watch_id,
    )
}

pub(super) fn same_watch_generation_parts(
    existing_root: &Path,
    existing_watch_id: Option<&str>,
    requested_root: &Path,
    requested_watch_id: Option<&str>,
) -> bool {
    same_watch_root(existing_root, requested_root)
        && same_watch_id(existing_watch_id, requested_watch_id)
}

fn classify_kind(kind: &EventKind) -> String {
    match kind {
        EventKind::Create(_) => "create".to_string(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => "rename".to_string(),
        EventKind::Modify(ModifyKind::Name(_)) => "rename".to_string(),
        EventKind::Modify(_) => "modify".to_string(),
        EventKind::Remove(_) => "remove".to_string(),
        _ => "other".to_string(),
    }
}

/// Stop every watcher — invoked at shutdown so OS watch handles are released.
pub fn stop_all_watchers(state: &VaultWatchers) {
    if let Ok(mut map) = state.inner.lock() {
        map.clear();
    }
}
