//! Shared HTTP plumbing for the model-supply capability layer (WS-B.2).
//!
//! Two concerns live here so health/model_manager don't drift:
//!
//!  * **Error classification** (`http_err`/`io_err`): turn a low-level
//!    `reqwest::Error`/`std::io::Error` into a short, actionable, user-facing
//!    string. The raw error is *never* interpolated into the returned text —
//!    the spec forbids leaking reqwest/io Display chains into B.4's UI. The
//!    raw detail goes to the logfile via `log::warn!` (A.1 wires
//!    `tauri-plugin-log`), so diagnostics are still recoverable.
//!  * **Client + URL construction** (`short_client`/`download_client` and the
//!    base-url/URL builders): one place for the timeout + redirect policy so
//!    the health probe and the list/search/pull/download paths can't disagree.
//!
//! Behavior note: `short_client`/`download_client` reproduce *exactly* the
//! builders that previously lived inline in `health.rs`/`model_manager.rs`
//! (same timeouts, default `Policy::limited(10)` redirect — Range survives a
//! redirect because reqwest re-sends request headers on a redirect). This is a
//! pure consolidation; no observable behavior changes.

use std::time::Duration;

// ── Error classification ────────────────────────────────────────────────────

/// Classify a `reqwest::Error` into a concise, actionable, user-facing string.
/// The raw error is logged (logfile only), never returned to the UI.
pub fn http_err(context: &str, e: &reqwest::Error) -> String {
    log::warn!("{context}: {e}");
    if e.is_timeout() {
        format!("{context}: no response in time — is the service running and reachable?")
    } else if e.is_connect() {
        format!("{context}: connection refused — is the service running?")
    } else {
        format!("{context}: request failed")
    }
}

/// Classify a `std::io::Error` into a concise, actionable, user-facing string.
/// The raw error is logged (logfile only), never returned to the UI.
pub fn io_err(context: &str, e: &std::io::Error) -> String {
    log::warn!("{context}: {e}");
    use std::io::ErrorKind;
    let out_of_space = is_out_of_space(e);
    if out_of_space {
        format!("{context}: out of disk space — free up space and retry")
    } else if e.kind() == ErrorKind::PermissionDenied {
        format!("{context}: permission denied writing the model file")
    } else {
        format!("{context}: could not write the model file")
    }
}

fn is_out_of_space(e: &std::io::Error) -> bool {
    // Keep MSRV at 1.77: `ErrorKind::StorageFull` stabilized later, so classify
    // the OS codes we need directly. 28 is POSIX ENOSPC; 112 is Windows
    // ERROR_DISK_FULL.
    matches!(e.raw_os_error(), Some(28) | Some(112))
}

// ── HTTP clients ────────────────────────────────────────────────────────────

/// Short-timeout JSON client used by the health probe and the
/// list/search/ollama metadata calls. `timeout_secs` is supplied by the caller
/// so the existing per-site timeout values (health: 5s, hf/ollama list: 20s)
/// are preserved byte-for-byte.
pub fn short_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| {
            log::warn!("HTTP client init failed: {e}");
            "Couldn't initialize the network client".to_string()
        })
}

/// Long-lived client for streaming downloads (no global timeout — a multi-GB
/// GGUF can legitimately take a long time; per-chunk progress is the liveness
/// signal). Keeps the 15s connect timeout and reqwest's default redirect
/// policy (`Policy::limited(10)`) so a `Range` request still resumes correctly
/// across the HF → cdn-lfs redirect.
pub fn download_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| {
            log::warn!("HTTP client init failed: {e}");
            "Couldn't initialize the network client".to_string()
        })
}

// ── Base-URL / endpoint helpers ─────────────────────────────────────────────

/// Strip a single trailing `/` then a single trailing `/v1`, returning an owned
/// normalized base. Used to rebuild the right path whether or not the caller's
/// base already includes `/v1`.
pub fn trim_v1_base(base_url: &str) -> String {
    let b = base_url.strip_suffix('/').unwrap_or(base_url);
    b.strip_suffix("/v1").unwrap_or(b).to_string()
}

/// Validate a user-entered runtime base URL before any probe/list/pull command
/// builds request URLs or logs status. Base URLs may include a path such as
/// `/v1`, but must not carry credentials, query strings, or fragments.
pub fn validate_runtime_base_url(base_url: &str) -> Result<String, String> {
    let mut url = url::Url::parse(base_url.trim())
        .map_err(|_| "Runtime base URL must be a valid http(s) URL".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Runtime base URL must use http or https".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Runtime base URL must not contain credentials".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Runtime base URL must not contain a query string or fragment".to_string());
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

/// Runtime secrets may travel over HTTPS, or over plain HTTP only when the
/// target is an explicit loopback runtime on this machine.
pub fn runtime_base_url_can_carry_secret(base_url: &str) -> bool {
    let Ok(url) = url::Url::parse(base_url) else {
        return false;
    };
    if url.scheme() == "https" {
        return true;
    }
    if url.scheme() != "http" {
        return false;
    }
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

/// Strip only a single trailing `/` (Ollama / generic host-rooted paths keep
/// any `/v1` they were given — the caller decides the suffix).
fn trim_trailing_slash(s: &str) -> &str {
    s.strip_suffix('/').unwrap_or(s)
}

/// Ollama's native API lives at the bare host, not under `/v1`.
pub fn ollama_base(base_url: &str) -> String {
    trim_v1_base(base_url)
}

/// OpenAI-style model-list URL. If the base already ends in `/v1` hit
/// `{base}/models`, else `{base}/v1/models`.
pub fn openai_models_url(base_url: &str) -> String {
    let base = trim_trailing_slash(base_url);
    if base.ends_with("/v1") {
        format!("{base}/models")
    } else {
        format!("{base}/v1/models")
    }
}

/// Anthropic exposes `/v1/models` on the Messages API base — same path-building
/// rule as the OpenAI case.
pub fn anthropic_models_url(base_url: &str) -> String {
    openai_models_url(base_url)
}

/// Minimal RFC-3986 percent-encoding for a query-string value (unreserved set
/// `A-Z a-z 0-9 - _ . ~` passed through; everything else `%XX`). Shared so the
/// HF search URL builder and the error-page query builder don't each carry a
/// copy.
pub fn encode_query(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_base_url_rejects_credentials_query_and_bad_scheme() {
        assert_eq!(
            validate_runtime_base_url("http://127.0.0.1:11434/v1").unwrap(),
            "http://127.0.0.1:11434/v1"
        );
        assert!(validate_runtime_base_url("file:///tmp/socket").is_err());
        assert!(validate_runtime_base_url("http://user:pass@127.0.0.1:11434").is_err());
        assert!(validate_runtime_base_url("http://127.0.0.1:11434/v1?token=secret").is_err());
        assert!(validate_runtime_base_url("http://127.0.0.1:11434/v1#secret").is_err());
    }

    #[test]
    fn runtime_base_url_secret_transport_requires_https_or_loopback() {
        assert!(runtime_base_url_can_carry_secret(
            "https://api.example.com/v1"
        ));
        assert!(runtime_base_url_can_carry_secret(
            "http://127.0.0.1:8000/v1"
        ));
        assert!(runtime_base_url_can_carry_secret("http://[::1]:8000/v1"));
        assert!(runtime_base_url_can_carry_secret(
            "http://localhost:8000/v1"
        ));
        assert!(!runtime_base_url_can_carry_secret(
            "http://192.0.2.10:8000/v1"
        ));
        assert!(!runtime_base_url_can_carry_secret("ftp://127.0.0.1:21"));
    }
}
