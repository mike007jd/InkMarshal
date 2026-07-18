//! FS-backed Knowledge Vault — wave 2 commit B.
//!
//! Each novel owns a vault directory (default `~/.inkmarshal/app/vaults/{slug}`) that
//! is the **truth source** for knowledge entries. Files inside the vault are
//! plain Markdown with YAML frontmatter so the user can edit them in Obsidian
//! / VSCode / any text editor. SQLite holds an index + vector store and is
//! always rebuildable from the vault.
//!
//! This module exposes 10 tauri commands the TS layer wraps in `lib/vault/*`.
//! All filesystem mutations are atomic where possible (tmp + rename) and the
//! vault watcher emits `vault://changed` events so Next-side hooks can react.
//!
//! Non-goals (handled in later commits):
//!   * No outline → vault/outline/*.md migration (W2-D).
//!   * No wikilink 1-hop resolution (W2-E).
//!   * No embedding logic (W2-C, separate SQLite table).

use serde::Serialize;

mod init;
mod io;
mod path;
mod platform;
mod walk;
mod watch;

// ── Wire types (camelCase to match the TS layer) ────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFileMeta {
    /// POSIX-style relative path from vault root, e.g. `characters/lin-shen.md`.
    pub path: String,
    pub content_hash: String,
    /// Last-modified timestamp in epoch milliseconds (UTC). 0 when unavailable.
    pub mtime_ms: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultReadResult {
    pub content: String,
    pub content_hash: String,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultWriteResult {
    pub content_hash: String,
    pub mtime_ms: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultReachable {
    pub reachable: bool,
    pub writable: bool,
    pub error: Option<String>,
}

/// Payload emitted via the `vault://changed` event. `kind` mirrors notify's
/// coarse-grained categories so the TS layer can decide between a targeted
/// reindex (modify) vs. a full walk (rename/remove).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultChangedEvent {
    pub novel_id: String,
    pub paths: Vec<String>,
    pub kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInitResult {
    pub vault_path: String,
    pub created: bool,
    pub manifest_path: String,
}

// ── Command + state re-exports (paths consumed by lib.rs generate_handler!) ──

// Glob re-exports so the `#[tauri::command]` macro-generated helper items
// (`__cmd__*` / `__tauri_command_name_*`) keep their `vault::<command>` paths
// that `generate_handler!` in lib.rs resolves against. `pub(super)` helpers are
// not public and are silently skipped by the glob.
pub use init::*;
pub use io::*;
pub use path::*;
pub use platform::*;
pub use walk::*;
pub use watch::*;

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::init::VAULT_SUBDIRS;
    use super::path::{
        ensure_existing_dir_inside, open_new_vault_temp_file, safe_entry_rel_path, safe_rel_path,
        sha256_hex, validate_reveal_vault_root, vault_root, MAX_VAULT_ENTRY_FILE_BYTES,
    };
    use super::watch::same_watch_generation_parts;
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_tmp(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let pid = std::process::id();
        let mut p = std::env::temp_dir();
        p.push(format!("inkmarshal-vault-test-{label}-{pid}-{nanos}"));
        fs::create_dir_all(&p).expect("mk tmp");
        p
    }

    #[test]
    fn vault_init_creates_all_subdirs() {
        let tmp = unique_tmp("init");
        let vault = tmp.join("v1");
        let r = vault_init("novel-1".into(), vault.to_string_lossy().into_owned()).unwrap();
        assert!(r.created);
        for sub in VAULT_SUBDIRS {
            assert!(
                vault.join(sub).is_dir(),
                "expected subdir {sub} under vault"
            );
        }
        assert!(vault.join(".ainovel").join("manifest.json").is_file());
        // Re-init is idempotent (does not recreate manifest).
        let r2 = vault_init("novel-1".into(), vault.to_string_lossy().into_owned()).unwrap();
        assert!(!r2.created);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn vault_init_rejects_non_empty_non_vault_directory_without_polluting_it() {
        let tmp = unique_tmp("init-non-empty");
        let vault = tmp.join("picked-home");
        fs::create_dir_all(&vault).unwrap();
        fs::write(vault.join("notes.txt"), b"not a vault").unwrap();

        let err = vault_init("novel-1".into(), vault.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("empty or an existing InkMarshal vault"));
        for sub in VAULT_SUBDIRS {
            assert!(
                !vault.join(sub).exists(),
                "unexpected subdir created: {sub}"
            );
        }
        assert!(vault.join("notes.txt").is_file());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn vault_init_rejects_symlinked_root_before_creating_vault_files() {
        use std::os::unix::fs::symlink;

        let tmp = unique_tmp("init-root-symlink");
        let target = tmp.join("target");
        let vault_link = tmp.join("vault-link");
        fs::create_dir_all(&target).unwrap();
        symlink(&target, &vault_link).unwrap();

        let err =
            vault_init("novel-1".into(), vault_link.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("Vault root cannot be a symlink"));
        assert!(!target.join(".ainovel").exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn reveal_validation_accepts_initialized_external_vault() {
        let tmp = unique_tmp("reveal-external");
        let vault = tmp.join("external-vault");
        vault_init("novel-1".into(), vault.to_string_lossy().into_owned()).unwrap();

        let root = validate_reveal_vault_root("novel-1", &vault.to_string_lossy()).unwrap();
        assert_eq!(root, vault.canonicalize().unwrap());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn reveal_validation_rejects_missing_manifest() {
        let tmp = unique_tmp("reveal-missing-manifest");
        let vault = tmp.join("not-a-vault");
        fs::create_dir_all(&vault).unwrap();

        let err = validate_reveal_vault_root("novel-1", &vault.to_string_lossy()).unwrap_err();
        assert!(err.contains("Vault manifest is missing"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn reveal_validation_rejects_manifest_for_another_novel() {
        let tmp = unique_tmp("reveal-wrong-novel");
        let vault = tmp.join("v");
        vault_init("novel-a".into(), vault.to_string_lossy().into_owned()).unwrap();

        let err = validate_reveal_vault_root("novel-b", &vault.to_string_lossy()).unwrap_err();
        assert!(err.contains("belongs to another novel"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn reveal_validation_rejects_symlinked_root() {
        use std::os::unix::fs::symlink;

        let tmp = unique_tmp("reveal-root-symlink");
        let target = tmp.join("target");
        let vault_link = tmp.join("vault-link");
        vault_init("novel-1".into(), target.to_string_lossy().into_owned()).unwrap();
        symlink(&target, &vault_link).unwrap();

        let err = validate_reveal_vault_root("novel-1", &vault_link.to_string_lossy()).unwrap_err();
        assert!(err.contains("Vault root cannot be a symlink"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn vault_walk_returns_files_with_hash() {
        let tmp = unique_tmp("walk");
        let vault = tmp.join("v");
        vault_init("n".into(), vault.to_string_lossy().into_owned()).unwrap();
        fs::write(
            vault.join("characters").join("a.md"),
            b"---\nid: a\n---\nbody",
        )
        .unwrap();
        fs::write(vault.join("worlds").join("b.md"), b"hello").unwrap();
        // Non-markdown file should be skipped.
        fs::write(vault.join("characters").join("notes.txt"), b"skip me").unwrap();
        fs::write(vault.join("root.md"), b"root file").unwrap();
        fs::create_dir_all(vault.join("private")).unwrap();
        fs::write(vault.join("private").join("secret.md"), b"private").unwrap();
        fs::create_dir_all(vault.join("characters").join("nested")).unwrap();
        fs::write(
            vault.join("characters").join("nested").join("ignored.md"),
            b"nested",
        )
        .unwrap();
        let metas = vault_walk(vault.to_string_lossy().into_owned()).unwrap();
        let paths: Vec<&str> = metas.iter().map(|m| m.path.as_str()).collect();
        assert!(paths.contains(&"characters/a.md"));
        assert!(paths.contains(&"worlds/b.md"));
        assert!(!paths.iter().any(|p| p.ends_with("notes.txt")));
        assert!(!paths.contains(&"root.md"));
        assert!(!paths.contains(&"private/secret.md"));
        assert!(!paths.contains(&"characters/nested/ignored.md"));
        // Hashes are non-empty 64-hex strings.
        for m in &metas {
            assert_eq!(m.content_hash.len(), 64);
        }
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn vault_write_then_read_roundtrip() {
        let tmp = unique_tmp("roundtrip");
        let vault = tmp.join("v");
        vault_init("n".into(), vault.to_string_lossy().into_owned()).unwrap();
        let body = "---\nid: x\ntitle: Hello\n---\n# Heading\n\nBody [[Link]]";
        let w = vault_write_file(
            vault.to_string_lossy().into_owned(),
            "characters/x.md".into(),
            body.into(),
        )
        .unwrap();
        let r = vault_read_file(
            vault.to_string_lossy().into_owned(),
            "characters/x.md".into(),
        )
        .unwrap();
        assert_eq!(r.content, body);
        assert_eq!(r.content_hash, w.content_hash);
        // Hash is the sha256 of the exact bytes.
        assert_eq!(r.content_hash, sha256_hex(body.as_bytes()));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn vault_write_rejects_oversized_markdown() {
        let tmp = unique_tmp("oversized-write");
        let vault = tmp.join("v");
        vault_init("n".into(), vault.to_string_lossy().into_owned()).unwrap();
        let body = "a".repeat((MAX_VAULT_ENTRY_FILE_BYTES + 1) as usize);

        let err = vault_write_file(
            vault.to_string_lossy().into_owned(),
            "characters/big.md".into(),
            body,
        )
        .unwrap_err();
        assert!(err.contains("Vault file is too large"));
        assert!(!vault.join("characters").join("big.md").exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn vault_read_rejects_oversized_markdown_and_walk_hashes_without_buffering() {
        let tmp = unique_tmp("oversized-read");
        let vault = tmp.join("v");
        vault_init("n".into(), vault.to_string_lossy().into_owned()).unwrap();
        let body = vec![b'a'; (MAX_VAULT_ENTRY_FILE_BYTES + 1) as usize];
        let path = vault.join("characters").join("big.md");
        fs::write(&path, &body).unwrap();

        let metas = vault_walk(vault.to_string_lossy().into_owned()).unwrap();
        let meta = metas
            .iter()
            .find(|m| m.path == "characters/big.md")
            .unwrap();
        assert_eq!(meta.size, MAX_VAULT_ENTRY_FILE_BYTES + 1);
        assert_eq!(meta.content_hash, sha256_hex(&body));

        let err = vault_read_file(
            vault.to_string_lossy().into_owned(),
            "characters/big.md".into(),
        )
        .unwrap_err();
        assert!(err.contains("Vault file is too large"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn vault_temp_write_rejects_preexisting_symlink() {
        use std::os::unix::fs::symlink;

        let tmp = unique_tmp("tmp-symlink");
        let outside = tmp.join("outside.md");
        let temp_link = tmp.join(".entry.md.123.tmp");
        fs::write(&outside, b"outside").unwrap();
        symlink(&outside, &temp_link).unwrap();

        let err = open_new_vault_temp_file(&temp_link).unwrap_err();
        assert!(err.contains("Cannot open tmp"));
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
        let link_md = fs::symlink_metadata(&temp_link).unwrap();
        assert!(link_md.file_type().is_symlink());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn vault_delete_moves_to_trash() {
        let tmp = unique_tmp("delete");
        let vault = tmp.join("v");
        vault_init("n".into(), vault.to_string_lossy().into_owned()).unwrap();
        vault_write_file(
            vault.to_string_lossy().into_owned(),
            "characters/del.md".into(),
            "trash me".into(),
        )
        .unwrap();
        vault_delete_file(
            vault.to_string_lossy().into_owned(),
            "characters/del.md".into(),
        )
        .unwrap();
        assert!(!vault.join("characters").join("del.md").exists());
        // Exactly one file lives under .ainovel/trash/, and it contains the
        // original bytes.
        let trash_dir = vault.join(".ainovel").join("trash");
        let entries: Vec<_> = fs::read_dir(&trash_dir).unwrap().collect();
        assert_eq!(entries.len(), 1);
        let trashed = entries.into_iter().next().unwrap().unwrap().path();
        assert_eq!(fs::read_to_string(&trashed).unwrap(), "trash me");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn vault_move_atomic() {
        let tmp = unique_tmp("move");
        let vault = tmp.join("v");
        vault_init("n".into(), vault.to_string_lossy().into_owned()).unwrap();
        vault_write_file(
            vault.to_string_lossy().into_owned(),
            "characters/old.md".into(),
            "hi".into(),
        )
        .unwrap();
        vault_move(
            vault.to_string_lossy().into_owned(),
            "characters/old.md".into(),
            "characters/new.md".into(),
        )
        .unwrap();
        assert!(!vault.join("characters").join("old.md").exists());
        assert!(vault.join("characters").join("new.md").exists());

        // Destination already exists → error and source preserved.
        vault_write_file(
            vault.to_string_lossy().into_owned(),
            "characters/keep.md".into(),
            "k".into(),
        )
        .unwrap();
        let err = vault_move(
            vault.to_string_lossy().into_owned(),
            "characters/keep.md".into(),
            "characters/new.md".into(),
        )
        .unwrap_err();
        assert!(err.contains("exists"));
        assert!(vault.join("characters").join("keep.md").exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn safe_rel_path_rejects_traversal() {
        assert!(safe_rel_path("../escape.md").is_err());
        assert!(safe_rel_path("/absolute.md").is_err());
        assert!(safe_rel_path("characters/ok.md").is_ok());
        assert!(safe_rel_path("characters/sub/ok.md").is_ok());
    }

    #[test]
    fn safe_entry_rel_path_allows_only_user_markdown_entries() {
        assert!(safe_entry_rel_path("characters/ok.md").is_ok());
        assert!(safe_entry_rel_path("worlds/nested/place.md").is_err());
        assert!(safe_entry_rel_path(".ainovel/manifest.json").is_err());
        assert!(safe_entry_rel_path("characters/notes.txt").is_err());
        assert!(safe_entry_rel_path("characters/./ok.md").is_err());
        assert!(safe_entry_rel_path("characters\\ok.md").is_err());
        assert!(safe_entry_rel_path("other/ok.md").is_err());
    }

    #[test]
    fn vault_file_commands_reject_internal_paths() {
        let tmp = unique_tmp("internal-paths");
        let vault = tmp.join("v");
        let vault_path = vault.to_string_lossy().into_owned();
        vault_init("n".into(), vault_path.clone()).unwrap();

        let read_err =
            vault_read_file(vault_path.clone(), ".ainovel/manifest.json".into()).unwrap_err();
        assert!(read_err.contains("user content"));

        let write_err = vault_write_file(
            vault_path.clone(),
            ".ainovel/manifest.json".into(),
            "corrupt".into(),
        )
        .unwrap_err();
        assert!(write_err.contains("user content"));

        let delete_err =
            vault_delete_file(vault_path.clone(), ".ainovel/manifest.json".into()).unwrap_err();
        assert!(delete_err.contains("user content"));
        assert!(vault.join(".ainovel").join("manifest.json").is_file());

        let move_err = vault_move(
            vault_path.clone(),
            ".ainovel/manifest.json".into(),
            "characters/manifest.md".into(),
        )
        .unwrap_err();
        assert!(move_err.contains("user content"));
        assert!(!vault.join("characters").join("manifest.md").exists());

        let non_entry_err =
            vault_write_file(vault_path, "characters/notes.txt".into(), "notes".into())
                .unwrap_err();
        assert!(non_entry_err.contains("user content"));
        assert!(!vault.join("characters").join("notes.txt").exists());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn vault_init_rejects_symlinked_internal_directories() {
        use std::os::unix::fs::symlink;

        let tmp = unique_tmp("init-symlink-dir");
        let vault = tmp.join("v");
        let outside = tmp.join("outside");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, vault.join(".ainovel")).unwrap();

        let err = vault_init("n".into(), vault.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("Symlink directories are not allowed"));
        assert!(!outside.join("manifest.json").exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn vault_init_rejects_symlinked_manifest_file() {
        use std::os::unix::fs::symlink;

        let tmp = unique_tmp("init-symlink-manifest");
        let vault = tmp.join("v");
        let outside = tmp.join("outside-manifest.json");
        fs::create_dir_all(vault.join(".ainovel")).unwrap();
        symlink(&outside, vault.join(".ainovel").join("manifest.json")).unwrap();

        let err = vault_init("n".into(), vault.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("Symlink files are not allowed"));
        assert!(!outside.exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn vault_init_rejects_manifest_for_another_novel() {
        let tmp = unique_tmp("init-wrong-manifest");
        let vault = tmp.join("v");
        vault_init("novel-a".into(), vault.to_string_lossy().into_owned()).unwrap();

        let err = vault_init("novel-b".into(), vault.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("belongs to another novel"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn vault_read_and_walk_reject_symlink_escape() {
        use std::os::unix::fs::symlink;

        let tmp = unique_tmp("symlink-read");
        let vault = tmp.join("v");
        let outside = tmp.join("outside.md");
        vault_init("n".into(), vault.to_string_lossy().into_owned()).unwrap();
        fs::write(&outside, b"secret outside vault").unwrap();
        symlink(&outside, vault.join("characters").join("leak.md")).unwrap();

        let metas = vault_walk(vault.to_string_lossy().into_owned()).unwrap();
        assert!(!metas.iter().any(|m| m.path == "characters/leak.md"));

        let err = vault_read_file(
            vault.to_string_lossy().into_owned(),
            "characters/leak.md".into(),
        )
        .unwrap_err();
        assert!(err.contains("Symlink files are not allowed"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn vault_walk_directory_guard_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let tmp = unique_tmp("symlink-walk-dir");
        let vault = tmp.join("v");
        let outside = tmp.join("outside-dir");
        vault_init("n".into(), vault.to_string_lossy().into_owned()).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let link = vault.join("characters").join("linked-dir");
        symlink(&outside, &link).unwrap();

        let root = vault_root(&vault.to_string_lossy()).unwrap();
        let err = ensure_existing_dir_inside(&root, &link).unwrap_err();
        assert!(err.contains("Symlink directories are not allowed"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn vault_write_rejects_symlink_parent_escape() {
        use std::os::unix::fs::symlink;

        let tmp = unique_tmp("symlink-write");
        let vault = tmp.join("v");
        let outside = tmp.join("outside-dir");
        vault_init("n".into(), vault.to_string_lossy().into_owned()).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::remove_dir_all(vault.join("characters")).unwrap();
        symlink(&outside, vault.join("characters")).unwrap();

        let err = vault_write_file(
            vault.to_string_lossy().into_owned(),
            "characters/escape.md".into(),
            "should not escape".into(),
        )
        .unwrap_err();
        assert!(err.contains("Symlink directories are not allowed"));
        assert!(!outside.join("escape.md").exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn vault_delete_and_move_reject_directories() {
        let tmp = unique_tmp("dir-source");
        let vault = tmp.join("v");
        vault_init("n".into(), vault.to_string_lossy().into_owned()).unwrap();
        fs::create_dir_all(vault.join("characters").join("dir.md")).unwrap();
        fs::create_dir_all(vault.join("worlds").join("dir.md")).unwrap();

        let delete_err = vault_delete_file(
            vault.to_string_lossy().into_owned(),
            "characters/dir.md".into(),
        )
        .unwrap_err();
        assert!(delete_err.contains("Vault path is not a regular file"));
        assert!(vault.join("characters").join("dir.md").is_dir());

        let move_err = vault_move(
            vault.to_string_lossy().into_owned(),
            "worlds/dir.md".into(),
            "worlds/dir2.md".into(),
        )
        .unwrap_err();
        assert!(move_err.contains("Vault path is not a regular file"));
        assert!(vault.join("worlds").join("dir.md").is_dir());
        assert!(!vault.join("worlds").join("dir2.md").exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn vault_delete_rejects_symlinked_trash_dir() {
        use std::os::unix::fs::symlink;

        let tmp = unique_tmp("delete-trash-symlink");
        let vault = tmp.join("v");
        let outside = tmp.join("outside-trash");
        vault_init("n".into(), vault.to_string_lossy().into_owned()).unwrap();
        vault_write_file(
            vault.to_string_lossy().into_owned(),
            "characters/del.md".into(),
            "trash me".into(),
        )
        .unwrap();
        fs::remove_dir_all(vault.join(".ainovel").join("trash")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, vault.join(".ainovel").join("trash")).unwrap();

        let err = vault_delete_file(
            vault.to_string_lossy().into_owned(),
            "characters/del.md".into(),
        )
        .unwrap_err();
        assert!(err.contains("Symlink directories are not allowed"));
        assert!(vault.join("characters").join("del.md").is_file());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn vault_reachable_reports_writability() {
        let tmp = unique_tmp("reachable");
        let vault = tmp.join("v");
        std::fs::create_dir_all(&vault).unwrap();
        let r = vault_reachable(vault.to_string_lossy().into_owned()).unwrap();
        assert!(r.reachable);
        assert!(r.writable);
        let r2 =
            vault_reachable(tmp.join("does-not-exist").to_string_lossy().into_owned()).unwrap();
        assert!(!r2.reachable);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn vault_reachable_rejects_symlink_root_without_probe_write() {
        use std::os::unix::fs::symlink;

        let tmp = unique_tmp("reachable-symlink");
        let outside = tmp.join("outside");
        let link = tmp.join("linked-vault");
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, &link).unwrap();

        let r = vault_reachable(link.to_string_lossy().into_owned()).unwrap();
        assert!(!r.reachable);
        assert!(!r.writable);
        assert!(r.error.unwrap().contains("symlink"));
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn vault_watcher_root_matching_is_path_specific() {
        assert!(same_watch_generation_parts(
            Path::new("/tmp/inkmarshal-vault-a"),
            Some("watch-1"),
            Path::new("/tmp/inkmarshal-vault-a"),
            Some("watch-1"),
        ));
        assert!(!same_watch_generation_parts(
            Path::new("/tmp/inkmarshal-vault-a"),
            Some("watch-1"),
            Path::new("/tmp/inkmarshal-vault-b"),
            Some("watch-1"),
        ));
        assert!(!same_watch_generation_parts(
            Path::new("/tmp/inkmarshal-vault-a"),
            Some("watch-1"),
            Path::new("/tmp/inkmarshal-vault-a"),
            Some("watch-2"),
        ));
    }
}
