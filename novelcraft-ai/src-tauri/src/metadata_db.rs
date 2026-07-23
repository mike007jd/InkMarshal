//! SQLite-backed metadata store for installed + imported local models.
//!
//! Read/write paths in `model_manager.rs` route through this module via
//! [`MetaDb`]. Prelaunch builds support only this SQLite product shape; startup
//! never imports, renames, or removes unrelated JSON files.
//!
//! Connections are opened per call (SQLite open is cheap). The DB file lives
//! at `{models_dir}/inkmarshal-meta.db`.

use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

const META_DB_FILE: &str = "inkmarshal-meta.db";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS installed_models (
  path         TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  format       TEXT NOT NULL,
  source_repo  TEXT NOT NULL DEFAULT '',
  installed_at INTEGER NOT NULL,
  managed      INTEGER NOT NULL DEFAULT 1
);

"#;

#[derive(Debug, Clone)]
pub struct InstalledRecord {
    pub label: String,
    pub source_repo: String,
    pub format: String,
    pub installed_at_unix: u64,
}

#[derive(Debug, Clone)]
pub struct ImportedRecord {
    pub label: String,
    pub format: String,
    pub imported_at_unix: u64,
}

pub struct MetaDb {
    conn: Connection,
}

impl MetaDb {
    /// Open (creating if needed) the meta DB under `models_dir`.
    pub fn open(models_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(models_dir).map_err(|e| format!("meta_db dir: {e}"))?;
        let path = meta_db_path(models_dir);
        prepare_meta_db_file(&path)?;
        let conn = Connection::open(&path).map_err(|e| format!("meta_db open: {e}"))?;
        // Every Tauri command opens its own connection, so two concurrent
        // commands (e.g. a download upserting installed_models while the UI
        // polls list_installed_local_models) used to occasionally hit
        // SQLITE_BUSY on the default delete-mode journal + 0ms timeout. WAL
        // is the standard mitigation: concurrent readers don't block a
        // writer, and busy_timeout lets writers wait up to 5s for the
        // exclusive lock instead of failing immediately.
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;\n\
             PRAGMA synchronous=NORMAL;\n\
             PRAGMA busy_timeout=5000;\n\
             PRAGMA foreign_keys=ON;",
        )
        .map_err(|e| format!("meta_db pragmas: {e}"))?;
        conn.execute_batch(SCHEMA)
            .map_err(|e| format!("meta_db schema: {e}"))?;
        Ok(MetaDb { conn })
    }

    pub fn list_installed(&self) -> Result<HashMap<String, InstalledRecord>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, label, source_repo, format, installed_at FROM installed_models WHERE managed = 1")
            .map_err(|e| format!("meta_db prepare list_installed: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    InstalledRecord {
                        label: row.get(1)?,
                        source_repo: row.get(2)?,
                        format: row.get(3)?,
                        installed_at_unix: row.get::<_, i64>(4)? as u64,
                    },
                ))
            })
            .map_err(|e| format!("meta_db query list_installed: {e}"))?;
        let mut out = HashMap::new();
        for row in rows {
            let (path, rec) = row.map_err(|e| format!("meta_db row: {e}"))?;
            out.insert(path, rec);
        }
        Ok(out)
    }

    pub fn upsert_installed(&self, path: &str, rec: &InstalledRecord) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO installed_models(path, label, source_repo, format, installed_at, managed)
                 VALUES(?1, ?2, ?3, ?4, ?5, 1)
                 ON CONFLICT(path) DO UPDATE SET
                   label = excluded.label,
                   source_repo = excluded.source_repo,
                   format = excluded.format,
                   installed_at = excluded.installed_at,
                   managed = 1",
                params![
                    path,
                    rec.label,
                    rec.source_repo,
                    rec.format,
                    rec.installed_at_unix as i64,
                ],
            )
            .map_err(|e| format!("meta_db upsert_installed: {e}"))?;
        Ok(())
    }

    pub fn remove_installed(&self, path: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM installed_models WHERE path = ?1 AND managed = 1",
                params![path],
            )
            .map_err(|e| format!("meta_db remove_installed: {e}"))?;
        Ok(())
    }

    pub fn list_imported(&self) -> Result<HashMap<String, ImportedRecord>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT path, label, format, installed_at FROM installed_models WHERE managed = 0",
            )
            .map_err(|e| format!("meta_db prepare list_imported: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    ImportedRecord {
                        label: row.get(1)?,
                        format: row.get(2)?,
                        imported_at_unix: row.get::<_, i64>(3)? as u64,
                    },
                ))
            })
            .map_err(|e| format!("meta_db query list_imported: {e}"))?;
        let mut out = HashMap::new();
        for row in rows {
            let (path, rec) = row.map_err(|e| format!("meta_db row: {e}"))?;
            out.insert(path, rec);
        }
        Ok(out)
    }

    pub fn upsert_imported(&self, path: &str, rec: &ImportedRecord) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO installed_models(path, label, source_repo, format, installed_at, managed)
                 VALUES(?1, ?2, '', ?3, ?4, 0)
                 ON CONFLICT(path) DO UPDATE SET
                   label = excluded.label,
                   format = excluded.format,
                   installed_at = excluded.installed_at,
                   managed = 0",
                params![
                    path,
                    rec.label,
                    rec.format,
                    rec.imported_at_unix as i64,
                ],
            )
            .map_err(|e| format!("meta_db upsert_imported: {e}"))?;
        Ok(())
    }

    pub fn remove_imported(&self, path: &str) -> Result<(), String> {
        let info = self
            .conn
            .execute(
                "DELETE FROM installed_models WHERE path = ?1 AND managed = 0",
                params![path],
            )
            .map_err(|e| format!("meta_db remove_imported: {e}"))?;
        if info == 0 {
            return Err("Model path is not registered with InkMarshal".to_string());
        }
        Ok(())
    }
}

fn prepare_meta_db_file(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(md) => {
            if md.file_type().is_symlink() {
                return Err("meta_db path cannot be a symlink".to_string());
            }
            if !md.is_file() {
                return Err("meta_db path is not a regular file".to_string());
            }
            Ok(())
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW);
            }
            match options.open(path) {
                Ok(_) => Ok(()),
                Err(err) if err.kind() == ErrorKind::AlreadyExists => prepare_meta_db_file(path),
                Err(err) => Err(format!("meta_db create: {err}")),
            }
        }
        Err(err) => Err(format!("meta_db inspect: {err}")),
    }
}

/// Open the current metadata DB. Caller is responsible for using the result
/// for at least one DB operation; opening it is cheap.
pub fn open_for(models_dir: &Path) -> Result<MetaDb, String> {
    MetaDb::open(models_dir)
}

/// Helper for tests + diagnostics: confirm the meta DB exists.
#[allow(dead_code)]
pub fn meta_db_path(models_dir: &Path) -> PathBuf {
    models_dir.join(META_DB_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_tmp(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "inkmarshal-meta-db-test-{prefix}-{}-{nanos}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("tmp dir");
        path
    }

    #[test]
    fn meta_db_open_creates_regular_database_file() {
        let dir = unique_tmp("create");

        let db = MetaDb::open(&dir).expect("open db");
        db.upsert_installed(
            "/tmp/model.gguf",
            &InstalledRecord {
                label: "Model".to_string(),
                source_repo: "repo/model".to_string(),
                format: "gguf".to_string(),
                installed_at_unix: 1,
            },
        )
        .expect("write row");

        let md = fs::symlink_metadata(meta_db_path(&dir)).expect("db metadata");
        assert!(md.is_file());

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn meta_db_open_rejects_symlink_database_file() {
        use std::os::unix::fs::symlink;

        let dir = unique_tmp("db-symlink");
        let outside =
            dir.with_file_name(format!("inkmarshal-meta-db-outside-{}", std::process::id()));
        fs::write(&outside, b"do-not-touch").expect("outside");
        symlink(&outside, meta_db_path(&dir)).expect("db symlink");

        let err = match MetaDb::open(&dir) {
            Ok(_) => panic!("reject symlink db"),
            Err(err) => err,
        };
        assert!(err.contains("symlink"));
        assert_eq!(
            fs::read_to_string(&outside).expect("outside unchanged"),
            "do-not-touch"
        );

        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_for_leaves_unrelated_json_metadata_untouched() {
        let dir = unique_tmp("ignore-json");
        let json = dir.join(".inkmarshal-models.json");
        fs::write(&json, b"do-not-import-or-rename").expect("json fixture");

        open_for(&dir).expect("open current metadata db");

        assert_eq!(
            fs::read(&json).expect("json preserved"),
            b"do-not-import-or-rename"
        );
        assert!(!dir.join(".inkmarshal-models.json.bak").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
