//! Runtime connection health probe (WS-B.2).
//!
//! Replaces the legacy bare-TCP `probe_socket` for model-supply connections
//! with a *protocol-aware* probe: we don't just check that a port accepts a
//! socket, we issue the transport's real model-list request and only call the
//! connection `transportOk` when the response parses into a model list.
//!
//! Wire contract (LOCKED with B.1 `lib/model-supply/types.ts`): every struct
//! here is `#[serde(rename_all = "camelCase")]` so the JSON the JS side sees is
//! exactly `ConnectionHealth { reachable, transportOk, models, latencyMs,
//! message }` and the input is `HealthInput { connectionId, baseUrl,
//! transport, secret }`. Do NOT change field names/casing without updating B.1/B.3.

use crate::http_util::{
    anthropic_models_url, http_err, ollama_base, openai_models_url,
    runtime_base_url_can_carry_secret, short_client, validate_runtime_base_url,
};
use serde::{Deserialize, Serialize};
use std::time::Instant;

/// Input for `runtime_health` — mirrors B.1's `runtimeHealth({ input })` arg.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthInput {
    /// Opaque connection id (carried through for caller correlation and logged
    /// for B.3 debugging — see `runtime_health`).
    pub connection_id: String,
    /// User-provided base URL. May or may not end in `/v1` for the OpenAI
    /// transport; for `ollama-native` it is the bare host (no `/v1`).
    pub base_url: String,
    /// `"openai-compatible" | "anthropic" | "ollama-native"`.
    pub transport: String,
    /// Optional provider/runtime API key used only for authenticated health
    /// probes. Never logged or returned in status messages.
    #[serde(default)]
    pub secret: Option<String>,
}

/// Return shape of `runtime_health` (camelCase on the wire — see B.1).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionHealth {
    /// The endpoint responded at all (TCP + HTTP response received, any status).
    pub reachable: bool,
    /// The response matched the declared transport (2xx + parseable model list,
    /// or — for anthropic — the expected auth-required shape).
    pub transport_ok: bool,
    /// Model ids/names the runtime advertises (may be empty).
    pub models: Vec<String>,
    /// Round-trip latency of the probe request, in milliseconds.
    pub latency_ms: u64,
    /// Product-level, actionable human status string.
    pub message: String,
}

/// Protocol-aware health probe. See module docs for the contract.
#[tauri::command]
pub async fn runtime_health(input: HealthInput) -> Result<ConnectionHealth, String> {
    let base_url = validate_runtime_base_url(&input.base_url)?;
    if input
        .secret
        .as_deref()
        .is_some_and(|secret| !secret.is_empty())
        && !runtime_base_url_can_carry_secret(&base_url)
    {
        return Err("Runtime health API keys require HTTPS or a loopback HTTP runtime".to_string());
    }
    log::debug!(
        "runtime_health: probing connection {} ({} @ {})",
        input.connection_id,
        input.transport,
        base_url
    );
    // Best-effort short HTTP client with a 5s timeout so a dead endpoint can't
    // hang the UI.
    let client = short_client(5)?;
    let started = Instant::now();

    match input.transport.as_str() {
        "openai-compatible" => {
            probe_openai(&client, &base_url, started, input.secret.as_deref()).await
        }
        "ollama-native" => probe_ollama(&client, &base_url, started).await,
        "anthropic" => probe_anthropic(&client, &base_url, started, input.secret.as_deref()).await,
        other => Err(format!("Unsupported runtime transport: {other}")),
    }
}

/// Map a reqwest transport error into an actionable, human message. Delegates
/// to the single shared classifier so health and model_manager can't diverge;
/// the raw error goes to the logfile (never the UI string) via `http_err`.
fn connection_error_message(err: &reqwest::Error) -> String {
    http_err("Could not reach the runtime", err)
}

fn ollama_tags_url(base_url: &str) -> String {
    format!("{}/api/tags", ollama_base(base_url))
}

async fn probe_ollama(
    client: &reqwest::Client,
    base_url: &str,
    started: Instant,
) -> Result<ConnectionHealth, String> {
    let url = ollama_tags_url(base_url);
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(err) => {
            return Ok(ConnectionHealth {
                reachable: false,
                transport_ok: false,
                models: Vec::new(),
                latency_ms: started.elapsed().as_millis() as u64,
                message: connection_error_message(&err),
            });
        }
    };

    let status = resp.status();
    let latency_ms = started.elapsed().as_millis() as u64;

    if !status.is_success() {
        return Ok(ConnectionHealth {
            reachable: true,
            transport_ok: false,
            models: Vec::new(),
            latency_ms,
            message: format!(
                "HTTP {} from {url} — the host responded but /api/tags failed; \
                 is this an Ollama runtime?",
                status.as_u16()
            ),
        });
    }

    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(err) => {
            log::warn!("Ollama /api/tags body was not JSON: {err}");
            return Ok(ConnectionHealth {
                reachable: true,
                transport_ok: false,
                models: Vec::new(),
                latency_ms,
                message: "Endpoint responded but did not speak the Ollama API — check the base URL"
                    .to_string(),
            });
        }
    };

    // Ollama: { "models": [ { "name": "...", "model": "..." }, ... ] }
    let models: Vec<String> = body
        .get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    m.get("name")
                        .and_then(|v| v.as_str())
                        .or_else(|| m.get("model").and_then(|v| v.as_str()))
                        .map(|s| s.to_string())
                })
                .collect()
        })
        .unwrap_or_default();

    let message = format!("Ollama reachable, {} model(s)", models.len());
    Ok(ConnectionHealth {
        reachable: true,
        transport_ok: true,
        models,
        latency_ms,
        message,
    })
}

async fn probe_openai(
    client: &reqwest::Client,
    base_url: &str,
    started: Instant,
    secret: Option<&str>,
) -> Result<ConnectionHealth, String> {
    let url = openai_models_url(base_url);
    let resp = match apply_openai_auth(client.get(&url), secret).send().await {
        Ok(r) => r,
        Err(err) => {
            return Ok(ConnectionHealth {
                reachable: false,
                transport_ok: false,
                models: Vec::new(),
                latency_ms: started.elapsed().as_millis() as u64,
                message: connection_error_message(&err),
            });
        }
    };

    let status = resp.status();
    let latency_ms = started.elapsed().as_millis() as u64;

    // 401/403: the host is up and speaking HTTP but rejected us for lack of a
    // key. The model list is auth-gated; we treat this as reachable but not
    // transport_ok (the caller must attach a key).
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Ok(ConnectionHealth {
            reachable: true,
            transport_ok: false,
            models: Vec::new(),
            latency_ms,
            message: format!(
                "HTTP {} — endpoint reachable, check the API key",
                status.as_u16()
            ),
        });
    }

    if !status.is_success() {
        return Ok(ConnectionHealth {
            reachable: true,
            transport_ok: false,
            models: Vec::new(),
            latency_ms,
            message: format!(
                "HTTP {} from {url} — host reachable but the model list failed",
                status.as_u16()
            ),
        });
    }

    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(err) => {
            log::warn!("OpenAI /models body was not JSON: {err}");
            return Ok(ConnectionHealth {
                reachable: true,
                transport_ok: false,
                models: Vec::new(),
                latency_ms,
                message: "Endpoint responded but did not speak the OpenAI API — check the base URL"
                    .to_string(),
            });
        }
    };

    // OpenAI: { "data": [ { "id": "..." }, ... ] }. Some llama.cpp/LM Studio
    // builds return the same shape; a few return a bare array — handle both.
    let models: Vec<String> = body
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| body.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    if models.is_empty() {
        return Ok(ConnectionHealth {
            reachable: true,
            transport_ok: false,
            models,
            latency_ms,
            message: "Endpoint responded but no OpenAI-style model list was found".to_string(),
        });
    }

    let message = format!("Reachable, {} model(s)", models.len());
    Ok(ConnectionHealth {
        reachable: true,
        transport_ok: true,
        models,
        latency_ms,
        message,
    })
}

/// Anthropic has no public model-list endpoint. We probe `{base}/v1/models`
/// (Anthropic *does* expose `/v1/models` on the Messages API base) — a 200
/// (newer accounts) or a 401 (key required) both prove the Messages API is
/// reachable and speaking the Anthropic protocol. We document this pragmatic
/// choice here as the locked B.2 behavior for the `anthropic` transport.
async fn probe_anthropic(
    client: &reqwest::Client,
    base_url: &str,
    started: Instant,
    secret: Option<&str>,
) -> Result<ConnectionHealth, String> {
    let url = anthropic_models_url(base_url);
    if secret.map(|s| s.trim()).filter(|s| !s.is_empty()).is_none() {
        return Ok(ConnectionHealth {
            reachable: true,
            transport_ok: false,
            models: Vec::new(),
            latency_ms: started.elapsed().as_millis() as u64,
            message: "Anthropic connection requires an API key before it can be used".to_string(),
        });
    }

    let resp = match apply_anthropic_auth(client.get(&url), secret).send().await {
        Ok(r) => r,
        Err(err) => {
            return Ok(ConnectionHealth {
                reachable: false,
                transport_ok: false,
                models: Vec::new(),
                latency_ms: started.elapsed().as_millis() as u64,
                message: connection_error_message(&err),
            });
        }
    };

    let status = resp.status();
    let latency_ms = started.elapsed().as_millis() as u64;

    if status.is_success() {
        // A 2xx with a non-JSON body (captive portal / proxy returning HTML) is
        // NOT the Anthropic API — only a parseable JSON body counts as
        // transport_ok. Match the other probes' pattern in this file.
        let body: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(err) => {
                log::warn!("Anthropic /models body was not JSON: {err}");
                return Ok(ConnectionHealth {
                    reachable: true,
                    transport_ok: false,
                    models: Vec::new(),
                    latency_ms,
                    message:
                        "Endpoint responded but did not speak the Anthropic API — check the base URL"
                            .to_string(),
                });
            }
        };
        // Newer Anthropic accounts expose a model list: { "data": [ { "id" } ] }.
        let models: Vec<String> = body
            .get("data")
            .and_then(|d| d.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let message = if models.is_empty() {
            "Anthropic Messages API reachable".to_string()
        } else {
            format!("Anthropic reachable, {} model(s)", models.len())
        };
        return Ok(ConnectionHealth {
            reachable: true,
            transport_ok: true,
            models,
            latency_ms,
            message,
        });
    }

    // 401/403 with a supplied key means the endpoint is reachable but the key
    // is invalid or lacks access. Do not report Ready.
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Ok(ConnectionHealth {
            reachable: true,
            transport_ok: false,
            models: Vec::new(),
            latency_ms,
            message: format!(
                "Anthropic API rejected the configured key (HTTP {})",
                status.as_u16()
            ),
        });
    }

    Ok(ConnectionHealth {
        reachable: true,
        transport_ok: false,
        models: Vec::new(),
        latency_ms,
        message: format!(
            "HTTP {} from {url} — host reachable but it does not look like the Anthropic API",
            status.as_u16()
        ),
    })
}

fn non_empty_secret(secret: Option<&str>) -> Option<&str> {
    secret.map(str::trim).filter(|value| !value.is_empty())
}

fn apply_openai_auth(
    request: reqwest::RequestBuilder,
    secret: Option<&str>,
) -> reqwest::RequestBuilder {
    match non_empty_secret(secret) {
        Some(secret) => request.bearer_auth(secret),
        None => request,
    }
}

fn apply_anthropic_auth(
    request: reqwest::RequestBuilder,
    secret: Option<&str>,
) -> reqwest::RequestBuilder {
    let request = request.header("anthropic-version", "2023-06-01");
    match non_empty_secret(secret) {
        Some(secret) => request.header("x-api-key", secret),
        None => request,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_headers(request: reqwest::RequestBuilder) -> reqwest::header::HeaderMap {
        request
            .build()
            .expect("request should build")
            .headers()
            .clone()
    }

    #[test]
    fn openai_health_probe_uses_bearer_secret_when_present() {
        let client = reqwest::Client::new();
        let headers = request_headers(apply_openai_auth(
            client.get("https://api.example.com/v1/models"),
            Some(" sk-live "),
        ));

        assert_eq!(
            headers.get(reqwest::header::AUTHORIZATION).unwrap(),
            "Bearer sk-live"
        );
    }

    #[test]
    fn openai_health_probe_omits_auth_for_keyless_runtimes() {
        let client = reqwest::Client::new();
        let headers = request_headers(apply_openai_auth(
            client.get("http://127.0.0.1:11434/v1/models"),
            Some("   "),
        ));

        assert!(headers.get(reqwest::header::AUTHORIZATION).is_none());
    }

    #[test]
    fn anthropic_health_probe_uses_required_auth_headers() {
        let client = reqwest::Client::new();
        let headers = request_headers(apply_anthropic_auth(
            client.get("https://api.anthropic.com/v1/models"),
            Some("sk-ant"),
        ));

        assert_eq!(headers.get("x-api-key").unwrap(), "sk-ant");
        assert_eq!(headers.get("anthropic-version").unwrap(), "2023-06-01");
    }

    #[test]
    fn runtime_health_rejects_secret_on_remote_plain_http() {
        let err = tauri::async_runtime::block_on(runtime_health(HealthInput {
            connection_id: "remote-http".to_string(),
            base_url: "http://192.0.2.10:8000/v1".to_string(),
            transport: "openai-compatible".to_string(),
            secret: Some("sk-unsafe".to_string()),
        }))
        .expect_err("remote plain HTTP secret transport must be rejected");

        assert!(err.contains("HTTPS or a loopback HTTP runtime"));
    }

    #[test]
    fn runtime_health_rejects_unknown_transport() {
        let err = tauri::async_runtime::block_on(runtime_health(HealthInput {
            connection_id: "unknown-transport".to_string(),
            base_url: "http://127.0.0.1:11434/v1".to_string(),
            transport: "guessed-provider".to_string(),
            secret: None,
        }))
        .expect_err("unknown transport must fail closed");

        assert_eq!(err, "Unsupported runtime transport: guessed-provider");
    }

    #[test]
    fn ollama_health_probe_uses_native_api_root_when_base_url_has_v1() {
        assert_eq!(
            ollama_tags_url("http://127.0.0.1:11434/v1"),
            "http://127.0.0.1:11434/api/tags"
        );
        assert_eq!(
            ollama_tags_url("http://127.0.0.1:11434/v1/"),
            "http://127.0.0.1:11434/api/tags"
        );
    }
}
