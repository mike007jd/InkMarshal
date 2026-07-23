//! Process-launch primitives: free-port pick, bundled-binary resolution, env
//! allowlist + macOS loader env, engine-id derivation, and the Windows job
//! object that ties the engine's process tree to the app.

use super::EngineFormat;
use std::ffi::OsString;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::process::Child;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub(super) const ENGINE_ENV_PASSTHROUGH: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "XDG_DATA_HOME",
];

pub(super) const MAX_ENGINE_LABEL_BYTES: usize = 80;

pub(super) fn format_wire(format: EngineFormat) -> &'static str {
    match format {
        EngineFormat::Gguf => "gguf",
        EngineFormat::Mlx => "mlx",
    }
}

#[cfg(windows)]
#[derive(Debug)]
pub(super) struct WindowsJob {
    handle: HANDLE,
}

#[cfg(windows)]
unsafe impl Send for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    pub(super) fn new() -> Result<Self, String> {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(format!(
                    "Cannot create Windows engine job object: {}",
                    std::io::Error::last_os_error()
                ));
            }

            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                let err = std::io::Error::last_os_error();
                CloseHandle(handle);
                return Err(format!("Cannot configure Windows engine job object: {err}"));
            }

            Ok(Self { handle })
        }
    }

    pub(super) fn assign_child(&self, child: &Child) -> Result<(), String> {
        unsafe {
            let process = child.as_raw_handle() as HANDLE;
            let ok = AssignProcessToJobObject(self.handle, process);
            if ok == 0 {
                return Err(format!(
                    "Cannot assign engine process to Windows job object: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        }
    }

    pub(super) fn terminate(&self) {
        unsafe {
            let _ = TerminateJobObject(self.handle, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

pub(super) fn pick_free_port() -> Result<u16, String> {
    let l = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Cannot bind a local port: {e}"))?;
    l.local_addr()
        .map(|a| a.port())
        .map_err(|e| format!("Cannot read assigned port: {e}"))
}

pub(super) fn engine_binary_path(
    app: &tauri::AppHandle,
    format: EngineFormat,
) -> Result<PathBuf, String> {
    let res = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Cannot resolve resource dir: {e}"))?;
    let target = if cfg!(target_os = "macos") {
        "aarch64-apple-darwin"
    } else if cfg!(target_os = "windows") {
        "x86_64-pc-windows-msvc"
    } else {
        "x86_64-unknown-linux-gnu"
    };
    let dir = res.join("engines").join(target);
    let bin = match format {
        EngineFormat::Gguf => {
            if cfg!(windows) {
                "llama-server.exe"
            } else {
                "llama-server"
            }
        }
        EngineFormat::Mlx => {
            if cfg!(target_os = "macos") {
                "mlx-server"
            } else {
                return Err("MLX models run on macOS only".to_string());
            }
        }
    };
    let path = dir.join(bin);
    if !path.exists() {
        return Err(format!("Bundled engine missing: {}", path.display()));
    }
    Ok(path)
}

/// Build the single current registry-key shape:
/// `"{fmt}:v2:{escaped_path}"` with an optional `#{escaped_label}` suffix.
pub fn make_engine_id(format: EngineFormat, path: &str, label: &Option<String>) -> String {
    let fmt = format_wire(format);
    match label {
        Some(l) if !l.is_empty() => {
            format!(
                "{fmt}:v2:{}#{}",
                encode_engine_id_component(path),
                encode_engine_id_component(l)
            )
        }
        _ => format!("{fmt}:v2:{}", encode_engine_id_component(path)),
    }
}

pub(super) fn encode_engine_id_component(input: &str) -> String {
    use std::fmt::Write as _;

    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'%' | b'#' | b':' | b'\r' | b'\n' => {
                let _ = write!(&mut out, "%{byte:02X}");
            }
            0x20..=0x7e => out.push(byte as char),
            _ => {
                let _ = write!(&mut out, "%{byte:02X}");
            }
        }
    }
    out
}

pub(super) fn normalize_engine_label(label: Option<String>) -> Result<Option<String>, String> {
    let Some(label) = label else {
        return Ok(None);
    };
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > MAX_ENGINE_LABEL_BYTES || trimmed.chars().any(char::is_control) {
        return Err(format!(
            "Engine label must be non-control text up to {MAX_ENGINE_LABEL_BYTES} bytes"
        ));
    }
    Ok(Some(trimmed.to_string()))
}

pub(super) fn engine_env_allows(key: &str) -> bool {
    ENGINE_ENV_PASSTHROUGH.contains(&key)
}

pub(super) fn engine_loader_env(bin: &Path) -> Vec<(&'static str, OsString)> {
    let mut envs = Vec::new();
    #[cfg(target_os = "macos")]
    if let Some(engine_dir) = bin.parent() {
        let engine_dir = engine_dir.as_os_str().to_os_string();
        envs.push(("DYLD_LIBRARY_PATH", engine_dir.clone()));
        envs.push(("DYLD_FALLBACK_LIBRARY_PATH", engine_dir));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = bin;
    envs
}

pub(super) fn apply_engine_env_allowlist(cmd: &mut Command, bin: &Path) {
    cmd.env_clear();
    for key in ENGINE_ENV_PASSTHROUGH {
        if !engine_env_allows(key) {
            continue;
        }
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    for (key, value) in engine_loader_env(bin) {
        cmd.env(key, value);
    }
}
