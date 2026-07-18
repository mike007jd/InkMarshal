//! Path safety, hashing, manifest validation and reachability probing.
//!
//! All helpers here are `pub(super)` so the sibling submodules (io/walk/init/
//! watch/platform) can share them while staying private to the `vault` module.

use super::VaultReachable;
use sha2::{Digest, Sha256};
use std::io::{ErrorKind, Read};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) const VAULT_ENTRY_DIRS: &[&str] =
    &["characters", "worlds", "timeline", "outline", "styles"];

pub(super) const MAX_VAULT_ENTRY_FILE_BYTES: u64 = 128 * 1024;

/// Reject relative paths that escape the vault root via `..` or absolute roots.
/// We never call `canonicalize` on a path that doesn't exist yet (write_file),
/// so the check is purely structural — but it is enough for the trust boundary
/// because the caller (TS) generates rel_path from frontmatter + slug, not from
/// the user's keyboard.
pub(super) fn safe_rel_path(rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("Relative path is empty".to_string());
    }
    let pb = PathBuf::from(rel);
    for c in pb.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => return Err(format!("Path escapes vault: {rel}")),
            Component::Prefix(_) | Component::RootDir => {
                return Err(format!("Path must be relative: {rel}"));
            }
        }
    }
    Ok(pb)
}

pub(super) fn safe_entry_rel_path(rel: &str) -> Result<PathBuf, String> {
    if rel.contains('\\') || rel.chars().any(|ch| ch.is_control()) {
        return Err(format!("Invalid vault entry path: {rel}"));
    }
    let parts: Vec<&str> = rel.split('/').collect();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err(format!("Invalid vault entry path: {rel}"));
    }
    let top = parts.first().copied().unwrap_or_default();
    if parts.len() != 2 || !VAULT_ENTRY_DIRS.contains(&top) || !rel.ends_with(".md") {
        return Err(format!("Vault entry path is not user content: {rel}"));
    }
    safe_rel_path(rel)
}

/// Canonicalize vault_path and return the resolved root for further joins.
/// Vault root must exist — this is intentional, callers must `vault_init`
/// first.
pub(super) fn vault_root(vault_path: &str) -> Result<PathBuf, String> {
    let raw = PathBuf::from(vault_path);
    raw.canonicalize()
        .map_err(|e| format!("Cannot resolve vault path '{vault_path}': {e}"))
}

pub(super) fn canonical_inside_root(root: &Path, abs: &Path) -> Result<PathBuf, String> {
    let resolved = abs
        .canonicalize()
        .map_err(|e| format!("Cannot resolve '{}': {e}", abs.display()))?;
    if !resolved.starts_with(root) {
        return Err(format!("Path escapes vault via symlink: {}", abs.display()));
    }
    Ok(resolved)
}

pub(super) fn ensure_regular_file_inside(root: &Path, abs: &Path) -> Result<PathBuf, String> {
    let link_md = std::fs::symlink_metadata(abs)
        .map_err(|e| format!("Cannot stat '{}': {e}", abs.display()))?;
    if link_md.file_type().is_symlink() {
        return Err(format!(
            "Symlink files are not allowed in vault: {}",
            abs.display()
        ));
    }
    let resolved = canonical_inside_root(root, abs)?;
    let md = std::fs::metadata(&resolved)
        .map_err(|e| format!("Cannot stat '{}': {e}", resolved.display()))?;
    if !md.is_file() {
        return Err(format!(
            "Vault path is not a regular file: {}",
            abs.display()
        ));
    }
    Ok(resolved)
}

pub(super) fn ensure_existing_dir_inside(root: &Path, abs: &Path) -> Result<PathBuf, String> {
    let link_md = std::fs::symlink_metadata(abs)
        .map_err(|e| format!("Cannot stat '{}': {e}", abs.display()))?;
    if link_md.file_type().is_symlink() {
        return Err(format!(
            "Symlink directories are not allowed in vault: {}",
            abs.display()
        ));
    }
    let resolved = canonical_inside_root(root, abs)?;
    let md = std::fs::metadata(&resolved)
        .map_err(|e| format!("Cannot stat '{}': {e}", resolved.display()))?;
    if !md.is_dir() {
        return Err(format!("Vault path is not a directory: {}", abs.display()));
    }
    Ok(resolved)
}

pub(super) fn ensure_parent_dir_inside(root: &Path, rel: &Path) -> Result<PathBuf, String> {
    let parent_rel = rel
        .parent()
        .ok_or_else(|| format!("Cannot determine parent for '{}'", rel.display()))?;
    let mut current = root.to_path_buf();
    for component in parent_rel.components() {
        match component {
            Component::CurDir => continue,
            Component::Normal(part) => current.push(part),
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err(format!("Path escapes vault: {}", rel.display()));
            }
        }

        match std::fs::symlink_metadata(&current) {
            Ok(md) => {
                if md.file_type().is_symlink() {
                    return Err(format!(
                        "Symlink directories are not allowed in vault: {}",
                        current.display()
                    ));
                }
                if !md.is_dir() {
                    return Err(format!(
                        "Vault parent is not a directory: {}",
                        current.display()
                    ));
                }
                canonical_inside_root(root, &current)?;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current)
                    .map_err(|e| format!("Cannot create parent '{}': {e}", current.display()))?;
                canonical_inside_root(root, &current)?;
            }
            Err(err) => {
                return Err(format!("Cannot stat parent '{}': {err}", current.display()));
            }
        }
    }
    Ok(root.join(parent_rel))
}

pub(super) fn ensure_dir_inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = safe_rel_path(rel)?;
    let mut current = root.to_path_buf();
    for component in rel.components() {
        match component {
            Component::CurDir => continue,
            Component::Normal(part) => current.push(part),
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err(format!("Path escapes vault: {}", rel.display()));
            }
        }

        match std::fs::symlink_metadata(&current) {
            Ok(md) => {
                if md.file_type().is_symlink() {
                    return Err(format!(
                        "Symlink directories are not allowed in vault: {}",
                        current.display()
                    ));
                }
                if !md.is_dir() {
                    return Err(format!(
                        "Vault path is not a directory: {}",
                        current.display()
                    ));
                }
                canonical_inside_root(root, &current)?;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current)
                    .map_err(|e| format!("Cannot create vault dir '{}': {e}", current.display()))?;
                canonical_inside_root(root, &current)?;
            }
            Err(err) => {
                return Err(format!(
                    "Cannot stat vault dir '{}': {err}",
                    current.display()
                ));
            }
        }
    }
    Ok(current)
}

pub(super) fn ensure_manifest_path_inside(root: &Path, manifest_path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(manifest_path) {
        Ok(md) => {
            if md.file_type().is_symlink() {
                return Err(format!(
                    "Symlink files are not allowed in vault: {}",
                    manifest_path.display()
                ));
            }
            if !md.is_file() {
                return Err(format!(
                    "Vault manifest path is not a regular file: {}",
                    manifest_path.display()
                ));
            }
            canonical_inside_root(root, manifest_path)?;
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            return Err(format!(
                "Cannot stat vault manifest '{}': {err}",
                manifest_path.display()
            ));
        }
    }
    Ok(())
}

pub(super) fn ensure_manifest_matches_novel(
    manifest_path: &Path,
    novel_id: &str,
) -> Result<(), String> {
    let body = std::fs::read_to_string(manifest_path)
        .map_err(|e| format!("Cannot read manifest '{}': {e}", manifest_path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Cannot parse manifest '{}': {e}", manifest_path.display()))?;
    let existing = value
        .get("novelId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Vault manifest is missing novelId".to_string())?;
    if existing != novel_id {
        return Err(format!(
            "Vault manifest belongs to another novel ({existing}); refusing to attach it to {novel_id}"
        ));
    }
    Ok(())
}

pub(super) fn vault_manifest_path(root: &Path) -> PathBuf {
    root.join(".ainovel").join("manifest.json")
}

pub(super) fn existing_dir_has_entries(path: &Path) -> Result<bool, String> {
    let mut entries = std::fs::read_dir(path).map_err(|e| {
        format!(
            "Cannot inspect existing vault root '{}': {e}",
            path.display()
        )
    })?;
    Ok(entries.next().is_some())
}

pub(super) fn validate_vault_root_before_init(root: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(root) {
        Ok(md) => {
            if md.file_type().is_symlink() {
                return Err(format!(
                    "Vault root cannot be a symlink: {}",
                    root.display()
                ));
            }
            if !md.is_dir() {
                return Err(format!("Vault root is not a directory: {}", root.display()));
            }
            let internal_meta_dir = root.join(".ainovel");
            if std::fs::symlink_metadata(&internal_meta_dir)
                .map(|meta| meta.file_type().is_symlink())
                .unwrap_or(false)
            {
                return Err(format!(
                    "Symlink directories are not allowed in vault: {}",
                    internal_meta_dir.display()
                ));
            }
            let manifest_path = vault_manifest_path(root);
            let has_manifest_path = std::fs::symlink_metadata(&manifest_path).is_ok();
            if !has_manifest_path && existing_dir_has_entries(root)? {
                return Err("Vault root must be empty or an existing InkMarshal vault".to_string());
            }
            Ok(false)
        }
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(true),
        Err(err) => Err(format!(
            "Cannot stat vault root '{}': {err}",
            root.display()
        )),
    }
}

pub(super) fn validate_reveal_vault_root(
    novel_id: &str,
    vault_path: &str,
) -> Result<PathBuf, String> {
    let raw = PathBuf::from(vault_path);
    let md = std::fs::symlink_metadata(&raw)
        .map_err(|e| format!("Cannot stat vault root '{}': {e}", raw.display()))?;
    if md.file_type().is_symlink() {
        return Err(format!("Vault root cannot be a symlink: {}", raw.display()));
    }
    if !md.is_dir() {
        return Err(format!("Vault root is not a directory: {}", raw.display()));
    }

    let root = vault_root(vault_path)?;
    let manifest_path = vault_manifest_path(&root);
    ensure_manifest_path_inside(&root, &manifest_path)?;
    if !manifest_path.exists() {
        return Err("Vault manifest is missing".to_string());
    }
    ensure_manifest_matches_novel(&manifest_path, novel_id)?;
    Ok(root)
}

pub(super) fn open_new_vault_temp_file(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options
        .open(path)
        .map_err(|e| format!("Cannot open tmp '{}': {e}", path.display()))
}

/// Convert OS path to POSIX-style relative path (for JSON wire stability).
pub(super) fn to_posix_relative(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root).ok()?;
    let mut parts: Vec<String> = Vec::new();
    for c in rel.components() {
        if let Component::Normal(s) = c {
            parts.push(s.to_string_lossy().into_owned());
        }
    }
    Some(parts.join("/"))
}

pub(super) fn mtime_ms_of(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub(super) fn sha256_file_hex(path: &Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Cannot open '{}': {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Cannot read '{}': {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
pub fn vault_reachable(vault_path: String) -> Result<VaultReachable, String> {
    let root = PathBuf::from(&vault_path);
    let md = match std::fs::symlink_metadata(&root) {
        Ok(md) => md,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return Ok(VaultReachable {
                reachable: false,
                writable: false,
                error: Some(format!("Vault path does not exist: {vault_path}")),
            });
        }
        Err(err) => {
            return Ok(VaultReachable {
                reachable: false,
                writable: false,
                error: Some(err.to_string()),
            });
        }
    };
    if md.file_type().is_symlink() {
        return Ok(VaultReachable {
            reachable: false,
            writable: false,
            error: Some(format!("Vault root cannot be a symlink: {vault_path}")),
        });
    }
    if !md.is_dir() {
        return Ok(VaultReachable {
            reachable: false,
            writable: false,
            error: Some(format!("Vault path is not a directory: {vault_path}")),
        });
    }
    // Probe writability by attempting to write a tiny sentinel file. This is
    // more reliable than checking the permissions bit because some network
    // filesystems lie about permissions until the first write.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let probe = root.join(format!(".ainovel-probe-{nanos}.tmp"));
    // Use open_new_vault_temp_file so the probe respects the same
    // O_NOFOLLOW/create_new(true) invariants as our atomic write path —
    // otherwise a symlink at this location could redirect the probe outside
    // the vault.
    let writable = match open_new_vault_temp_file(&probe).and_then(|mut f| {
        use std::io::Write;
        f.write_all(b"ok")
            .map_err(|e| format!("probe write '{}': {e}", probe.display()))
    }) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    };
    Ok(VaultReachable {
        reachable: true,
        writable,
        error: None,
    })
}
