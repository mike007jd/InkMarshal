//! Deterministic vault walk: enumerates canonical Markdown entries with their
//! content hash and mtime. Descends only into known entry directories.

use super::path::{
    ensure_existing_dir_inside, ensure_regular_file_inside, mtime_ms_of, sha256_file_hex,
    to_posix_relative, vault_root, VAULT_ENTRY_DIRS,
};
use super::VaultFileMeta;
use std::path::Path;

#[tauri::command]
pub fn vault_walk(vault_path: String) -> Result<Vec<VaultFileMeta>, String> {
    let root = vault_root(&vault_path)?;
    let mut out: Vec<VaultFileMeta> = Vec::new();
    walk_recursive(&root, &root, &mut out)?;
    // Stable, lexical ordering so the index rebuild is deterministic.
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn walk_recursive(root: &Path, dir: &Path, out: &mut Vec<VaultFileMeta>) -> Result<(), String> {
    let read = std::fs::read_dir(dir)
        .map_err(|e| format!("Cannot read vault dir '{}': {e}", dir.display()))?;
    for entry in read {
        let entry =
            entry.map_err(|e| format!("Cannot read entry under '{}': {e}", dir.display()))?;
        let path = entry.path();
        let ft = entry
            .file_type()
            .map_err(|e| format!("Cannot stat '{}': {e}", path.display()))?;
        if ft.is_symlink() {
            continue;
        }
        // Skip the internal `.ainovel/` directory and anything starting with a
        // dot at the vault root level so Obsidian metadata (`.obsidian/`) and
        // our own internal store stay out of the user-visible index.
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if dir == root {
                if name.starts_with('.') {
                    continue;
                }
                if ft.is_dir() && !VAULT_ENTRY_DIRS.contains(&name) {
                    continue;
                }
                if ft.is_file() {
                    continue;
                }
            }
        }
        let md = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("Cannot stat '{}': {e}", path.display()))?;
        if md.file_type().is_symlink() {
            continue;
        }
        if md.is_dir() {
            let resolved = ensure_existing_dir_inside(root, &path)?;
            if should_descend_walk_dir(root, &resolved) {
                walk_recursive(root, &resolved, out)?;
            }
        } else if md.is_file() {
            // Only index Markdown files. Other artefacts (JSON, images) live in
            // the vault for the user but should not be exposed as entries.
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let resolved = ensure_regular_file_inside(root, &path)?;
            let rel = match to_posix_relative(root, &resolved) {
                Some(r) if !r.is_empty() => r,
                _ => continue,
            };
            if !is_canonical_walk_entry_path(&rel) {
                continue;
            }
            let resolved_md = std::fs::metadata(&resolved)
                .map_err(|e| format!("Cannot stat '{}': {e}", resolved.display()))?;
            out.push(VaultFileMeta {
                path: rel,
                content_hash: sha256_file_hex(&resolved)?,
                mtime_ms: mtime_ms_of(&resolved_md),
                size: resolved_md.len(),
            });
        }
    }
    Ok(())
}

fn should_descend_walk_dir(root: &Path, dir: &Path) -> bool {
    if dir == root {
        return true;
    }
    let Some(rel) = to_posix_relative(root, dir) else {
        return false;
    };
    let parts: Vec<&str> = rel.split('/').collect();
    parts.len() == 1 && VAULT_ENTRY_DIRS.contains(&parts[0])
}

fn is_canonical_walk_entry_path(rel: &str) -> bool {
    if !rel.ends_with(".md") || rel.contains('\\') || rel.chars().any(char::is_control) {
        return false;
    }
    let parts: Vec<&str> = rel.split('/').collect();
    parts.len() == 2
        && VAULT_ENTRY_DIRS.contains(&parts[0])
        && !parts[1].is_empty()
        && parts[1] != "."
        && parts[1] != ".."
}
