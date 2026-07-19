use serde::{Deserialize, Serialize};
use std::{
    net::{TcpListener, TcpStream, ToSocketAddrs},
    sync::Mutex,
    time::Duration,
};
use tauri::webview::{cookie::SameSite, Cookie};
use tauri::{Emitter, EventTarget, Manager, RunEvent, WindowEvent};

#[cfg(not(debug_assertions))]
use std::fs;

#[cfg(any(test, not(debug_assertions)))]
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
};

mod app_menu;
mod engine;
mod health;
mod http_util;
mod inkmarshal_home;
mod metadata_db;
mod model_manager;
mod secret;
mod vault;

use model_manager::DownloadRegistry;

// The desktop frontend is the bundled Next standalone server. We never hard-code
// the port any more (see `pick_runtime_port`): the actual port is resolved at
// startup and threaded through to the webview navigation URL.
const RUNTIME_HOST: &str = "127.0.0.1";
#[cfg(debug_assertions)]
const DEV_SERVER_PORT: u16 = 1420;
const PREFERRED_PORT: u16 = 1421;
const FALLBACK_PORT: u16 = 1422;
/// Fixed runtime-port candidates, tried in order. MUST stay in lockstep with the
/// `remote.urls` allowlist in `capabilities/default.json`: capability auth and
/// the localStorage origin both key on the exact port, so a port missing there
/// loses IPC permission and a stable storage origin. Add a candidate here → add
/// the matching `http://127.0.0.1:<port>` there.
const RUNTIME_PORT_CANDIDATES: &[u16] = &[PREFERRED_PORT, FALLBACK_PORT];
const RUNTIME_PATH: &str = "/desktop-studio";
const DESKTOP_SESSION_COOKIE: &str = "inkmarshal_desktop_session";
#[cfg(any(test, not(debug_assertions)))]
const DESKTOP_RUNTIME_ENV_PASSTHROUGH: &[&str] = &[
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
    "INKMARSHAL_HOME",
];

/// Holds the child `node` process plus its OS process-group id so that we can
/// terminate the *entire* group on shutdown (a bare `child.kill()` leaves any
/// grandchildren — e.g. Next worker processes — orphaned and holding the port).
#[cfg(any(test, not(debug_assertions)))]
struct NextRuntime {
    child: Mutex<Option<Child>>,
    pgid: Mutex<Option<i32>>,
}

#[cfg(any(test, not(debug_assertions)))]
impl NextRuntime {
    fn new(child: Option<Child>, pgid: Option<i32>) -> Self {
        Self {
            child: Mutex::new(child),
            pgid: Mutex::new(pgid),
        }
    }

    fn replace(&self, child: Option<Child>, pgid: Option<i32>) {
        terminate_runtime_inner(self);
        if let Ok(mut guard) = self.child.lock() {
            *guard = child;
        }
        if let Ok(mut guard) = self.pgid.lock() {
            *guard = pgid;
        }
    }

    #[cfg(test)]
    fn has_child_for_test(&self) -> bool {
        self.child
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }
}

#[cfg(any(test, not(debug_assertions)))]
impl Drop for NextRuntime {
    fn drop(&mut self) {
        terminate_runtime_inner(self);
    }
}

#[cfg(any(test, not(debug_assertions)))]
fn terminate_runtime_inner(runtime: &NextRuntime) {
    // Kill the whole process group first so Next worker children die too.
    if let Ok(mut guard) = runtime.pgid.lock() {
        if let Some(pgid) = guard.take() {
            kill_process_group(pgid);
        }
    }
    if let Ok(mut guard) = runtime.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(not(debug_assertions))]
fn terminate_next_runtime(app: &tauri::AppHandle) {
    if let Some(runtime) = app.try_state::<NextRuntime>() {
        terminate_runtime_inner(&runtime);
    }
}

#[cfg(not(debug_assertions))]
fn install_next_runtime(app: &tauri::AppHandle, child: Child, pgid: Option<i32>) {
    if let Some(runtime) = app.try_state::<NextRuntime>() {
        runtime.replace(Some(child), pgid);
    } else {
        app.manage(NextRuntime::new(Some(child), pgid));
    }
}

#[cfg(debug_assertions)]
fn terminate_next_runtime(_app: &tauri::AppHandle) {}

/// SIGTERM then SIGKILL the process group (negative pid == the group).
#[cfg(all(unix, any(test, not(debug_assertions))))]
fn kill_process_group(pgid: i32) {
    unsafe {
        libc::killpg(pgid, libc::SIGTERM);
    }
    thread::sleep(Duration::from_millis(300));
    unsafe {
        libc::killpg(pgid, libc::SIGKILL);
    }
}

#[cfg(all(not(unix), any(test, not(debug_assertions))))]
fn kill_process_group(_pgid: i32) {
    // On non-unix the child handle's kill() is the best we can do here.
}

#[derive(Debug, Serialize)]
struct DesktopStatus {
    desktop: bool,
    platform: String,
    arch: String,
    total_memory_bytes: Option<u64>,
    app_data_dir: Option<String>,
    model_dir: Option<String>,
    model_dir_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimeProbeInput {
    id: String,
    name: String,
    url: String,
}

#[derive(Debug, Serialize)]
struct RuntimeProbeResult {
    id: String,
    name: String,
    url: String,
    reachable: bool,
    message: String,
}

#[cfg_attr(debug_assertions, allow(dead_code))]
struct StartedRuntime {
    port: u16,
    desktop_session_token: Option<String>,
}

fn path_to_string(path: std::path::PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

#[tauri::command]
fn desktop_status(app: tauri::AppHandle) -> DesktopStatus {
    let app_data_dir = inkmarshal_home::inkmarshal_app_dir().ok();
    let (model_dir, model_dir_error) = match model_manager::model_dir_for(&app) {
        Ok(dir) => (Some(dir), None),
        Err(err) => (None, Some(err)),
    };

    DesktopStatus {
        desktop: true,
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        total_memory_bytes: system_memory_bytes(),
        app_data_dir: app_data_dir.map(path_to_string),
        model_dir: model_dir.map(path_to_string),
        model_dir_error,
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn system_memory_bytes() -> Option<u64> {
    use std::ffi::CString;
    let name = CString::new("hw.memsize").ok()?;
    let mut value: u64 = 0;
    let mut len = std::mem::size_of::<u64>();
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            &mut value as *mut _ as *mut libc::c_void,
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc == 0 {
        Some(value)
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn system_memory_bytes() -> Option<u64> {
    let raw = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kb = raw
        .lines()
        .find_map(|line| line.strip_prefix("MemTotal:"))?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    Some(kb * 1024)
}

#[cfg(target_os = "windows")]
pub(crate) fn system_memory_bytes() -> Option<u64> {
    #[repr(C)]
    struct MemoryStatusEx {
        dw_length: u32,
        dw_memory_load: u32,
        ull_total_phys: u64,
        ull_avail_phys: u64,
        ull_total_page_file: u64,
        ull_avail_page_file: u64,
        ull_total_virtual: u64,
        ull_avail_virtual: u64,
        ull_avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(lp_buffer: *mut MemoryStatusEx) -> i32;
    }
    let mut status = MemoryStatusEx {
        dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
        dw_memory_load: 0,
        ull_total_phys: 0,
        ull_avail_phys: 0,
        ull_total_page_file: 0,
        ull_avail_page_file: 0,
        ull_total_virtual: 0,
        ull_avail_virtual: 0,
        ull_avail_extended_virtual: 0,
    };
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    if ok != 0 {
        Some(status.ull_total_phys)
    } else {
        None
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub(crate) fn system_memory_bytes() -> Option<u64> {
    None
}

fn probe_socket(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|err| format!("Invalid URL: {err}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("Runtime probe URL must use http or https".to_string()),
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Missing host".to_string())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "Missing port".to_string())?;
    let mut addrs = (host, port)
        .to_socket_addrs()
        .map_err(|err| format!("Cannot resolve {host}:{port}: {err}"))?;
    let addr = addrs
        .next()
        .ok_or_else(|| format!("No socket address for {host}:{port}"))?;
    if !addr.ip().is_loopback() {
        return Err("Runtime probe URL must resolve to a loopback address".to_string());
    }

    TcpStream::connect_timeout(&addr, Duration::from_millis(800))
        .map(|_| ())
        .map_err(|err| format!("{host}:{port} unreachable: {err}"))
}

/// Pick the runtime port from a FIXED candidate set (1421, then 1422). We never
/// fall back to an OS-random port: the port is part of the webview origin, so a
/// random port would (a) fall outside the capability `remote.urls` allowlist and
/// lose IPC permission, and (b) mint a brand-new localStorage origin. (Durable
/// config now lives in SQLite — see lib/app-settings-client.ts — but capability
/// auth still hard-requires a known port.) If every candidate is busy we return a
/// hard error that surfaces the retry page instead of silently degrading.
/// `kill_orphan_runtimes` already reaped our own stale node before this runs, so
/// a busy candidate means a genuinely foreign occupant.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn pick_runtime_port() -> Result<u16, String> {
    for &port in RUNTIME_PORT_CANDIDATES {
        if TcpListener::bind((RUNTIME_HOST, port)).is_ok() {
            return Ok(port);
        }
    }
    Err(format!(
        "InkMarshal runtime ports are all busy ({}). Another instance may be \
         running, or a stale process is holding the port — quit it and retry.",
        RUNTIME_PORT_CANDIDATES
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

#[cfg_attr(debug_assertions, allow(dead_code))]
fn runtime_origin(port: u16) -> String {
    format!("http://{RUNTIME_HOST}:{port}")
}

fn runtime_url(port: u16) -> String {
    format!("http://{RUNTIME_HOST}:{port}{RUNTIME_PATH}")
}

#[cfg(test)]
fn desktop_runtime_env_allows(key: &str) -> bool {
    DESKTOP_RUNTIME_ENV_PASSTHROUGH.contains(&key)
}

#[cfg(not(debug_assertions))]
fn generate_desktop_session_token() -> String {
    use rand::RngCore as _;

    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

/// Lowercase-hex SHA-256 of `input`. Used to derive the readiness identity proof
/// from the desktop session token.
#[cfg(any(test, not(debug_assertions)))]
fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;
    let digest = Sha256::digest(input.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

/// Constant-time string comparison so a mismatch position never leaks via timing.
fn secure_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn desktop_session_cookie(token: &str) -> Cookie<'static> {
    Cookie::build((DESKTOP_SESSION_COOKIE, token.to_string()))
        .domain(RUNTIME_HOST.to_string())
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .build()
}

fn replace_and_verify_desktop_session_cookie<SetCookie, ReadCookies>(
    token: &str,
    set_cookie: SetCookie,
    read_cookies: ReadCookies,
) -> Result<(), String>
where
    SetCookie: FnOnce(Cookie<'static>) -> Result<(), String>,
    ReadCookies: FnOnce() -> Result<Vec<Cookie<'static>>, String>,
{
    set_cookie(desktop_session_cookie(token))?;
    // Read the full native store instead of `cookies_for_url`. Wry 0.55 filters
    // that API through `Url::domain()`, which does not represent an IPv4 host
    // consistently and can return an empty result for 127.0.0.1 even though
    // WebKit stored the cookie. We still match only our exact name/domain/path.
    let cookies = read_cookies()?;
    if cookies.iter().any(|cookie| {
        cookie.name() == DESKTOP_SESSION_COOKIE
            && cookie.domain() == Some(RUNTIME_HOST)
            && cookie.path().unwrap_or("/") == "/"
            && secure_eq(cookie.value(), token)
    }) {
        Ok(())
    } else {
        Err(
            "The desktop session cookie could not be verified in the WebView cookie store"
                .to_string(),
        )
    }
}

fn install_desktop_session_cookie(app: &tauri::AppHandle, token: &str) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is missing".to_string())?;
    replace_and_verify_desktop_session_cookie(
        token,
        |cookie| window.set_cookie(cookie).map_err(|err| err.to_string()),
        || window.cookies().map_err(|err| err.to_string()),
    )
}

/// Readiness probe that also proves identity (AN-SEC-001). A bare TCP connect
/// only proves *something* is listening — a local process that pre-empted our
/// fixed loopback port answers TCP just as well, and the old probe would have
/// declared it ready and navigated the webview straight onto the attacker's
/// page (which, being on a capability-trusted origin, could then drive every
/// native command incl. plaintext key reads).
///
/// Instead we GET `/api/health` and require the responder to return
/// `session == sha256(token)`. Only OUR Node sidecar can produce that: the token
/// is handed to it via env and never travels over the wire before readiness
/// passes, so an impostor cannot compute the proof and fails the check. We then
/// show the retry page instead of loading a foreign server. sha256 is one-way,
/// so the proof in the response body cannot leak the session token itself.
#[cfg(any(test, not(debug_assertions)))]
fn probe_runtime_ready(origin: &str, expected_session_sha256: &str) -> Result<(), String> {
    use std::io::{Read as _, Write as _};

    let parsed = url::Url::parse(origin).map_err(|err| format!("Invalid URL: {err}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("Runtime probe URL must use http or https".to_string()),
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Missing host".to_string())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "Missing port".to_string())?;
    let addr = (host, port)
        .to_socket_addrs()
        .map_err(|err| format!("Cannot resolve {host}:{port}: {err}"))?
        .next()
        .ok_or_else(|| format!("No socket address for {host}:{port}"))?;
    if !addr.ip().is_loopback() {
        return Err("Runtime probe URL must resolve to a loopback address".to_string());
    }

    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(800))
        .map_err(|err| format!("{host}:{port} unreachable: {err}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));

    let request = format!(
        "GET /api/health HTTP/1.0\r\nHost: {host}:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("health request failed: {err}"))?;

    // HTTP/1.0 + `Connection: close` → the server closes after the body; the read
    // timeout caps a hung peer and the 64 KiB ceiling caps a rogue streaming one.
    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&chunk[..n]);
                if raw.len() > 64 * 1024 {
                    break;
                }
            }
            Err(err) => return Err(format!("health read failed: {err}")),
        }
    }

    let text = String::from_utf8_lossy(&raw);
    let mut parts = text.splitn(2, "\r\n\r\n");
    let head = parts.next().unwrap_or("");
    let body = parts.next().unwrap_or("").trim();

    let status_line = head.lines().next().unwrap_or("");
    if !status_line.contains(" 200") {
        return Err(format!("health endpoint returned: {status_line}"));
    }

    let json: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("health body not JSON: {err}"))?;
    let session = json.get("session").and_then(|v| v.as_str()).unwrap_or("");
    if !secure_eq(session, expected_session_sha256) {
        return Err(
            "runtime identity proof mismatch — refusing to load a foreign server".to_string(),
        );
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
fn wait_for_next_runtime(origin: &str, expected_session_sha256: &str) -> Result<(), String> {
    let mut last_err = String::from("server did not start");
    for _ in 0..100 {
        match probe_runtime_ready(origin, expected_session_sha256) {
            Ok(()) => return Ok(()),
            Err(err) => last_err = err,
        }
        thread::sleep(Duration::from_millis(120));
    }
    Err(format!(
        "Local studio server did not become ready at {origin}: {last_err}"
    ))
}

// ---------------------------------------------------------------------------
// Startup orchestration
// ---------------------------------------------------------------------------

/// One-shot navigation to a target URL on the main window. Used both for the
/// real runtime URL and for the error page — never scheduled on blind timers.
fn navigate_main(app: &tauri::AppHandle, target: &str) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is missing".to_string())?;
    let url = url::Url::parse(target).map_err(|err| err.to_string())?;
    window.navigate(url).map_err(|err| err.to_string())
}

/// Navigate to the bundled error page with a human-readable message + a Retry
/// button (the page invokes `retry_runtime`). Falls back to a data: URL if the
/// bundled asset is somehow missing so the user is never left on a white screen.
fn show_error_page(app: &tauri::AppHandle, message: &str) {
    let encoded = http_util::encode_query(message);
    let locale = normalize_app_locale(&app_menu::read_locale_or_default(app));
    let target = format!("tauri://localhost/error.html?locale={locale}&msg={encoded}");
    if navigate_main(app, &target).is_err() {
        let fallback = format!(
            "data:text/html,<body style='font-family:sans-serif;padding:2rem'>\
             <h2>InkMarshal could not start</h2><pre>{}</pre></body>",
            html_escape(message)
        );
        let _ = navigate_main(app, &fallback);
    }
    // The normal Studio window stays hidden until its locale is hydrated.
    // Startup failures never reach that React gate, so reveal the native error
    // page here instead of leaving the application invisibly running.
    if let Some(window) = app.get_webview_window("main") {
        if let Err(err) = window.show() {
            log::error!("Failed to reveal startup error window: {err}");
        }
    }
}

fn html_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn normalize_app_locale(locale: &str) -> &'static str {
    app_menu::normalize_locale(locale)
}

fn write_small_app_data_file(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "App data file path has no parent".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("app-data");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(".{file_name}.{}.{}.tmp", std::process::id(), nanos));
    let result: Result<(), String> = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options
            .open(&tmp)
            .map_err(|err| format!("Cannot create app data temp file: {err}"))?;
        use std::io::Write as _;
        file.write_all(bytes)
            .map_err(|err| format!("Cannot write app data temp file: {err}"))?;
        let _ = file.sync_all();
        std::fs::rename(&tmp, path)
            .map_err(|err| format!("Cannot replace app data file: {err}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[derive(Default)]
struct RuntimeState {
    port: Mutex<Option<u16>>,
    started: Mutex<bool>,
}

/// The full startup sequence: clean orphans, pick a port, spawn node, wait for
/// readiness, then navigate exactly once. Any failure routes to the error page
/// instead of panicking the setup hook (which would crash with a white screen).
fn boot_runtime(app: &tauri::AppHandle) {
    {
        // Guard against the setup hook + a manual retry racing each other.
        let state = app.state::<RuntimeState>();
        let mut started = state.started.lock().unwrap();
        if *started {
            return;
        }
        *started = true;
    }

    match start_runtime(app) {
        Ok(runtime) => {
            let port = runtime.port;
            if let Some(state) = app.try_state::<RuntimeState>() {
                *state.port.lock().unwrap() = Some(port);
            }

            if let Some(token) = runtime.desktop_session_token.as_deref() {
                if let Err(err) = install_desktop_session_cookie(app, token) {
                    log::error!("Desktop session cookie installation failed: {err}");
                    terminate_next_runtime(app);
                    reset_started(app);
                    show_error_page(
                        app,
                        &format!("Could not secure the local studio session: {err}"),
                    );
                    return;
                }
            }

            if let Err(err) = navigate_main(app, &runtime_url(port)) {
                log::error!("Navigation to local studio failed: {err}");
                terminate_next_runtime(app);
                reset_started(app);
                show_error_page(app, &format!("Could not open the studio window: {err}"));
            }
        }
        Err(err) => {
            log::error!("Local studio runtime failed to start: {err}");
            reset_started(app);
            show_error_page(app, &err);
        }
    }
}

fn reset_started(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<RuntimeState>() {
        *state.started.lock().unwrap() = false;
    }
}

fn runtime_retry_should_start(state: &RuntimeState) -> bool {
    !*state.started.lock().unwrap()
}

#[cfg(debug_assertions)]
fn start_runtime(_app: &tauri::AppHandle) -> Result<StartedRuntime, String> {
    // In dev the Next dev server is started by `beforeDevCommand` on port 1420
    // and Tauri only needs to navigate to the Studio route.
    Ok(StartedRuntime {
        port: DEV_SERVER_PORT,
        desktop_session_token: None,
    })
}

#[cfg(not(debug_assertions))]
fn start_runtime(app: &tauri::AppHandle) -> Result<StartedRuntime, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|err| format!("Cannot resolve resource directory: {err}"))?;
    let server_root = resource_dir.join("next-server");
    let server_dir = if server_root.join("server.js").exists() {
        server_root
    } else {
        server_root.join("novelcraft-ai")
    };
    let server_js = server_dir.join("server.js");
    if !server_js.exists() {
        return Err(format!(
            "The bundled studio server is missing: {}",
            server_js.display()
        ));
    }

    let node = node_binary(&resource_dir);

    let log_dir = inkmarshal_home::inkmarshal_log_dir()
        .map_err(|err| format!("Cannot resolve log directory: {err}"))?;
    let _ = fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("inkmarshal-next.log");
    let bootstrap_path = server_bootstrap_path(&log_dir);

    // Kill any InkMarshal node left over from a previous crash. Matched strictly
    // by our own absolute server.js or bootstrap path so a user's unrelated node
    // is safe even if its command contains a similar file name.
    kill_orphan_runtimes(&server_js, &bootstrap_path);

    let port = pick_runtime_port()?;
    let origin = runtime_origin(port);
    let desktop_session_token = generate_desktop_session_token();

    let (stdout_target, stderr_target) = log_targets(&log_path);

    // Write a tiny bootstrap that polls the Tauri parent pid and self-exits if
    // we ever get orphaned (covers SIGKILL of the main process where neither
    // the window event nor Drop fire).
    let bootstrap = write_bootstrap(&log_dir, &server_js)?;
    let parent_pid = std::process::id();

    let mut command = Command::new(&node);
    command.env_clear();
    for key in DESKTOP_RUNTIME_ENV_PASSTHROUGH {
        if let Ok(value) = std::env::var(key) {
            command.env(key, value);
        }
    }
    command
        .arg(&bootstrap)
        .current_dir(&server_dir)
        .env("HOSTNAME", RUNTIME_HOST)
        .env("PORT", port.to_string())
        .env("NODE_ENV", "production")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .env("INKMARSHAL_PARENT_PID", parent_pid.to_string())
        .env("INKMARSHAL_SERVER_JS", &server_js)
        .env("INKMARSHAL_RUNTIME", "desktop")
        .env("INKMARSHAL_DESKTOP_SESSION", &desktop_session_token)
        .stdin(Stdio::null())
        .stdout(stdout_target)
        .stderr(stderr_target);

    // Put node in its own session/process-group so we can reap the whole tree.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    let child = command
        .spawn()
        .map_err(|err| format!("Cannot start the bundled studio server: {err}"))?;

    #[cfg(unix)]
    let pgid = Some(child.id() as i32);
    #[cfg(not(unix))]
    let pgid: Option<i32> = None;

    install_next_runtime(app, child, pgid);

    // Gate navigation on an identity-proving readiness check: the server is only
    // "ready" once /api/health returns sha256(our token). See probe_runtime_ready.
    let expected_session_sha256 = sha256_hex(&desktop_session_token);
    if let Err(err) = wait_for_next_runtime(&origin, &expected_session_sha256) {
        terminate_next_runtime(app);
        return Err(format!(
            "{err}. See the log at {} for details.",
            log_path.display()
        ));
    }
    Ok(StartedRuntime {
        port,
        desktop_session_token: Some(desktop_session_token),
    })
}

#[cfg(any(test, not(debug_assertions)))]
fn open_runtime_log_file(log_path: &Path) -> Result<std::fs::File, std::io::Error> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(log_path)
}

#[cfg(not(debug_assertions))]
fn log_targets(log_path: &Path) -> (Stdio, Stdio) {
    match open_runtime_log_file(log_path) {
        Ok(file) => match file.try_clone() {
            Ok(clone) => (Stdio::from(file), Stdio::from(clone)),
            Err(_) => (Stdio::from(file), Stdio::null()),
        },
        Err(_) => (Stdio::null(), Stdio::null()),
    }
}

#[cfg(any(test, not(debug_assertions)))]
fn server_bootstrap_path(dir: &Path) -> PathBuf {
    dir.join("inkmarshal-server-bootstrap.cjs")
}

#[cfg(any(test, not(debug_assertions)))]
fn write_runtime_bootstrap_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Runtime bootstrap path has no parent".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("inkmarshal-server-bootstrap.cjs");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(".{file_name}.{}.{}.tmp", std::process::id(), nanos));
    let result: Result<(), String> = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options
            .open(&tmp)
            .map_err(|err| format!("Cannot create server bootstrap temp file: {err}"))?;
        use std::io::Write as _;
        file.write_all(bytes)
            .map_err(|err| format!("Cannot write server bootstrap: {err}"))?;
        let _ = file.sync_all();
        std::fs::rename(&tmp, path)
            .map_err(|err| format!("Cannot replace server bootstrap: {err}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Generate a CommonJS bootstrap next to the log dir. It installs a parent-death
/// watchdog then requires the real Next standalone server.
#[cfg(not(debug_assertions))]
fn write_bootstrap(dir: &Path, server_js: &Path) -> Result<PathBuf, String> {
    let bootstrap_path = server_bootstrap_path(dir);
    let server_literal = serde_json::to_string(&server_js.to_string_lossy().into_owned())
        .map_err(|err| format!("Cannot encode server path: {err}"))?;
    let script = format!(
        r#"// Generated by InkMarshal. Watchdog + Next standalone entrypoint.
const PARENT_PID = parseInt(process.env.INKMARSHAL_PARENT_PID || '0', 10);
function parentAlive() {{
  if (!PARENT_PID) return true;
  try {{ process.kill(PARENT_PID, 0); return true; }}
  catch (e) {{ return e && e.code === 'EPERM'; }}
}}
setInterval(() => {{
  if (!parentAlive()) {{
    try {{ console.error('[inkmarshal] parent process gone, shutting down'); }} catch (e) {{}}
    process.exit(0);
  }}
}}, 2000).unref();
require({server_literal});
"#
    );
    write_runtime_bootstrap_file(&bootstrap_path, script.as_bytes())?;
    Ok(bootstrap_path)
}

/// Find and terminate stale InkMarshal `node` processes from a previous run.
/// Matching is intentionally strict: a process is only killed when one of its
/// argv *elements* is exactly equal to the absolute bundled `server.js` path or
/// the uniquely app-generated bootstrap path. We split the `ps` command line on
/// whitespace and compare whole tokens rather than doing a substring-contains,
/// so an unrelated process that merely mentions our path (e.g. a `tail`/`grep`
/// on the log, or an editor with the file open) is never matched and killed.
#[cfg(all(unix, any(test, not(debug_assertions))))]
fn is_inkmarshal_runtime_command(cmd: &str, server_js: &Path, bootstrap: &Path) -> bool {
    let server_needle = server_js.to_string_lossy();
    let bootstrap_needle = bootstrap.to_string_lossy();
    let mut argv = cmd.split_whitespace();
    // The interpreter must be node (argv[0] basename), not just any process
    // whose argv happens to contain our path as an element.
    let is_node = argv
        .next()
        .map(|arg0| {
            Path::new(arg0)
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name == "node" || name == "node.exe")
                .unwrap_or(false)
        })
        .unwrap_or(false);
    if !is_node {
        return false;
    }
    argv.any(|token| token == server_needle.as_ref() || token == bootstrap_needle.as_ref())
}

#[cfg(all(unix, any(test, not(debug_assertions))))]
struct RuntimeProcess<'a> {
    pid: u32,
    parent_pid: u32,
    command: &'a str,
}

#[cfg(all(unix, any(test, not(debug_assertions))))]
fn parse_runtime_process_line(line: &str) -> Option<RuntimeProcess<'_>> {
    let trimmed = line.trim_start();
    let (pid, rest) = trimmed.split_once(char::is_whitespace)?;
    let rest = rest.trim_start();
    let (parent_pid, command) = rest.split_once(char::is_whitespace)?;
    let command = command.trim_start();
    if command.is_empty() {
        return None;
    }
    Some(RuntimeProcess {
        pid: pid.parse().ok()?,
        parent_pid: parent_pid.parse().ok()?,
        command,
    })
}

#[cfg(all(unix, any(test, not(debug_assertions))))]
fn should_reap_runtime_process(
    process: RuntimeProcess<'_>,
    self_pid: u32,
    server_js: &Path,
    bootstrap: &Path,
) -> bool {
    process.pid != self_pid
        && process.parent_pid == 1
        && is_inkmarshal_runtime_command(process.command, server_js, bootstrap)
}

#[cfg(all(unix, not(debug_assertions)))]
fn kill_orphan_runtimes(server_js: &Path, bootstrap: &Path) {
    let self_pid = std::process::id();

    let output = match Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,command="])
        .output()
    {
        Ok(out) => out,
        Err(_) => return,
    };
    let listing = String::from_utf8_lossy(&output.stdout);
    for line in listing.lines() {
        let Some(process) = parse_runtime_process_line(line) else {
            continue;
        };
        let pid = process.pid;
        if should_reap_runtime_process(process, self_pid, server_js, bootstrap) {
            terminate_orphan_runtime_pid(pid);
            log::warn!("Reaped orphaned InkMarshal runtime pid {pid}");
        }
    }
}

/// Terminate an identified orphan runtime PID gracefully: SIGTERM first, give
/// it a short grace window to exit cleanly, then SIGKILL only if it is still
/// alive. We never start with an unconditional SIGKILL — even with the strict
/// argv-equality match above, a graceful signal first avoids hard-killing a
/// possibly-misidentified PID and lets the runtime flush/close cleanly.
#[cfg(all(unix, not(debug_assertions)))]
fn terminate_orphan_runtime_pid(pid: u32) {
    let pid = pid as i32;
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
    // Poll for up to ~2s for the process to exit after SIGTERM. `kill(pid, 0)`
    // returns -1 with ESRCH once the pid is gone (or reaped), so we stop early.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        if !alive {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
}

#[cfg(all(not(unix), not(debug_assertions)))]
fn kill_orphan_runtimes(_server_js: &Path, _bootstrap: &Path) {
    // Windows orphan reaping is handled by the bootstrap watchdog instead.
}

#[cfg(not(debug_assertions))]
fn node_binary(resource_dir: &std::path::Path) -> PathBuf {
    let bundled_node =
        resource_dir
            .join("node")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
    if bundled_node.exists() {
        return bundled_node;
    }

    // Release builds must never fall through to an arbitrary system `node`.
    // Returning the expected bundled path lets process spawn fail loudly with
    // the missing resource path instead of executing an unrelated binary.
    bundled_node
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Invoked by the bundled error page's "Retry" button.
#[tauri::command]
fn retry_runtime(app: tauri::AppHandle) {
    if let Some(state) = app.try_state::<RuntimeState>() {
        if !runtime_retry_should_start(&state) {
            return;
        }
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        boot_runtime(&handle);
    });
}

/// Persist the user's locale so the next launch can build the native menu
/// in the right language. Writes `<~/.inkmarshal/app>/locale.txt`. Best-effort —
/// failures here just leave the menu in its previous (or default) language.
#[tauri::command]
fn write_app_locale(_app: tauri::AppHandle, locale: String) -> Result<(), String> {
    let normalized = normalize_app_locale(&locale);
    let dir = inkmarshal_home::inkmarshal_app_dir()
        .map_err(|err| format!("Cannot resolve app data dir: {err}"))?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("Cannot create app data dir: {err}"))?;
    write_small_app_data_file(&dir.join("locale.txt"), normalized.as_bytes())
        .map_err(|err| format!("Cannot write locale.txt: {err}"))?;
    Ok(())
}

/// Maximum size of a single exported file. Exports are documents (manuscripts,
/// outlines, DOCX/PDF/TXT/ZIP bundles), not media libraries — 256 MiB is generous
/// headroom while still rejecting an absurd payload from a compromised renderer
/// before we allocate and write it to disk.
const MAX_EXPORT_FILE_BYTES: usize = 256 * 1024 * 1024;

/// Save an exported document to a user-chosen location via a native save
/// dialog. This is the desktop path for file export: the webview cannot
/// reliably trigger blob downloads inside the Tauri shell, so the frontend
/// hands us the bytes (base64) + a suggested file name and we write them to
/// the path the user picks.
///
/// Returns `Ok(Some(path))` on success, or `Ok(None)` if the user cancelled
/// the dialog. It is an `async` command so it runs off the main thread — on
/// macOS, calling `blocking_save_file` on the main thread deadlocks the event
/// loop the dialog itself needs to run.
#[tauri::command]
async fn save_export_file(
    app: tauri::AppHandle,
    default_file_name: String,
    contents_base64: String,
) -> Result<Option<String>, String> {
    use base64::Engine;
    use tauri_plugin_dialog::DialogExt;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_base64.as_bytes())
        .map_err(|err| format!("Export payload is not valid base64: {err}"))?;
    if bytes.is_empty() {
        return Err("Export payload is empty".to_string());
    }
    if bytes.len() > MAX_EXPORT_FILE_BYTES {
        return Err(format!(
            "Export payload is too large ({} bytes; limit is {} bytes)",
            bytes.len(),
            MAX_EXPORT_FILE_BYTES
        ));
    }

    let Some(path) = app
        .dialog()
        .file()
        .set_file_name(&default_file_name)
        .blocking_save_file()
    else {
        // User dismissed the save dialog.
        return Ok(None);
    };

    let path_buf = path
        .into_path()
        .map_err(|err| format!("Cannot resolve the chosen save path: {err}"))?;
    std::fs::write(&path_buf, &bytes)
        .map_err(|err| format!("Cannot write export to {}: {err}", path_buf.display()))?;
    remember_export_path(&path_buf);
    Ok(Some(path_buf.to_string_lossy().into_owned()))
}

/// Upper bound for a file read back through `read_local_file`. Manuscript /
/// backup / template-pack payloads stay well under this.
const MAX_IMPORT_FILE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadLocalFile {
    path: String,
    contents_base64: String,
}

/// Read a user-chosen local file via a native open dialog, returning its bytes
/// (base64) and the chosen path. Mirrors `save_export_file`'s "dialog inside
/// Rust" model: the user explicitly picks each file through the OS dialog, so a
/// hostile/buggy renderer can never coerce a read of an arbitrary path — it only
/// ever receives bytes the user just selected. `extensions` is an allowlist
/// applied to the dialog filter AND re-checked on the resolved path. Shared by
/// manuscript import, backup restore, and template-pack import.
///
/// Returns `Ok(None)` if the user dismissed the dialog. `async` for the same
/// main-thread-deadlock reason as `save_export_file`.
#[tauri::command]
async fn read_local_file(
    app: tauri::AppHandle,
    extensions: Vec<String>,
) -> Result<Option<ReadLocalFile>, String> {
    use base64::Engine;
    use tauri_plugin_dialog::DialogExt;

    let mut builder = app.dialog().file();
    if !extensions.is_empty() {
        let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter("Supported files", &exts);
    }
    let Some(path) = builder.blocking_pick_file() else {
        // User dismissed the open dialog.
        return Ok(None);
    };

    let path_buf = path
        .into_path()
        .map_err(|err| format!("Cannot resolve the chosen file path: {err}"))?;

    // Defense in depth: enforce the extension allowlist on the resolved path
    // even though the user picked it through the filtered dialog.
    if !extensions.is_empty() {
        let allowed = path_buf
            .extension()
            .and_then(|e| e.to_str())
            .map(|ext| extensions.iter().any(|a| a.eq_ignore_ascii_case(ext)))
            .unwrap_or(false);
        if !allowed {
            return Err("The chosen file type is not allowed".to_string());
        }
    }

    let meta = std::fs::metadata(&path_buf)
        .map_err(|err| format!("Cannot read file info for {}: {err}", path_buf.display()))?;
    if meta.len() > MAX_IMPORT_FILE_BYTES {
        return Err(format!(
            "File is too large ({} bytes; limit is {} bytes)",
            meta.len(),
            MAX_IMPORT_FILE_BYTES
        ));
    }

    let bytes = std::fs::read(&path_buf)
        .map_err(|err| format!("Cannot read {}: {err}", path_buf.display()))?;
    let contents_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Some(ReadLocalFile {
        path: path_buf.to_string_lossy().into_owned(),
        contents_base64,
    }))
}

/// Paths written by `save_export_file` during this app session. The renderer
/// ultimately controls the path it passes to `reveal_export_file`; gating the
/// reveal on this allowlist means a hostile/buggy renderer can only ever
/// reveal files the user just exported through the native save dialog.
static EXPORT_SAVED_PATHS: Mutex<Option<std::collections::HashSet<std::path::PathBuf>>> =
    Mutex::new(None);

fn remember_export_path(path: &std::path::Path) {
    let mut guard = EXPORT_SAVED_PATHS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard
        .get_or_insert_with(std::collections::HashSet::new)
        .insert(path.to_path_buf());
}

fn is_remembered_export_path(path: &std::path::Path) -> bool {
    let guard = EXPORT_SAVED_PATHS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.as_ref().is_some_and(|set| set.contains(path))
}

/// Reveal an exported file in Finder / Explorer (selecting the file itself).
/// Only paths produced by `save_export_file` in this session are allowed.
#[tauri::command]
fn reveal_export_file(path: String) -> Result<(), String> {
    let path_buf = std::path::PathBuf::from(&path);
    if !is_remembered_export_path(&path_buf) {
        return Err("Refusing to reveal a path that was not produced by an export".to_string());
    }
    if !path_buf.exists() {
        return Err("The exported file no longer exists".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path_buf)
            .spawn()
            .map_err(|e| format!("Cannot reveal export in Finder: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path_buf.display()))
            .spawn()
            .map_err(|e| format!("Cannot reveal export in Explorer: {e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let parent = path_buf
            .parent()
            .ok_or_else(|| "Export path has no parent directory".to_string())?;
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("Cannot open export folder: {e}"))?;
        Ok(())
    }
}

// Internal helper for `probe_default_runtimes`. Not a `#[tauri::command]` —
// the frontend only ever invokes `probe_default_runtimes`, never a single
// arbitrary-URL probe, so exposing it to JS was dead surface area.
fn probe_runtime(input: RuntimeProbeInput) -> RuntimeProbeResult {
    match probe_socket(&input.url) {
        Ok(()) => RuntimeProbeResult {
            id: input.id,
            name: input.name,
            url: input.url,
            reachable: true,
            message: "Runtime port is reachable".to_string(),
        },
        Err(message) => RuntimeProbeResult {
            id: input.id,
            name: input.name,
            url: input.url,
            reachable: false,
            message,
        },
    }
}

#[tauri::command]
fn probe_default_runtimes() -> Vec<RuntimeProbeResult> {
    [
        RuntimeProbeInput {
            id: "ollama".to_string(),
            name: "Ollama".to_string(),
            url: "http://127.0.0.1:11434".to_string(),
        },
        RuntimeProbeInput {
            id: "lm-studio".to_string(),
            name: "LM Studio".to_string(),
            url: "http://127.0.0.1:1234".to_string(),
        },
        RuntimeProbeInput {
            id: "llama-cpp".to_string(),
            name: "llama.cpp server".to_string(),
            url: "http://127.0.0.1:8080".to_string(),
        },
        RuntimeProbeInput {
            id: "mlx".to_string(),
            name: "MLX server".to_string(),
            url: "http://127.0.0.1:8081".to_string(),
        },
    ]
    .into_iter()
    .map(probe_runtime)
    .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Info
                } else {
                    log::LevelFilter::Warn
                })
                // File logging is enabled in release too so "installs but won't
                // open" reports have something to look at on the user's machine.
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("inkmarshal".into()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(RuntimeState::default())
        .manage(DownloadRegistry::default())
        .manage(engine::EngineRegistry::default())
        .manage(vault::VaultWatchers::default())
        // Wave 3 commit 4 — native macOS menu. The menu builder reads the
        // persisted locale from `~/.inkmarshal/app/locale.txt` (written by the
        // frontend's LanguageProvider). A build failure here only logs and
        // falls back to no menu; `useGlobalHotkeys` covers the same shortcuts
        // so the app still works.
        .menu(|app| {
            let locale = app_menu::read_locale_or_default(app);
            app_menu::build_menu(app, &locale)
        })
        .on_menu_event(|app, event| {
            // Forward every menu click to the webview as a plain string event;
            // the frontend's `useMenuEvents` hook maps the id → action. We use
            // `EventTarget::any()` so the same event reaches whatever Webview
            // is currently mounted (the main window today; helper windows in
            // the future).
            let id = event.id().0.clone();
            if let Err(err) = app.emit_to(EventTarget::any(), "inkmarshal://menu", id) {
                log::warn!("Failed to forward menu event: {err}");
            }
        })
        .setup(|app| {
            // DEV ONLY: the dev build serves the frontend from the Vite/Next dev
            // server at 127.0.0.1:1420 (tauri.conf devUrl). That origin is
            // intentionally absent from the bundled capabilities/default.json,
            // which trusts ONLY the packaged runtime ports 1421/1422 — so a
            // release artifact never grants IPC to the dev port (AN-SEC-001). We
            // grant it here at runtime instead, from a file kept outside
            // capabilities/ so it is never embedded in release.
            #[cfg(debug_assertions)]
            {
                if let Err(err) = app
                    .handle()
                    .add_capability(include_str!("../dev-remote-capability.json"))
                {
                    log::error!("failed to register dev remote capability: {err}");
                }
            }
            // Startup runs off the setup hook on a worker thread so a slow or
            // failing server never blocks/panics the UI thread; failures route
            // to the error page (see boot_runtime) instead of crashing.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                boot_runtime(&handle);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                terminate_next_runtime(window.app_handle());
                if let Some(reg) = window.app_handle().try_state::<engine::EngineRegistry>() {
                    engine::stop_all(&reg);
                }
                if let Some(reg) = window.app_handle().try_state::<vault::VaultWatchers>() {
                    vault::stop_all_watchers(&reg);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            probe_default_runtimes,
            retry_runtime,
            write_app_locale,
            save_export_file,
            reveal_export_file,
            read_local_file,
            secret::keychain_set,
            secret::keychain_get,
            secret::keychain_delete,
            secret::keychain_status,
            health::runtime_health,
            model_manager::ollama_list_tags,
            model_manager::ollama_pull,
            model_manager::hf_search_models,
            model_manager::hf_list_gguf_files,
            model_manager::hf_get_endpoint,
            model_manager::hf_set_endpoint,
            model_manager::hf_download_gguf,
            model_manager::hf_download_repo_snapshot,
            model_manager::cancel_download,
            model_manager::model_dir_free_bytes,
            model_manager::set_model_dir,
            model_manager::reset_model_dir,
            model_manager::reveal_model_dir,
            model_manager::import_local_model,
            model_manager::list_installed_local_models,
            model_manager::reveal_local_model,
            model_manager::remove_installed_local_model,
            engine::engine_start,
            engine::engine_stop,
            engine::engine_status,
            engine::engine_estimate_footprint,
            engine::engine_resource_budget,
            engine::engine_log_tail,
            engine::stop_others_for_path,
            vault::vault_init,
            vault::vault_walk,
            vault::vault_read_file,
            vault::vault_write_file,
            vault::vault_delete_file,
            vault::vault_move,
            vault::vault_watch_start,
            vault::vault_watch_stop,
            vault::vault_reveal_in_finder,
            vault::vault_reachable
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(reg) = app.try_state::<engine::EngineRegistry>() {
                    engine::stop_all(&reg);
                }
                if let Some(reg) = app.try_state::<vault::VaultWatchers>() {
                    vault::stop_all_watchers(&reg);
                }
                terminate_next_runtime(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_probe_rejects_non_http_schemes() {
        let err = probe_socket("ftp://127.0.0.1:21").expect_err("scheme rejected");
        assert!(err.contains("http or https"));
    }

    #[test]
    fn runtime_probe_rejects_non_loopback_targets() {
        let err = probe_socket("http://192.0.2.1:11434").expect_err("non-loopback rejected");
        assert!(err.contains("loopback"));
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        // sha256("") is a well-known constant.
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        // Stable + sensitive to input.
        assert_ne!(sha256_hex("token-a"), sha256_hex("token-b"));
    }

    #[test]
    fn secure_eq_only_matches_identical_strings() {
        assert!(secure_eq("abc", "abc"));
        assert!(!secure_eq("abc", "abd"));
        assert!(!secure_eq("abc", "abcd"));
        assert!(!secure_eq("", "x"));
    }

    // Spin up a one-shot TCP server that returns the given HTTP/1.0 body and
    // return its port, so the readiness probe runs against a real socket.
    #[cfg(test)]
    fn serve_one_health_response(body: String) -> u16 {
        use std::io::{Read as _, Write as _};
        let listener = TcpListener::bind((RUNTIME_HOST, 0)).expect("bind ephemeral");
        let port = listener.local_addr().expect("addr").port();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut scratch = [0u8; 1024];
                let _ = stream.read(&mut scratch);
                let resp = format!(
                    "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        port
    }

    #[test]
    fn readiness_accepts_only_the_matching_identity_proof() {
        let token = "deadbeefcafefeed";
        let expected = sha256_hex(token);

        // Our real Node would return session == sha256(token) → ready.
        let port = serve_one_health_response(format!(
            "{{\"ok\":true,\"runtime\":\"desktop\",\"session\":\"{expected}\"}}"
        ));
        let origin = format!("http://{RUNTIME_HOST}:{port}");
        assert!(probe_runtime_ready(&origin, &expected).is_ok());
    }

    #[test]
    fn readiness_rejects_an_impostor_without_the_proof() {
        let expected = sha256_hex("the-real-token");

        // A foreign process that pre-empted the port answers 200 but cannot
        // produce the proof → rejected.
        let port = serve_one_health_response(
            "{\"ok\":true,\"runtime\":\"desktop\",\"session\":\"not-the-proof\"}".to_string(),
        );
        let origin = format!("http://{RUNTIME_HOST}:{port}");
        assert!(probe_runtime_ready(&origin, &expected).is_err());

        // Missing the session field entirely → also rejected.
        let port2 = serve_one_health_response("{\"ok\":true,\"runtime\":\"desktop\"}".to_string());
        let origin2 = format!("http://{RUNTIME_HOST}:{port2}");
        assert!(probe_runtime_ready(&origin2, &expected).is_err());
    }

    // Parse a capability file and return its remote.urls (so assertions check the
    // actual allowlist, not prose in the description).
    #[cfg(test)]
    fn capability_remote_urls(json: &str) -> Vec<String> {
        let cap: serde_json::Value = serde_json::from_str(json).expect("valid capability json");
        cap["remote"]["urls"]
            .as_array()
            .expect("remote.urls array")
            .iter()
            .map(|v| v.as_str().unwrap_or("").to_string())
            .collect()
    }

    #[test]
    fn release_capability_trusts_only_the_fixed_runtime_ports() {
        let urls = capability_remote_urls(include_str!("../capabilities/default.json"));
        assert!(
            urls.iter().any(|u| u.contains("127.0.0.1:1421")),
            "release must trust 1421"
        );
        assert!(
            urls.iter().any(|u| u.contains("127.0.0.1:1422")),
            "release must trust 1422"
        );
        // The dev port must NEVER be embedded in the bundled (release) capability;
        // it is injected at runtime only under debug_assertions (AN-SEC-001).
        assert!(
            !urls.iter().any(|u| u.contains("127.0.0.1:1420")),
            "dev port 1420 must not be trusted in the release capability remote.urls"
        );
    }

    #[test]
    fn dev_capability_file_grants_the_dev_origin() {
        let urls = capability_remote_urls(include_str!("../dev-remote-capability.json"));
        assert!(
            urls.iter().any(|u| u.contains("127.0.0.1:1420")),
            "dev capability must grant 1420"
        );
    }

    #[test]
    fn dev_runtime_url_matches_next_dev_server() {
        assert_eq!(
            runtime_url(DEV_SERVER_PORT),
            "http://127.0.0.1:1420/desktop-studio"
        );
    }

    #[test]
    fn desktop_runtime_url_never_carries_the_session_token() {
        assert_eq!(runtime_url(1421), "http://127.0.0.1:1421/desktop-studio");
        assert!(!runtime_url(1421).contains("desktopSession"));
    }

    #[test]
    fn desktop_session_cookie_is_http_only_loopback_scoped() {
        let cookie = desktop_session_cookie("abc123");
        assert_eq!(cookie.name(), DESKTOP_SESSION_COOKIE);
        assert_eq!(cookie.value(), "abc123");
        assert_eq!(cookie.domain(), Some(RUNTIME_HOST));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.http_only(), Some(true));
        // Wry 0.55 turns an explicit `Secure=false` into an
        // `NSHTTPCookieSecure` property. WebKit treats the property's presence
        // as secure even when its string value is FALSE, so it silently omits
        // the cookie from an HTTP loopback request. Attribute absence is the
        // standards-correct representation of a non-secure cookie.
        assert_eq!(cookie.secure(), None);
        assert_eq!(cookie.same_site(), Some(SameSite::Lax));
    }

    #[test]
    fn desktop_session_cookie_replaces_stale_values_across_cold_starts() {
        use std::cell::RefCell;

        let store = RefCell::new(vec![desktop_session_cookie(&"a".repeat(64))]);
        for token in ["b".repeat(64), "c".repeat(64)] {
            replace_and_verify_desktop_session_cookie(
                &token,
                |cookie| {
                    let mut cookies = store.borrow_mut();
                    cookies.retain(|existing| {
                        existing.name() != cookie.name()
                            || existing.domain() != cookie.domain()
                            || existing.path() != cookie.path()
                    });
                    cookies.push(cookie);
                    Ok(())
                },
                || Ok(store.borrow().clone()),
            )
            .expect("the freshly installed cookie must validate");
        }

        let cookies = store.borrow();
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].value(), "c".repeat(64));
    }

    #[test]
    fn desktop_session_cookie_validation_failure_stops_startup() {
        let result = replace_and_verify_desktop_session_cookie(
            &"b".repeat(64),
            |_| Ok(()),
            || Ok(vec![desktop_session_cookie(&"a".repeat(64))]),
        );

        assert!(result.is_err());
    }

    #[test]
    fn runtime_port_candidates_are_the_fixed_authorized_set() {
        // These MUST match the loopback ports in capabilities/default.json
        // `remote.urls` (1421, 1422). This is the single coupling that would
        // silently lose IPC permission on fallback, so assert it explicitly.
        assert_eq!(RUNTIME_PORT_CANDIDATES, &[1421u16, 1422u16]);
    }

    #[test]
    fn pick_runtime_port_falls_back_to_the_fixed_second_candidate() {
        // Occupy the preferred port; the picker must return the FIXED fallback,
        // never an OS-random port. Guarded so a host that already has 1421 busy
        // just skips rather than panicking under parallel test execution.
        let Ok(_hold) = TcpListener::bind((RUNTIME_HOST, PREFERRED_PORT)) else {
            return;
        };
        match pick_runtime_port() {
            Ok(port) => assert_eq!(port, FALLBACK_PORT),
            // The only acceptable alternative (fallback also busy) is a hard
            // error — never a random port.
            Err(err) => assert!(err.contains("busy"), "unexpected error: {err}"),
        }
    }

    #[test]
    fn pick_runtime_port_errors_when_all_candidates_busy() {
        // Only assert when this test actually owns both fixed ports; otherwise a
        // parallel sibling holds one and we skip to avoid a flaky failure.
        let (Ok(_a), Ok(_b)) = (
            TcpListener::bind((RUNTIME_HOST, PREFERRED_PORT)),
            TcpListener::bind((RUNTIME_HOST, FALLBACK_PORT)),
        ) else {
            return;
        };
        let err = pick_runtime_port().expect_err("all candidates busy → hard error");
        assert!(err.contains("busy"), "unexpected error: {err}");
    }

    #[test]
    fn desktop_runtime_env_allowlist_excludes_provider_and_override_secrets() {
        assert!(desktop_runtime_env_allows("HOME"));
        assert!(desktop_runtime_env_allows("PATH"));
        assert!(desktop_runtime_env_allows("INKMARSHAL_HOME"));
        assert!(!desktop_runtime_env_allows("OPENAI_API_KEY"));
        assert!(!desktop_runtime_env_allows("ANTHROPIC_API_KEY"));
        assert!(!desktop_runtime_env_allows("INKMARSHAL_DATA_DIR"));
    }

    #[test]
    fn app_locale_persistence_normalizes_supported_values() {
        assert_eq!(normalize_app_locale("zh"), "zh-CN");
        assert_eq!(normalize_app_locale("zh-Hans-NZ"), "zh-CN");
        assert_eq!(normalize_app_locale("zh-HK"), "zh-TW");
        assert_eq!(normalize_app_locale("zh-Hant-AU"), "zh-TW");
        assert_eq!(normalize_app_locale("zh_TW"), "zh-TW");
        assert_eq!(normalize_app_locale("en-GB"), "en");
        assert_eq!(normalize_app_locale("x".repeat(10_000).as_str()), "en");
    }

    #[cfg(unix)]
    #[test]
    fn app_data_write_replaces_symlink_without_touching_target() {
        use std::os::unix::fs::symlink;

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "inkmarshal-app-data-write-test-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("tmp dir");
        let outside = dir.join("outside.txt");
        let locale_path = dir.join("locale.txt");
        std::fs::write(&outside, b"outside").expect("outside");
        symlink(&outside, &locale_path).expect("locale symlink");

        write_small_app_data_file(&locale_path, b"zh-CN").expect("write locale");

        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "outside");
        let md = std::fs::symlink_metadata(&locale_path).unwrap();
        assert!(!md.file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&locale_path).unwrap(), "zh-CN");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn next_runtime_replace_reaps_previous_child_slot() {
        #[cfg(unix)]
        let child = Command::new("sleep")
            .arg("60")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleep");

        #[cfg(windows)]
        let child = Command::new("cmd")
            .args(["/C", "ping", "-n", "60", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn ping");

        let runtime = NextRuntime::new(Some(child), None);
        assert!(runtime.has_child_for_test());

        runtime.replace(None, None);

        assert!(!runtime.has_child_for_test());
    }

    #[test]
    fn runtime_retry_does_not_reset_active_runtime_gate() {
        let state = RuntimeState::default();
        assert!(runtime_retry_should_start(&state));

        *state.started.lock().unwrap() = true;
        assert!(!runtime_retry_should_start(&state));
    }

    #[cfg(unix)]
    #[test]
    fn runtime_bootstrap_write_replaces_symlink_without_touching_target() {
        use std::os::unix::fs::symlink;

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "inkmarshal-runtime-bootstrap-test-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("tmp dir");
        let outside = dir.join("outside.cjs");
        let bootstrap = server_bootstrap_path(&dir);
        std::fs::write(&outside, b"outside").expect("outside");
        symlink(&outside, &bootstrap).expect("bootstrap symlink");

        write_runtime_bootstrap_file(&bootstrap, b"bootstrap").expect("write bootstrap");

        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "outside");
        let md = std::fs::symlink_metadata(&bootstrap).unwrap();
        assert!(!md.file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&bootstrap).unwrap(), "bootstrap");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn runtime_log_open_rejects_symlink() {
        use std::os::unix::fs::symlink;

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "inkmarshal-runtime-log-test-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("tmp dir");
        let outside = dir.join("outside.log");
        let log_path = dir.join("inkmarshal-next.log");
        std::fs::write(&outside, b"outside").expect("outside");
        symlink(&outside, &log_path).expect("log symlink");

        let _err = open_runtime_log_file(&log_path).expect_err("reject symlink log");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "outside");
        let md = std::fs::symlink_metadata(&log_path).unwrap();
        assert!(md.file_type().is_symlink());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn orphan_runtime_match_requires_absolute_runtime_paths() {
        let server_js =
            PathBuf::from("/Applications/InkMarshal.app/Contents/Resources/next-server/server.js");
        let bootstrap = server_bootstrap_path(&PathBuf::from("/Users/me/Library/Logs/InkMarshal"));

        assert!(is_inkmarshal_runtime_command(
            "/usr/local/bin/node /Users/me/Library/Logs/InkMarshal/inkmarshal-server-bootstrap.cjs",
            &server_js,
            &bootstrap,
        ));
        assert!(is_inkmarshal_runtime_command(
            "/usr/local/bin/node /Applications/InkMarshal.app/Contents/Resources/next-server/server.js",
            &server_js,
            &bootstrap,
        ));
        assert!(!is_inkmarshal_runtime_command(
            "/usr/local/bin/node ./inkmarshal-server-bootstrap.cjs",
            &server_js,
            &bootstrap,
        ));
        assert!(!is_inkmarshal_runtime_command(
            "/usr/local/bin/node /tmp/inkmarshal-server-bootstrap.cjs",
            &server_js,
            &bootstrap,
        ));
    }

    #[cfg(unix)]
    #[test]
    fn orphan_runtime_parser_keeps_parent_pid_and_command() {
        let process = parse_runtime_process_line(
            "  8124  7100 /usr/local/bin/node /Applications/InkMarshal.app/server.js",
        )
        .expect("valid ps row");

        assert_eq!(process.pid, 8124);
        assert_eq!(process.parent_pid, 7100);
        assert_eq!(
            process.command,
            "/usr/local/bin/node /Applications/InkMarshal.app/server.js"
        );
        assert!(parse_runtime_process_line("not-a-process").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn active_desktop_parent_prevents_runtime_reaping() {
        let server_js =
            PathBuf::from("/Applications/InkMarshal.app/Contents/Resources/next-server/server.js");
        let bootstrap = server_bootstrap_path(&PathBuf::from("/Users/me/Library/Logs/InkMarshal"));
        let command = format!("/usr/local/bin/node {}", bootstrap.display());

        assert!(!should_reap_runtime_process(
            RuntimeProcess {
                pid: 8124,
                parent_pid: 7100,
                command: &command,
            },
            9000,
            &server_js,
            &bootstrap,
        ));
        assert!(should_reap_runtime_process(
            RuntimeProcess {
                pid: 8124,
                parent_pid: 1,
                command: &command,
            },
            9000,
            &server_js,
            &bootstrap,
        ));
    }

    #[cfg(unix)]
    #[test]
    fn orphan_runtime_match_rejects_non_node_and_substring_mentions() {
        let server_js =
            PathBuf::from("/Applications/InkMarshal.app/Contents/Resources/next-server/server.js");
        let bootstrap = server_bootstrap_path(&PathBuf::from("/Users/me/Library/Logs/InkMarshal"));

        // A non-node process (e.g. tail/grep/editor) that has our exact path as
        // an argv element must NOT be matched — argv[0] is not node.
        assert!(!is_inkmarshal_runtime_command(
            "/usr/bin/tail -f /Applications/InkMarshal.app/Contents/Resources/next-server/server.js",
            &server_js,
            &bootstrap,
        ));
        // node, but the path only appears as a substring of a longer token (not
        // an equal argv element) — must NOT be matched either.
        assert!(!is_inkmarshal_runtime_command(
            "/usr/local/bin/node /Applications/InkMarshal.app/Contents/Resources/next-server/server.js.bak",
            &server_js,
            &bootstrap,
        ));
    }
}
