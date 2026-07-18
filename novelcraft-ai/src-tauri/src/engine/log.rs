//! Per-engine stdout/stderr logging: a sha256-named file per engine_id with
//! single-generation rotation and a bounded tail reader for the UI.

use crate::inkmarshal_home;
use std::path::{Path, PathBuf};
use std::process::Stdio;

/// Per-engine stdout/stderr log cap; exceeding it rotates to a single `.log.1`
/// generation, bounding disk to ~2× this per engine with no background rotator.
pub(super) const MAX_ENGINE_LOG_BYTES: u64 = 2 * 1024 * 1024;

/// Default number of trailing bytes `engine_log_tail` returns to the UI.
pub(super) const MAX_ENGINE_LOG_TAIL_BYTES: u64 = 64 * 1024;

/// Directory holding per-engine stdout/stderr logs under `~/.inkmarshal/app/logs`.
pub(super) fn engine_log_dir(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = inkmarshal_home::inkmarshal_log_dir()
        .map_err(|e| format!("Cannot resolve engine log dir: {e}"))?;
    Ok(base.join("engines"))
}

/// Per-engine log file name: the sha256 hex of the engine_id (fixed length,
/// filesystem-safe, no traversal) since engine_ids contain ':' '/' and arbitrary
/// model-path bytes. Deterministic, so `engine_log_tail` re-derives the same path.
pub(super) fn engine_log_file_name(engine_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(engine_id.as_bytes());
    format!("{:x}.log", hasher.finalize())
}

pub(super) fn engine_log_path(dir: &Path, engine_id: &str) -> PathBuf {
    dir.join(engine_log_file_name(engine_id))
}

/// Single-generation rotation: if the log exceeds the cap, rename it to
/// `<name>.log.1` (overwriting any prior `.1`) before the next append.
pub(super) fn rotate_engine_log_if_large(path: &Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_ENGINE_LOG_BYTES {
            let _ = std::fs::rename(path, path.with_extension("log.1"));
        }
    }
}

/// Open (create+append, O_NOFOLLOW) the engine's log for stdout AND stderr —
/// the same file so ordering is preserved. Falls back to null on any error:
/// logging must never fail the spawn.
pub(super) fn engine_log_targets(app: &tauri::AppHandle, engine_id: &str) -> (Stdio, Stdio) {
    let Ok(dir) = engine_log_dir(app) else {
        return (Stdio::null(), Stdio::null());
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = engine_log_path(&dir, engine_id);
    rotate_engine_log_if_large(&path);
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    match options.open(&path) {
        Ok(file) => match file.try_clone() {
            Ok(clone) => (Stdio::from(file), Stdio::from(clone)),
            Err(_) => (Stdio::from(file), Stdio::null()),
        },
        Err(_) => (Stdio::null(), Stdio::null()),
    }
}

/// Read the last `max_bytes` (capped at MAX_ENGINE_LOG_BYTES) of a log file, or
/// empty if it doesn't exist yet. Pure helper so it's unit-testable without an
/// AppHandle.
pub(super) fn read_log_tail(path: &Path, max_bytes: u64) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Ok(String::new()),
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let want = max_bytes.min(MAX_ENGINE_LOG_BYTES);
    let start = len.saturating_sub(want);
    if start > 0 {
        file.seek(SeekFrom::Start(start))
            .map_err(|e| format!("Cannot seek engine log: {e}"))?;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|e| format!("Cannot read engine log: {e}"))?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}
