//! Vault file I/O commands: read, atomic write (tmp+fsync+rename), soft delete,
//! and atomic move. Path/manifest safety lives in `super::path`.

use super::path::{
    ensure_dir_inside, ensure_parent_dir_inside, ensure_regular_file_inside, mtime_ms_of,
    open_new_vault_temp_file, safe_entry_rel_path, sha256_hex, vault_root,
    MAX_VAULT_ENTRY_FILE_BYTES,
};
use super::{VaultReadResult, VaultWriteResult};
use std::time::{SystemTime, UNIX_EPOCH};

#[tauri::command]
pub fn vault_read_file(vault_path: String, rel_path: String) -> Result<VaultReadResult, String> {
    let root = vault_root(&vault_path)?;
    let rel = safe_entry_rel_path(&rel_path)?;
    let abs = root.join(&rel);
    let resolved = ensure_regular_file_inside(&root, &abs)?;
    let md = std::fs::metadata(&resolved)
        .map_err(|e| format!("Cannot stat '{}': {e}", abs.display()))?;
    if md.len() > MAX_VAULT_ENTRY_FILE_BYTES {
        return Err(format!(
            "Vault file is too large: {} bytes (max {})",
            md.len(),
            MAX_VAULT_ENTRY_FILE_BYTES
        ));
    }
    let bytes = std::fs::read(&resolved)
        .map_err(|e| format!("Cannot read '{}': {e}", resolved.display()))?;
    let content = String::from_utf8(bytes.clone())
        .map_err(|e| format!("File '{}' is not valid UTF-8: {e}", abs.display()))?;
    Ok(VaultReadResult {
        content,
        content_hash: sha256_hex(&bytes),
        mtime_ms: mtime_ms_of(&md),
    })
}

#[tauri::command]
pub fn vault_write_file(
    vault_path: String,
    rel_path: String,
    content: String,
) -> Result<VaultWriteResult, String> {
    let root = vault_root(&vault_path)?;
    let rel = safe_entry_rel_path(&rel_path)?;
    let abs = root.join(&rel);
    let bytes = content.as_bytes();
    if bytes.len() as u64 > MAX_VAULT_ENTRY_FILE_BYTES {
        return Err(format!(
            "Vault file is too large: {} bytes (max {})",
            bytes.len(),
            MAX_VAULT_ENTRY_FILE_BYTES
        ));
    }

    ensure_parent_dir_inside(&root, &rel)?;

    let hash = sha256_hex(bytes);

    // tmp file in the same directory so the rename is atomic on every FS.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = {
        let mut t = abs.clone();
        let stem = t
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("vault-tmp");
        t.set_file_name(format!(".{stem}.{nanos}.tmp"));
        t
    };

    {
        use std::io::Write;
        let mut f = open_new_vault_temp_file(&tmp)?;
        f.write_all(bytes)
            .map_err(|e| format!("Cannot write tmp '{}': {e}", tmp.display()))?;
        // Best-effort fsync — on some network FS this is a no-op or errors;
        // we don't fail the write just because sync_all reports a non-fatal
        // condition.
        let _ = f.sync_all();
    }

    std::fs::rename(&tmp, &abs).map_err(|e| {
        // Best-effort cleanup; don't mask the original error.
        let _ = std::fs::remove_file(&tmp);
        format!(
            "Cannot rename tmp '{}' → '{}': {e}",
            tmp.display(),
            abs.display()
        )
    })?;

    let md = std::fs::metadata(&abs)
        .map_err(|e| format!("Cannot stat written file '{}': {e}", abs.display()))?;
    Ok(VaultWriteResult {
        content_hash: hash,
        mtime_ms: mtime_ms_of(&md),
        size: md.len(),
    })
}

#[tauri::command]
pub fn vault_delete_file(vault_path: String, rel_path: String) -> Result<(), String> {
    let root = vault_root(&vault_path)?;
    let rel = safe_entry_rel_path(&rel_path)?;
    let src = root.join(&rel);
    ensure_regular_file_inside(&root, &src)?;

    let trash_dir = ensure_dir_inside(&root, ".ainovel/trash")?;

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let base_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("deleted");
    // Embed the original relative dir in the trash filename so a future
    // "restore" step can put the file back.
    let safe_rel_marker = rel_path.replace('/', "__");
    let trash_name = format!("{nanos}-{safe_rel_marker}-{base_name}");
    let dst = trash_dir.join(trash_name);
    std::fs::rename(&src, &dst).map_err(|e| {
        format!(
            "Cannot move '{}' to trash '{}': {e}",
            src.display(),
            dst.display()
        )
    })?;
    Ok(())
}

#[tauri::command]
pub fn vault_move(vault_path: String, src_rel: String, dst_rel: String) -> Result<(), String> {
    let root = vault_root(&vault_path)?;
    let src_rel_path = safe_entry_rel_path(&src_rel)?;
    let dst_rel_path = safe_entry_rel_path(&dst_rel)?;
    let src = root.join(&src_rel_path);
    let dst = root.join(&dst_rel_path);
    ensure_regular_file_inside(&root, &src)?;
    if std::fs::symlink_metadata(&dst).is_ok() {
        return Err(format!("Destination exists: {}", dst.display()));
    }
    ensure_parent_dir_inside(&root, &dst_rel_path)?;
    std::fs::rename(&src, &dst).map_err(|e| {
        format!(
            "Rename '{}' → '{}' failed: {e}",
            src.display(),
            dst.display()
        )
    })?;
    Ok(())
}
