//! Managed-model-folder path math: every download/snapshot destination is
//! validated to stay inside the canonical models root (no symlink/.. escape),
//! plus disk-space probing and OS reveal.

use super::current_unix;
use crate::http_util::io_err;
use crate::inkmarshal_home;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Free bytes available on the filesystem holding the models dir
/// (`~/.inkmarshal/app/models`). The dir is created if missing so the caller can
/// pre-flight a download's disk requirement. macOS/Linux use `libc::statvfs`;
/// Windows uses `GetDiskFreeSpaceExW`. No new dependency added (libc is already
/// a unix dep; the Windows path uses raw FFI via `std`/`libc`-free linking is
/// not possible, so a tiny `#[cfg(windows)]` extern block is used).
#[tauri::command]
pub fn model_dir_free_bytes(app: tauri::AppHandle) -> Result<u64, String> {
    let models_dir = model_dir_for(&app)?;
    std::fs::create_dir_all(&models_dir)
        .map_err(|e| io_err("Couldn't prepare the models folder", &e))?;
    free_bytes_for(&models_dir)
}

pub(crate) fn model_dir_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(custom) = read_custom_model_dir(app)? {
        return Ok(custom);
    }
    default_model_dir_for(app)
}

pub(super) fn default_model_dir_for(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = inkmarshal_home::inkmarshal_app_dir()?;
    Ok(app_data.join("models"))
}

fn model_dir_settings_path(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = inkmarshal_home::inkmarshal_app_dir()?;
    Ok(app_data.join("model-root.txt"))
}

fn read_custom_model_dir(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let path = model_dir_settings_path(app)?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(value) => value,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(io_err("Couldn't read the model folder setting", &err)),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    resolve_existing_model_dir_path(Path::new(trimmed)).map(Some)
}

pub(super) fn validate_model_dir_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || has_parent_component(path) {
        return Err("Model folder must be an absolute folder path".to_string());
    }
    std::fs::create_dir_all(path).map_err(|e| io_err("Couldn't prepare the models folder", &e))?;
    let meta = std::fs::symlink_metadata(path)
        .map_err(|e| io_err("Couldn't inspect the models folder", &e))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("Model folder must be a real directory".to_string());
    }
    ensure_model_dir_writable(path)?;
    path.canonicalize()
        .map_err(|e| io_err("Couldn't read the model folder", &e))
}

fn resolve_existing_model_dir_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || has_parent_component(path) {
        return Err("Model folder must be an absolute folder path".to_string());
    }
    let meta = std::fs::symlink_metadata(path)
        .map_err(|e| io_err("Couldn't inspect the models folder", &e))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("Model folder must be a real directory".to_string());
    }
    ensure_model_dir_writable(path)?;
    path.canonicalize()
        .map_err(|e| io_err("Couldn't read the model folder", &e))
}

fn ensure_model_dir_writable(path: &Path) -> Result<(), String> {
    let probe = path.join(format!(
        ".inkmarshal-write-test-{}-{}",
        std::process::id(),
        current_unix()
    ));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(err) => Err(io_err("Model folder is not writable", &err)),
    }
}

#[tauri::command]
pub fn set_model_dir(app: tauri::AppHandle, model_dir: String) -> Result<String, String> {
    let canonical = validate_model_dir_path(Path::new(model_dir.trim()))?;
    let settings_path = model_dir_settings_path(&app)?;
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| io_err("Couldn't prepare the app settings folder", &e))?;
    }
    std::fs::write(&settings_path, canonical.to_string_lossy().as_bytes())
        .map_err(|e| io_err("Couldn't save the model folder setting", &e))?;
    Ok(canonical.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn reset_model_dir(app: tauri::AppHandle) -> Result<String, String> {
    let settings_path = model_dir_settings_path(&app)?;
    match std::fs::remove_file(&settings_path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(io_err("Couldn't reset the model folder setting", &err)),
    }
    let default_dir = default_model_dir_for(&app)?;
    Ok(default_dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn reveal_model_dir(app: tauri::AppHandle) -> Result<(), String> {
    let models_dir = model_dir_for(&app)?;
    std::fs::create_dir_all(&models_dir)
        .map_err(|e| io_err("Couldn't prepare the models folder", &e))?;
    reveal_path(&models_dir)
}

pub(super) fn canonical_model_root(root: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(root).map_err(|e| io_err("Couldn't prepare the models folder", &e))?;
    root.canonicalize()
        .map_err(|e| io_err("Couldn't read the model folder", &e))
}

pub(super) fn managed_relative_path(
    root: &Path,
    root_canon: &Path,
    dest: &Path,
    err: &str,
) -> Result<PathBuf, String> {
    if !dest.is_absolute() || has_parent_component(dest) {
        return Err(err.to_string());
    }
    let rel = dest
        .strip_prefix(root)
        .or_else(|_| dest.strip_prefix(root_canon))
        .map_err(|_| err.to_string())?;
    if rel.as_os_str().is_empty() {
        return Err(err.to_string());
    }
    if rel
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(err.to_string());
    }
    Ok(rel.to_path_buf())
}

pub(super) fn create_managed_dir_all(
    root_canon: &Path,
    rel: &Path,
    err: &str,
) -> Result<PathBuf, String> {
    if rel.as_os_str().is_empty() {
        return Ok(root_canon.to_path_buf());
    }
    let mut current = root_canon.to_path_buf();
    for component in rel.components() {
        let std::path::Component::Normal(part) = component else {
            return Err(err.to_string());
        };
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(md) => {
                if md.file_type().is_symlink() {
                    return Err(err.to_string());
                }
                if !md.is_dir() {
                    return Err(err.to_string());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current)
                    .map_err(|e| io_err("Couldn't create the model folder", &e))?;
                let md = std::fs::symlink_metadata(&current)
                    .map_err(|e| io_err("Couldn't inspect the model folder", &e))?;
                if md.file_type().is_symlink() || !md.is_dir() {
                    return Err(err.to_string());
                }
            }
            Err(e) => return Err(io_err("Couldn't inspect the model folder", &e)),
        }
        let current_canon = current
            .canonicalize()
            .map_err(|e| io_err("Couldn't read the model folder", &e))?;
        if !current_canon.starts_with(root_canon) {
            return Err(err.to_string());
        }
    }
    current
        .canonicalize()
        .map_err(|e| io_err("Couldn't read the model folder", &e))
}

pub(super) fn managed_download_dir(root: &Path, dest_dir: &str) -> Result<PathBuf, String> {
    let root_canon = canonical_model_root(root)?;
    let dest = PathBuf::from(dest_dir);
    let rel = managed_relative_path(
        root,
        &root_canon,
        &dest,
        "Model download destination is outside the managed model folder",
    )?;
    create_managed_dir_all(
        &root_canon,
        &rel,
        "Model download destination is outside the managed model folder",
    )
}

pub(super) fn managed_snapshot_destination_dir(
    root: &Path,
    dest_dir: &str,
) -> Result<PathBuf, String> {
    let root_canon = canonical_model_root(root)?;
    let dest = PathBuf::from(dest_dir);
    let rel = managed_relative_path(
        root,
        &root_canon,
        &dest,
        "Model download destination is outside the managed model folder",
    )?;
    let folder_name = rel
        .file_name()
        .ok_or_else(|| "Model snapshot destination must include a folder name".to_string())?;
    let parent = rel
        .parent()
        .ok_or_else(|| "Model snapshot destination must include a parent folder".to_string())?;
    let parent_canon = create_managed_dir_all(
        &root_canon,
        parent,
        "Model download destination is outside the managed model folder",
    )?;
    Ok(parent_canon.join(folder_name))
}

pub(super) fn managed_download_file_path(
    root: &Path,
    dest_path: &str,
    required_extension: Option<&str>,
) -> Result<PathBuf, String> {
    let root_canon = canonical_model_root(root)?;
    let dest = PathBuf::from(dest_path);
    let rel = managed_relative_path(
        root,
        &root_canon,
        &dest,
        "Model download destination must be inside the managed model folder",
    )?;
    if let Some(ext) = required_extension {
        let ok = rel
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case(ext))
            .unwrap_or(false);
        if !ok {
            return Err(format!("Model download destination must be a .{ext} file"));
        }
    }
    let file_name = rel
        .file_name()
        .ok_or_else(|| "Model download destination must include a file name".to_string())?;
    let parent = rel
        .parent()
        .ok_or_else(|| "Model download destination must include a parent folder".to_string())?;
    let parent_canon = create_managed_dir_all(
        &root_canon,
        parent,
        "Model download destination is outside the managed model folder",
    )?;
    Ok(parent_canon.join(file_name))
}

pub(super) fn has_parent_component(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
}

pub(super) fn repo_file_relative_path(filename: &str) -> Result<PathBuf, String> {
    let path = Path::new(filename);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(part) => out.push(part),
            _ => {
                return Err(
                    "Model snapshot file path is outside the selected repository".to_string(),
                )
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err("Model snapshot file path is empty".to_string());
    }
    Ok(out)
}

pub(super) fn managed_snapshot_file_path(
    dest_root: &Path,
    filename: &str,
) -> Result<PathBuf, String> {
    let dest_root_canon = dest_root
        .canonicalize()
        .map_err(|e| io_err("Couldn't read the model folder", &e))?;
    let relative = repo_file_relative_path(filename)?;
    let dest_path = dest_root_canon.join(relative);
    let file_name = dest_path
        .file_name()
        .ok_or_else(|| "Model snapshot file path must include a file name".to_string())?;
    let parent = dest_path
        .parent()
        .ok_or_else(|| "Model snapshot file path must include a parent folder".to_string())?;
    let parent_rel = parent
        .strip_prefix(&dest_root_canon)
        .map_err(|_| "Model snapshot file path is outside the selected repository".to_string())?;
    let parent_canon = create_managed_dir_all(
        &dest_root_canon,
        parent_rel,
        "Model snapshot file path is outside the selected repository",
    )?;
    Ok(parent_canon.join(file_name))
}

/// Deterministic, resumable checkpoint directory for a multi-file snapshot
/// download. Unlike a per-process temp dir, the name is STABLE across app
/// restarts and repeated download tasks — it is keyed by `key` (a hash of the
/// repo id + file list), so a cancelled or interrupted snapshot resumes into the
/// same partially-downloaded folder instead of starting over (MM-01). A changed
/// file set (new revision) hashes to a different key, so incompatible checkpoints
/// never mix. Keeps the `.download-` marker so the 72h orphan sweep still GCs
/// abandoned checkpoints.
pub(super) fn snapshot_checkpoint_dir(final_root: &Path, key: &str) -> Result<PathBuf, String> {
    let parent = final_root
        .parent()
        .ok_or_else(|| "Model snapshot destination must include a parent folder".to_string())?;
    let name = final_root
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Model snapshot destination must include a folder name".to_string())?;
    Ok(parent.join(format!(".{name}.download-ckpt-{key}")))
}

pub(super) fn is_snapshot_temp_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.starts_with('.') && s.contains(".download-"))
        .unwrap_or(false)
}

pub(super) fn reveal_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map_err(|e| io_err("Couldn't reveal the model in Finder", &e))?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|e| io_err("Couldn't reveal the model in Explorer", &e))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let folder = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        Command::new("xdg-open")
            .arg(folder)
            .spawn()
            .map_err(|e| io_err("Couldn't reveal the model folder", &e))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Reveal is not supported on this platform".to_string())
}

#[cfg(unix)]
pub(super) fn free_bytes_for(path: &Path) -> Result<u64, String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes())
        .map_err(|e| format!("Invalid path for statvfs: {e}"))?;
    // SAFETY: `stat` is zero-initialized and only read after a success (0) rc;
    // `c_path` is a valid NUL-terminated C string for the duration of the call.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if rc != 0 {
        return Err(format!(
            "statvfs failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // Available blocks to an unprivileged process * fragment size.
    let frsize = if stat.f_frsize != 0 {
        stat.f_frsize as u64
    } else {
        stat.f_bsize as u64
    };
    Ok(stat.f_bavail as u64 * frsize)
}

#[cfg(windows)]
pub(super) fn free_bytes_for(path: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;

    // GetDiskFreeSpaceExW takes a directory path; pass the models dir directly.
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);

    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            lpDirectoryName: *const u16,
            lpFreeBytesAvailableToCaller: *mut u64,
            lpTotalNumberOfBytes: *mut u64,
            lpTotalNumberOfFreeBytes: *mut u64,
        ) -> i32;
    }

    let mut free_to_caller: u64 = 0;
    let mut total: u64 = 0;
    let mut total_free: u64 = 0;
    // SAFETY: `wide` is a valid NUL-terminated UTF-16 path; the three out
    // pointers are valid for the duration of the call.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_to_caller,
            &mut total,
            &mut total_free,
        )
    };
    if ok == 0 {
        return Err(format!(
            "GetDiskFreeSpaceExW failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(free_to_caller)
}

#[cfg(not(any(unix, windows)))]
pub(super) fn free_bytes_for(_path: &Path) -> Result<u64, String> {
    Err("Disk-space query is not supported on this platform".to_string())
}
