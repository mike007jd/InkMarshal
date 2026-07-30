//! Opaque manuscript import staging.
//!
//! The native picker copies a user-chosen txt/md/docx into
//! `inkmarshal_app_dir()/import-sessions/{token}/` and returns only an
//! unguessable token plus the basename. Absolute paths and file bytes never
//! cross the IPC boundary for this flow.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use rand::RngCore;

use crate::inkmarshal_home;

/// Hard cap shared with the Node import pipeline (25 MiB).
pub(crate) const MAX_MANUSCRIPT_IMPORT_BYTES: u64 = 25 * 1024 * 1024;

/// Sessions older than this are removed on a best-effort sweep.
pub(crate) const IMPORT_SESSION_TTL: Duration = Duration::from_secs(24 * 60 * 60);

const IMPORT_SESSIONS_DIR: &str = "import-sessions";
const STAGED_SOURCE_NAME: &str = "source";
const ALLOWED_EXTENSIONS: &[&str] = &["txt", "md", "docx"];

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StagedManuscriptImport {
    token: String,
    basename: String,
}

/// Stage a user-picked manuscript under the app-owned import-sessions tree.
///
/// Returns `Ok(None)` when the user dismisses the dialog.
#[tauri::command]
pub(crate) async fn stage_manuscript_import(
    app: tauri::AppHandle,
) -> Result<Option<StagedManuscriptImport>, String> {
    use tauri_plugin_dialog::DialogExt;

    let mut builder = app.dialog().file();
    builder = builder.add_filter("Manuscript", ALLOWED_EXTENSIONS);
    let Some(picked) = builder.blocking_pick_file() else {
        return Ok(None);
    };

    let path_buf = picked
        .into_path()
        .map_err(|err| format!("Cannot resolve the chosen file path: {err}"))?;

    stage_manuscript_at_path(&path_buf)
}

/// Testable core of staging: validate, copy, cleanup. Does not open a dialog.
pub(crate) fn stage_manuscript_at_path(
    path_buf: &Path,
) -> Result<Option<StagedManuscriptImport>, String> {
    let ext = path_buf
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or_else(|| "The chosen file type is not allowed".to_string())?;
    if !ALLOWED_EXTENSIONS
        .iter()
        .any(|a| a.eq_ignore_ascii_case(&ext))
    {
        return Err("The chosen file type is not allowed".to_string());
    }

    let meta = fs::metadata(path_buf).map_err(|err| format!("Cannot read file info: {err}"))?;
    if !meta.is_file() {
        return Err("The chosen path is not a file".to_string());
    }
    if meta.len() == 0 {
        return Err("The selected file is empty.".to_string());
    }
    if meta.len() > MAX_MANUSCRIPT_IMPORT_BYTES {
        return Err(format!(
            "The selected file is too large to import (max {} bytes).",
            MAX_MANUSCRIPT_IMPORT_BYTES
        ));
    }

    let basename = sanitize_basename(
        path_buf
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("manuscript"),
        &ext,
    )?;

    let sessions_root = import_sessions_root()?;
    fs::create_dir_all(&sessions_root)
        .map_err(|err| format!("Cannot create import session directory: {err}"))?;
    cleanup_expired_import_sessions(&sessions_root, IMPORT_SESSION_TTL, SystemTime::now());

    let token = generate_import_token();
    let session_dir = sessions_root.join(&token);
    ensure_path_inside(&sessions_root, &session_dir)?;
    fs::create_dir_all(&session_dir)
        .map_err(|err| format!("Cannot create import session: {err}"))?;

    let staged_name = format!("{STAGED_SOURCE_NAME}.{ext}");
    let dest = session_dir.join(&staged_name);
    ensure_path_inside(&session_dir, &dest)?;

    // Copy (not move) so a mid-flight failure never deletes the user's original.
    fs::copy(path_buf, &dest).map_err(|err| format!("Cannot stage manuscript: {err}"))?;

    // Re-check size after copy to close a TOCTOU window on the source path.
    let staged_meta =
        fs::metadata(&dest).map_err(|err| format!("Cannot verify staged manuscript: {err}"))?;
    if staged_meta.len() > MAX_MANUSCRIPT_IMPORT_BYTES {
        let _ = fs::remove_dir_all(&session_dir);
        return Err(format!(
            "The selected file is too large to import (max {} bytes).",
            MAX_MANUSCRIPT_IMPORT_BYTES
        ));
    }

    // Persist basename beside the staged bytes so Node never needs the original path.
    let meta_path = session_dir.join("staged.json");
    ensure_path_inside(&session_dir, &meta_path)?;
    let meta_json = serde_json::json!({
        "basename": basename,
        "stagedName": staged_name,
        "createdAtUnix": unix_now_secs(),
    });
    fs::write(
        &meta_path,
        serde_json::to_vec(&meta_json)
            .map_err(|err| format!("Cannot write stage metadata: {err}"))?,
    )
    .map_err(|err| format!("Cannot write stage metadata: {err}"))?;

    Ok(Some(StagedManuscriptImport { token, basename }))
}

pub(crate) fn import_sessions_root() -> Result<PathBuf, String> {
    Ok(inkmarshal_home::inkmarshal_app_dir()?.join(IMPORT_SESSIONS_DIR))
}

pub(crate) fn generate_import_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    to_hex(&bytes)
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0xf) as usize] as char);
    }
    out
}

pub(crate) fn sanitize_basename(raw: &str, ext: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(format!("manuscript.{ext}"));
    }
    let name = Path::new(trimmed)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("manuscript");
    // Strip path separators and NULs that could confuse downstream joins.
    let safe: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | '\0' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let safe = safe.trim().trim_start_matches('.');
    if safe.is_empty() {
        return Ok(format!("manuscript.{ext}"));
    }
    // Cap length so a hostile filename cannot bloat session metadata.
    if safe.len() > 180 {
        let stem: String = safe.chars().take(160).collect();
        return Ok(format!("{stem}.{ext}"));
    }
    Ok(safe.to_string())
}

pub(crate) fn ensure_path_inside(root: &Path, candidate: &Path) -> Result<(), String> {
    let root_canon = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    // candidate may not exist yet — canonicalize parent + join file name.
    let candidate_canon = if candidate.exists() {
        fs::canonicalize(candidate).map_err(|err| format!("Cannot resolve path: {err}"))?
    } else {
        let parent = candidate
            .parent()
            .ok_or_else(|| "Invalid import session path".to_string())?;
        let parent_canon = if parent.exists() {
            fs::canonicalize(parent).map_err(|err| format!("Cannot resolve path: {err}"))?
        } else {
            parent.to_path_buf()
        };
        parent_canon.join(
            candidate
                .file_name()
                .ok_or_else(|| "Invalid import session path".to_string())?,
        )
    };
    if !candidate_canon.starts_with(&root_canon) {
        return Err("Import session path escapes the owned directory".to_string());
    }
    Ok(())
}

pub(crate) fn cleanup_expired_import_sessions(root: &Path, ttl: Duration, now: SystemTime) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // Prefer staged.json createdAtUnix when present so tests (and hosts
        // without reliable birthtime) can still expire sessions.
        let age_exceeded = if let Ok(raw) = fs::read_to_string(path.join("staged.json")) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(created) = v.get("createdAtUnix").and_then(|x| x.as_u64()) {
                    let created_time = SystemTime::UNIX_EPOCH + Duration::from_secs(created);
                    now.duration_since(created_time)
                        .map(|age| age > ttl)
                        .unwrap_or(true)
                } else {
                    false
                }
            } else {
                false
            }
        } else {
            let created = fs::metadata(&path)
                .and_then(|m| m.created().or_else(|_| m.modified()))
                .ok();
            match created {
                Some(created) => now
                    .duration_since(created)
                    .map(|age| age > ttl)
                    .unwrap_or(false),
                None => false,
            }
        };
        if age_exceeded {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Mutex;

    // Serialise env mutations across tests in this module.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_home<F, T>(f: F) -> T
    where
        F: FnOnce(&Path) -> T,
    {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut bytes = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut bytes);
        let home = std::env::temp_dir().join(format!("im-import-{}", to_hex(&bytes)));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join("app")).expect("app dir");
        std::env::set_var("INKMARSHAL_HOME", &home);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&home)));
        std::env::remove_var("INKMARSHAL_HOME");
        let _ = fs::remove_dir_all(&home);
        match result {
            Ok(v) => v,
            Err(payload) => std::panic::resume_unwind(payload),
        }
    }

    #[test]
    fn token_is_high_entropy_hex() {
        let a = generate_import_token();
        let b = generate_import_token();
        assert_eq!(a.len(), 64);
        assert_eq!(b.len(), 64);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn sanitize_basename_strips_path_parts_and_controls() {
        assert_eq!(
            sanitize_basename("../../evil\ntitle.docx", "docx").unwrap(),
            "evil_title.docx"
        );
        assert_eq!(sanitize_basename("", "txt").unwrap(), "manuscript.txt");
    }

    #[test]
    fn path_containment_rejects_escape() {
        let mut bytes = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut bytes);
        let root = std::env::temp_dir().join(format!("im-root-{}", to_hex(&bytes)));
        let escape = std::env::temp_dir().join(format!("im-out-{}", to_hex(&bytes)));
        fs::create_dir_all(&root).unwrap();
        let err = ensure_path_inside(&root, &escape).unwrap_err();
        assert!(err.contains("escapes"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn staging_copies_under_token_and_returns_basename_only() {
        with_temp_home(|home| {
            let src_dir = home.join("picked");
            fs::create_dir_all(&src_dir).unwrap();
            let src = src_dir.join("My Draft.md");
            {
                let mut f = fs::File::create(&src).unwrap();
                write!(f, "# Chapter 1\n\nHello world.\n").unwrap();
            }

            let staged = stage_manuscript_at_path(&src).unwrap().unwrap();
            assert_eq!(staged.basename, "My Draft.md");
            assert_eq!(staged.token.len(), 64);
            assert!(!staged.token.contains('/'));

            let session_dir = home.join("app").join("import-sessions").join(&staged.token);
            assert!(session_dir.join("source.md").is_file());
            assert!(session_dir.join("staged.json").is_file());
            let meta = fs::read_to_string(session_dir.join("staged.json")).unwrap();
            assert!(!meta.contains(src.to_string_lossy().as_ref()));
        });
    }

    #[test]
    fn staging_rejects_oversized_and_disallowed_extensions() {
        with_temp_home(|home| {
            let src_dir = home.join("picked");
            fs::create_dir_all(&src_dir).unwrap();

            let bad_ext = src_dir.join("notes.pdf");
            fs::write(&bad_ext, b"%PDF").unwrap();
            assert!(stage_manuscript_at_path(&bad_ext)
                .unwrap_err()
                .contains("not allowed"));

            let big = src_dir.join("huge.txt");
            let f = fs::File::create(&big).unwrap();
            f.set_len(MAX_MANUSCRIPT_IMPORT_BYTES + 1).unwrap();
            assert!(stage_manuscript_at_path(&big)
                .unwrap_err()
                .to_lowercase()
                .contains("too large"));
        });
    }

    #[test]
    fn cleanup_removes_expired_session_dirs() {
        let mut bytes = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut bytes);
        let root = std::env::temp_dir().join(format!("im-clean-{}", to_hex(&bytes)));
        let old = root.join("oldtoken");
        let fresh = root.join("freshtoken");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&fresh).unwrap();
        fs::write(
            old.join("staged.json"),
            r#"{"basename":"a.txt","stagedName":"source.txt","createdAtUnix":1}"#,
        )
        .unwrap();
        fs::write(
            fresh.join("staged.json"),
            format!(
                r#"{{"basename":"b.txt","stagedName":"source.txt","createdAtUnix":{}}}"#,
                unix_now_secs()
            ),
        )
        .unwrap();

        cleanup_expired_import_sessions(&root, Duration::from_secs(60), SystemTime::now());
        assert!(!old.exists());
        assert!(fresh.exists());
        let _ = fs::remove_dir_all(&root);
    }
}
