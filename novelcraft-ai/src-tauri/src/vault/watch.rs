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
    watch_generation: Option<u64>,
    _watcher: RecommendedWatcher,
    alive: Arc<AtomicBool>,
    _timer: std::thread::JoinHandle<()>,
}

impl RunningVaultWatcher {
    fn new(
        root: PathBuf,
        watch_id: Option<String>,
        watch_generation: Option<u64>,
        watcher: RecommendedWatcher,
        alive: Arc<AtomicBool>,
        timer: std::thread::JoinHandle<()>,
    ) -> Self {
        Self {
            root,
            watch_id,
            watch_generation,
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
    /// Per-path kind — never coarsen unrelated paths into one kind.
    path_kinds: HashMap<String, String>,
    deadline: Instant,
}

/// Kind rank for per-path coalescing inside one debounce window.
/// Higher wins. `remove` outranks `rename` so a path that ends deleted is
/// emitted as remove; `modify` is weakest so create/rename/remove replace it.
fn kind_rank(kind: &str) -> u8 {
    match kind {
        "modify" => 1,
        "other" => 2,
        "create" => 3,
        "rename" => 4,
        "remove" => 5,
        _ => 0,
    }
}

fn coalesce_path_kind(existing: &str, incoming: &str) -> String {
    if kind_rank(incoming) >= kind_rank(existing) {
        incoming.to_string()
    } else {
        existing.to_string()
    }
}

impl DebounceState {
    fn merge_paths(&mut self, paths: Vec<String>, kind: String) {
        for path in paths {
            match self.path_kinds.get(&path) {
                Some(existing) => {
                    let next = coalesce_path_kind(existing, &kind);
                    self.path_kinds.insert(path, next);
                }
                None => {
                    self.path_kinds.insert(path, kind.clone());
                }
            }
        }
    }
}

/// Deterministic kind order for emitting one event per kind group.
const KIND_EMIT_ORDER: [&str; 5] = ["create", "modify", "rename", "remove", "other"];

/// Group path→kind into sorted kind buckets with sorted paths.
pub(super) fn group_paths_by_kind(
    path_kinds: &HashMap<String, String>,
) -> Vec<(String, Vec<String>)> {
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for (path, kind) in path_kinds {
        groups.entry(kind.clone()).or_default().push(path.clone());
    }
    let mut out = Vec::new();
    for kind in KIND_EMIT_ORDER {
        if let Some(mut paths) = groups.remove(kind) {
            paths.sort();
            out.push((kind.to_string(), paths));
        }
    }
    // Any unexpected kind strings — emit deterministically after known ones.
    let mut rest: Vec<_> = groups.into_iter().collect();
    rest.sort_by(|a, b| a.0.cmp(&b.0));
    for (kind, mut paths) in rest {
        paths.sort();
        out.push((kind, paths));
    }
    out
}

#[tauri::command]
pub fn vault_watch_start(
    app: tauri::AppHandle,
    novel_id: String,
    vault_path: String,
    watch_id: Option<String>,
    watch_generation: Option<u64>,
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
            .map(|watcher| {
                same_watch_generation(watcher, &root, watch_id.as_deref(), watch_generation)
            })
            .unwrap_or(false)
        {
            return Ok(()); // Idempotent: already watching this novel.
        }
        if map
            .get(&novel_id)
            .map(|watcher| generation_is_stale(watcher.watch_generation, watch_generation))
            .unwrap_or(false)
        {
            return Ok(()); // A newer start already owns this novel.
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
    let watch_id_for_timer = watch_id.clone();
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
            for (kind, paths) in group_paths_by_kind(&state.path_kinds) {
                if !alive_for_timer.load(Ordering::Acquire) {
                    return;
                }
                let payload = VaultChangedEvent {
                    novel_id: novel_id_for_timer.clone(),
                    paths,
                    kind,
                    watch_id: watch_id_for_timer.clone(),
                };
                // Best-effort emit; if no listener is attached the result is Ok
                // anyway, so an error here is genuinely something we should log.
                if let Err(err) = app_for_timer.emit("vault://changed", payload) {
                    log::warn!("vault://changed emit failed: {err}");
                }
            }
        }
    });

    let mut watcher: RecommendedWatcher =
        match notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
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
                    state.merge_paths(paths, kind);
                    state.deadline = deadline;
                } else {
                    let mut path_kinds = HashMap::new();
                    for path in paths {
                        path_kinds.insert(path, kind.clone());
                    }
                    *guard = Some(DebounceState {
                        path_kinds,
                        deadline,
                    });
                }
            }
            // Suppress unused warning for novel_id_for_handler in builds where
            // log level filters out the warn macro entirely.
            let _ = &novel_id_for_handler;
        }) {
            Ok(watcher) => watcher,
            Err(error) => {
                alive.store(false, Ordering::Release);
                return Err(format!("Cannot create vault watcher: {error}"));
            }
        };

    if let Err(error) = watcher.watch(&root, RecursiveMode::Recursive) {
        alive.store(false, Ordering::Release);
        return Err(format!(
            "Cannot start watching '{}': {error}",
            root.display()
        ));
    }

    let mut map = match watchers.inner.lock() {
        Ok(map) => map,
        Err(_) => {
            alive.store(false, Ordering::Release);
            return Err("watcher registry poisoned".to_string());
        }
    };
    // Compare-and-swap at commit time: construction happens outside the lock,
    // so an older slow start must never overwrite a newer watcher that finished
    // first. Dropping this local generation also stops its debounce timer.
    if map
        .get(&novel_id)
        .map(|existing| generation_is_stale(existing.watch_generation, watch_generation))
        .unwrap_or(false)
    {
        alive.store(false, Ordering::Release);
        return Ok(());
    }
    if map
        .get(&novel_id)
        .map(|existing| {
            same_watch_generation(existing, &root, watch_id.as_deref(), watch_generation)
        })
        .unwrap_or(false)
    {
        alive.store(false, Ordering::Release);
        return Ok(());
    }
    map.insert(
        novel_id,
        RunningVaultWatcher::new(root, watch_id, watch_generation, watcher, alive, timer),
    );
    Ok(())
}

#[tauri::command]
pub fn vault_watch_stop(
    novel_id: String,
    vault_path: Option<String>,
    watch_id: Option<String>,
    watch_generation: Option<u64>,
    watchers: tauri::State<VaultWatchers>,
) -> Result<(), String> {
    let requested_root = match vault_path.as_deref() {
        None => None,
        Some(path) => match vault_root(path) {
            Ok(root) => Some(root),
            Err(_) if watch_id.is_some() && watch_generation.is_some() => {
                // The watched root can disappear when a network volume is
                // unmounted. Exact generation tags are sufficient to stop the
                // matching registry entry without broad-removing another one.
                None
            }
            Err(error) => return Err(error),
        },
    };
    let mut map = watchers
        .inner
        .lock()
        .map_err(|_| "watcher registry poisoned".to_string())?;
    // Dropping the registry entry stops both the OS watch handle and the
    // debounce timer thread owned by `RunningVaultWatcher`.
    let tagged_stop = watch_id.is_some() || watch_generation.is_some();
    let should_remove = map
        .get(&novel_id)
        .map(|watcher| match requested_root.as_ref() {
            Some(root) => {
                same_watch_generation(watcher, root, watch_id.as_deref(), watch_generation)
            }
            None if tagged_stop => same_watch_identity_parts(
                watcher.watch_id.as_deref(),
                watcher.watch_generation,
                watch_id.as_deref(),
                watch_generation,
            ),
            None => true,
        })
        .unwrap_or(false);
    if should_remove {
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

pub(super) fn same_watch_identity_parts(
    existing_watch_id: Option<&str>,
    existing_watch_generation: Option<u64>,
    requested_watch_id: Option<&str>,
    requested_watch_generation: Option<u64>,
) -> bool {
    same_watch_id(existing_watch_id, requested_watch_id)
        && requested_watch_generation
            .map(|generation| existing_watch_generation == Some(generation))
            .unwrap_or(true)
}

fn same_watch_generation(
    existing: &RunningVaultWatcher,
    requested_root: &Path,
    requested_watch_id: Option<&str>,
    requested_watch_generation: Option<u64>,
) -> bool {
    same_watch_generation_parts(
        &existing.root,
        existing.watch_id.as_deref(),
        existing.watch_generation,
        requested_root,
        requested_watch_id,
        requested_watch_generation,
    )
}

pub(super) fn same_watch_generation_parts(
    existing_root: &Path,
    existing_watch_id: Option<&str>,
    existing_watch_generation: Option<u64>,
    requested_root: &Path,
    requested_watch_id: Option<&str>,
    requested_watch_generation: Option<u64>,
) -> bool {
    same_watch_root(existing_root, requested_root)
        && same_watch_identity_parts(
            existing_watch_id,
            existing_watch_generation,
            requested_watch_id,
            requested_watch_generation,
        )
}

pub(super) fn generation_is_stale(
    existing_watch_generation: Option<u64>,
    requested_watch_generation: Option<u64>,
) -> bool {
    match (existing_watch_generation, requested_watch_generation) {
        (Some(existing), Some(requested)) => existing > requested,
        // Once a caller participates in the ordered contract, an untagged
        // legacy start cannot replace it.
        (Some(_), None) => true,
        _ => false,
    }
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

#[cfg(test)]
mod debounce_tests {
    use super::{coalesce_path_kind, group_paths_by_kind};
    use std::collections::HashMap;

    #[test]
    fn per_path_kinds_preserve_modify_when_sibling_is_removed() {
        let mut path_kinds = HashMap::new();
        path_kinds.insert("characters/a.md".into(), "modify".into());
        path_kinds.insert(
            "characters/b.md".into(),
            coalesce_path_kind("modify", "remove"),
        );
        // A stays modify; B is remove.
        assert_eq!(
            path_kinds.get("characters/a.md").map(String::as_str),
            Some("modify")
        );
        assert_eq!(
            path_kinds.get("characters/b.md").map(String::as_str),
            Some("remove")
        );

        let groups = group_paths_by_kind(&path_kinds);
        assert_eq!(
            groups,
            vec![
                ("modify".into(), vec!["characters/a.md".into()]),
                ("remove".into(), vec!["characters/b.md".into()]),
            ]
        );
    }

    #[test]
    fn same_path_remove_wins_over_modify() {
        assert_eq!(coalesce_path_kind("modify", "remove"), "remove");
        assert_eq!(coalesce_path_kind("remove", "modify"), "remove");
        assert_eq!(coalesce_path_kind("modify", "rename"), "rename");
        assert_eq!(coalesce_path_kind("rename", "remove"), "remove");
    }
}
