//! Local installed-model store: scan (managed + imported), the metadata
//! sidecars, GGUF/MLX validation, registration (registered_model_path), and the
//! install/import/remove/reveal commands.

use super::paths::{canonical_model_root, is_snapshot_temp_dir, model_dir_for, reveal_path};
use super::{current_unix, ImportedModelMetadata, InstalledLocalModel, InstalledModelMetadata};
use crate::http_util::io_err;
use std::path::{Path, PathBuf};

pub(super) const MAX_MODEL_LABEL_BYTES: usize = 200;

// ── Download registry (cancel-flag map) ─────────────────────────────────────

#[tauri::command]
pub fn list_installed_local_models(
    app: tauri::AppHandle,
) -> Result<Vec<InstalledLocalModel>, String> {
    let root = model_dir_for(&app)?;
    cleanup_orphan_parts(&root, std::time::Duration::from_secs(72 * 3600));
    scan_installed_models_root(&root)
}

/// Walk the models root recursively and delete any `.part` file older than
/// `max_age`. Called at startup (via `list_installed_local_models`) so leftovers
/// from a crashed or force-killed download eventually get reclaimed. A 72-hour
/// grace window keeps any in-flight resume intact while still preventing the
/// models folder from accumulating multi-GB scratch files forever.
pub fn cleanup_orphan_parts(root: &Path, max_age: std::time::Duration) {
    fn walk(dir: &Path, max_age: std::time::Duration) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(ftype) = entry.file_type() else {
                continue;
            };
            if ftype.is_dir() {
                if is_snapshot_temp_dir(&path) {
                    if let Ok(meta) = std::fs::metadata(&path) {
                        if let Ok(modified) = meta.modified() {
                            let age = std::time::SystemTime::now()
                                .duration_since(modified)
                                .unwrap_or_default();
                            if age > max_age {
                                let _ = std::fs::remove_dir_all(&path);
                            }
                        }
                    }
                    continue;
                }
                walk(&path, max_age);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("part") {
                continue;
            }
            if let Ok(meta) = std::fs::metadata(&path) {
                if let Ok(modified) = meta.modified() {
                    let age = std::time::SystemTime::now()
                        .duration_since(modified)
                        .unwrap_or_default();
                    if age > max_age {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }
    if root.exists() {
        walk(root, max_age);
    }
}

#[tauri::command]
pub fn reveal_local_model(app: tauri::AppHandle, model_path: String) -> Result<(), String> {
    let target = registered_model_path(&app, &model_path)?;
    reveal_path(&target)
}

#[tauri::command]
pub fn remove_installed_local_model(
    app: tauri::AppHandle,
    model_path: String,
) -> Result<(), String> {
    let root = model_dir_for(&app)?;
    if let Ok(target_canon) = removable_managed_model_path(&root, &model_path) {
        let meta_path = metadata_key(&target_canon);
        if target_canon.is_dir() {
            std::fs::remove_dir_all(&target_canon)
                .map_err(|e| io_err("Couldn't remove the model", &e))?;
        } else {
            std::fs::remove_file(&target_canon)
                .map_err(|e| io_err("Couldn't remove the model", &e))?;
        }
        let _ = remove_installed_metadata(&app, &meta_path);
        return Ok(());
    }

    remove_imported_metadata(&app, &model_path)
}

#[tauri::command]
pub fn import_local_model(
    app: tauri::AppHandle,
    model_path: String,
    label: Option<String>,
) -> Result<InstalledLocalModel, String> {
    let root = model_dir_for(&app)?;
    std::fs::create_dir_all(&root).map_err(|e| io_err("Couldn't prepare the models folder", &e))?;
    let target = PathBuf::from(&model_path)
        .canonicalize()
        .map_err(|e| io_err("Couldn't read model metadata", &e))?;
    let imported = imported_model_from_path(&root, &target, label)?;
    let mut all = read_imported_metadata(&root);
    all.insert(
        metadata_key(&target),
        ImportedModelMetadata {
            label: imported.label.clone(),
            format: imported.format.clone(),
            imported_at_unix: imported.installed_at_unix.unwrap_or_else(current_unix),
        },
    );
    write_imported_metadata(&root, &all)?;
    Ok(imported)
}

pub(super) fn removable_managed_model_path(
    root: &Path,
    model_path: &str,
) -> Result<PathBuf, String> {
    let root_canon = canonical_model_root(root)?;
    let target = PathBuf::from(model_path);
    let target_canon = target
        .canonicalize()
        .map_err(|e| io_err("Couldn't read model metadata", &e))?;
    if !target_canon.starts_with(&root_canon) || target_canon == root_canon {
        return Err("Model path is outside the local model folder".to_string());
    }

    let final_check = target_canon
        .canonicalize()
        .map_err(|e| io_err("Couldn't read model path", &e))?;
    if !final_check.starts_with(&root_canon) || final_check == root_canon {
        return Err("Model path escaped the model folder after validation".to_string());
    }
    if final_check != target_canon {
        return Err("Model path changed between validation and removal — aborting".to_string());
    }

    imported_model_from_path(&root_canon, &final_check, None)?;
    Ok(final_check)
}

pub(crate) fn registered_model_path(
    app: &tauri::AppHandle,
    model_path: &str,
) -> Result<PathBuf, String> {
    let root = model_dir_for(app)?;
    let imported = read_imported_metadata(&root);
    registered_model_path_inner(&root, model_path, &imported)
}

pub(super) fn registered_model_path_inner(
    root: &Path,
    model_path: &str,
    imported: &std::collections::HashMap<String, ImportedModelMetadata>,
) -> Result<PathBuf, String> {
    let root_canon = canonical_model_root(root)?;
    let target = PathBuf::from(model_path)
        .canonicalize()
        .map_err(|e| io_err("Couldn't read model metadata", &e))?;

    if target.starts_with(&root_canon) && target != root_canon {
        let final_check = target
            .canonicalize()
            .map_err(|e| io_err("Couldn't re-read model metadata", &e))?;
        if final_check != target
            || !final_check.starts_with(&root_canon)
            || final_check == root_canon
        {
            return Err("Model path changed during validation — aborting".to_string());
        }
        imported_model_from_path(&root_canon, &final_check, None)?;
        return Ok(final_check);
    }

    if let Some(stored) = imported.get(&metadata_key(&target)) {
        imported_model_from_path(&root_canon, &target, Some(stored.label.clone()))?;
        return Ok(target);
    }

    Err("Model path is not registered with InkMarshal".to_string())
}

pub(super) fn scan_installed_models_root(root: &Path) -> Result<Vec<InstalledLocalModel>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let metadata = read_installed_metadata(root);
    let imported = read_imported_metadata(root);
    let mut out = Vec::new();
    scan_installed_models_dir(root, root, &metadata, &mut out)?;
    append_imported_models(root, &imported, &mut out)?;
    out.sort_by(|a, b| {
        a.label
            .to_ascii_lowercase()
            .cmp(&b.label.to_ascii_lowercase())
    });
    Ok(out)
}

pub(super) fn scan_installed_models_dir(
    root: &Path,
    dir: &Path,
    metadata: &std::collections::HashMap<String, InstalledModelMetadata>,
    out: &mut Vec<InstalledLocalModel>,
) -> Result<(), String> {
    if is_mlx_model_dir(dir)? && dir != root {
        let meta = metadata.get(&metadata_key(dir));
        out.push(InstalledLocalModel {
            label: meta
                .map(|m| m.label.clone())
                .unwrap_or_else(|| model_label(root, dir)),
            model_path: dir.to_string_lossy().into_owned(),
            format: "mlx".to_string(),
            size_bytes: dir_size(dir)?,
            source_repo: meta.map(|m| m.source_repo.clone()),
            source_filename: None,
            installed_at_unix: meta.map(|m| m.installed_at_unix),
            managed_by_app: true,
        });
        return Ok(());
    }

    let entries =
        std::fs::read_dir(dir).map_err(|e| io_err("Couldn't read the model folder", &e))?;
    for entry in entries {
        let entry = entry.map_err(|e| io_err("Couldn't read the model folder", &e))?;
        let path = entry.path();
        let ftype = entry
            .file_type()
            .map_err(|e| io_err("Couldn't read model metadata", &e))?;
        if ftype.is_symlink() {
            continue;
        }
        if ftype.is_dir() {
            if is_snapshot_temp_dir(&path) {
                continue;
            }
            scan_installed_models_dir(root, &path, metadata, out)?;
        } else if ftype.is_file()
            && path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("gguf"))
                .unwrap_or(false)
        {
            let stored = metadata.get(&metadata_key(&path));
            out.push(InstalledLocalModel {
                label: stored.map(|m| m.label.clone()).unwrap_or_else(|| {
                    path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("GGUF model")
                        .to_string()
                }),
                model_path: path.to_string_lossy().into_owned(),
                format: "gguf".to_string(),
                size_bytes: entry
                    .metadata()
                    .map_err(|e| io_err("Couldn't read model metadata", &e))?
                    .len(),
                source_repo: stored.map(|m| m.source_repo.clone()),
                source_filename: if stored.is_some() {
                    managed_source_filename(root, &path)
                } else {
                    None
                },
                installed_at_unix: stored.map(|m| m.installed_at_unix),
                managed_by_app: true,
            });
        }
    }
    Ok(())
}

pub(super) fn metadata_key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

pub(super) fn read_installed_metadata(
    root: &Path,
) -> std::collections::HashMap<String, InstalledModelMetadata> {
    let Ok(db) = crate::metadata_db::open_for(root) else {
        return std::collections::HashMap::new();
    };
    db.list_installed()
        .map(|map| {
            map.into_iter()
                .map(|(k, rec)| {
                    (
                        k,
                        InstalledModelMetadata {
                            label: rec.label,
                            source_repo: rec.source_repo,
                            format: rec.format,
                            installed_at_unix: rec.installed_at_unix,
                        },
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Test/maintenance helper — replaces the entire installed-models table with
/// the supplied map. Production code paths use [`upsert_installed_metadata`] /
/// [`remove_installed_metadata`] for single-row mutations.
#[allow(dead_code)]
pub(super) fn write_installed_metadata(
    root: &Path,
    metadata: &std::collections::HashMap<String, InstalledModelMetadata>,
) -> Result<(), String> {
    let db = crate::metadata_db::open_for(root)?;
    let existing = db.list_installed()?;
    for key in existing.keys() {
        if !metadata.contains_key(key) {
            db.remove_installed(key)?;
        }
    }
    for (key, m) in metadata {
        db.upsert_installed(
            key,
            &crate::metadata_db::InstalledRecord {
                label: m.label.clone(),
                source_repo: m.source_repo.clone(),
                format: m.format.clone(),
                installed_at_unix: m.installed_at_unix,
            },
        )?;
    }
    Ok(())
}

pub(super) fn upsert_installed_metadata(
    app: &tauri::AppHandle,
    model_path: &str,
    metadata: InstalledModelMetadata,
) -> Result<(), String> {
    let root = model_dir_for(app)?;
    let db = crate::metadata_db::open_for(&root)?;
    db.upsert_installed(
        model_path,
        &crate::metadata_db::InstalledRecord {
            label: metadata.label,
            source_repo: metadata.source_repo,
            format: metadata.format,
            installed_at_unix: metadata.installed_at_unix,
        },
    )
}

pub(super) fn remove_installed_metadata(
    app: &tauri::AppHandle,
    model_path: &str,
) -> Result<(), String> {
    let root = model_dir_for(app)?;
    let db = crate::metadata_db::open_for(&root)?;
    db.remove_installed(model_path)
}

pub(super) fn read_imported_metadata(
    root: &Path,
) -> std::collections::HashMap<String, ImportedModelMetadata> {
    let Ok(db) = crate::metadata_db::open_for(root) else {
        return std::collections::HashMap::new();
    };
    db.list_imported()
        .map(|map| {
            map.into_iter()
                .map(|(k, rec)| {
                    (
                        k,
                        ImportedModelMetadata {
                            label: rec.label,
                            format: rec.format,
                            imported_at_unix: rec.imported_at_unix,
                        },
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn write_imported_metadata(
    root: &Path,
    metadata: &std::collections::HashMap<String, ImportedModelMetadata>,
) -> Result<(), String> {
    let db = crate::metadata_db::open_for(root)?;
    let existing = db.list_imported()?;
    for key in existing.keys() {
        if !metadata.contains_key(key) {
            let _ = db.remove_imported(key);
        }
    }
    for (key, m) in metadata {
        db.upsert_imported(
            key,
            &crate::metadata_db::ImportedRecord {
                label: m.label.clone(),
                format: m.format.clone(),
                imported_at_unix: m.imported_at_unix,
            },
        )?;
    }
    Ok(())
}

pub(super) fn remove_imported_metadata(
    app: &tauri::AppHandle,
    model_path: &str,
) -> Result<(), String> {
    let root = model_dir_for(app)?;
    let target = PathBuf::from(model_path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(model_path));
    let db = crate::metadata_db::open_for(&root)?;
    db.remove_imported(&metadata_key(&target))
}

pub(super) fn append_imported_models(
    root: &Path,
    metadata: &std::collections::HashMap<String, ImportedModelMetadata>,
    out: &mut Vec<InstalledLocalModel>,
) -> Result<(), String> {
    for (path, stored) in metadata {
        let target = PathBuf::from(path);
        if !target.exists() || out.iter().any(|m| m.model_path == *path) {
            continue;
        }
        if let Ok(model) = imported_model_from_path(root, &target, Some(stored.label.clone())) {
            out.push(InstalledLocalModel {
                installed_at_unix: Some(stored.imported_at_unix),
                ..model
            });
        }
    }
    Ok(())
}

pub(super) fn imported_model_from_path(
    root: &Path,
    path: &Path,
    label: Option<String>,
) -> Result<InstalledLocalModel, String> {
    let meta = std::fs::metadata(path).map_err(|e| io_err("Couldn't read model metadata", &e))?;
    let clean_label = label.as_deref().and_then(clean_model_label);
    if meta.is_file()
        && path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("gguf"))
            .unwrap_or(false)
    {
        validate_gguf_file(path)?;
        return Ok(InstalledLocalModel {
            label: clean_label.unwrap_or_else(|| {
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("GGUF model")
                    .to_string()
            }),
            model_path: path.to_string_lossy().into_owned(),
            format: "gguf".to_string(),
            size_bytes: meta.len(),
            source_repo: None,
            source_filename: None,
            installed_at_unix: Some(current_unix()),
            managed_by_app: path.starts_with(root),
        });
    }
    if meta.is_dir() && is_mlx_model_dir(path)? {
        return Ok(InstalledLocalModel {
            label: clean_label.unwrap_or_else(|| model_label(root, path)),
            model_path: path.to_string_lossy().into_owned(),
            format: "mlx".to_string(),
            size_bytes: dir_size(path)?,
            source_repo: None,
            source_filename: None,
            installed_at_unix: Some(current_unix()),
            managed_by_app: path.starts_with(root),
        });
    }
    Err(
        "Choose a .gguf file or an MLX model folder with config.json, tokenizer.json, and root safetensors weights"
            .to_string(),
    )
}

pub(super) fn clean_model_label(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_MODEL_LABEL_BYTES
        || trimmed.chars().any(char::is_control)
    {
        return None;
    }
    Some(trimmed.to_string())
}

pub(super) fn managed_source_filename(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

pub(super) fn validate_gguf_file(path: &Path) -> Result<(), String> {
    use std::io::Read;

    let mut file =
        std::fs::File::open(path).map_err(|e| io_err("Couldn't read the model file", &e))?;
    let mut magic = [0_u8; 4];
    file.read_exact(&mut magic)
        .map_err(|e| io_err("Couldn't read the model file", &e))?;
    if magic != *b"GGUF" {
        return Err("Choose a valid GGUF model file".to_string());
    }
    Ok(())
}

pub(super) fn is_mlx_model_dir(dir: &Path) -> Result<bool, String> {
    if !dir.join("config.json").is_file() || !dir.join("tokenizer.json").is_file() {
        return Ok(false);
    }
    let entries =
        std::fs::read_dir(dir).map_err(|e| io_err("Couldn't read the model folder", &e))?;
    for entry in entries {
        let entry = entry.map_err(|e| io_err("Couldn't read the model folder", &e))?;
        let path = entry.path();
        let ftype = entry
            .file_type()
            .map_err(|e| io_err("Couldn't read model metadata", &e))?;
        if ftype.is_symlink() {
            continue;
        }
        if ftype.is_file()
            && path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("safetensors"))
                .unwrap_or(false)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn dir_size(dir: &Path) -> Result<u64, String> {
    let mut total = 0;
    let entries =
        std::fs::read_dir(dir).map_err(|e| io_err("Couldn't read the model folder", &e))?;
    for entry in entries {
        let entry = entry.map_err(|e| io_err("Couldn't read the model folder", &e))?;
        let path = entry.path();
        let ftype = entry
            .file_type()
            .map_err(|e| io_err("Couldn't read model metadata", &e))?;
        if ftype.is_symlink() {
            continue;
        }
        if ftype.is_dir() {
            total += dir_size(&path)?;
        } else if ftype.is_file() {
            total += entry
                .metadata()
                .map_err(|e| io_err("Couldn't read model metadata", &e))?
                .len();
        }
    }
    Ok(total)
}

pub(super) fn model_label(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .and_then(|p| p.components().next())
        .and_then(|c| match c {
            std::path::Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .unwrap_or_else(|| {
            path.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("MLX model")
        })
        .replace('_', "/")
}
