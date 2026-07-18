//! Engine readiness probing following llama.cpp's /health contract with a
//! /v1/models 2xx fallback, plus the bounded wait loop with child-exit fast-fail.

use super::registry::{engine_process_exited, EngineRegistry};
use std::time::{Duration, Instant};

/// Outcome of a single readiness probe against a candidate engine port.
enum ReadinessProbe {
    /// The engine reported it is serving requests (model fully loaded).
    Ready,
    /// The engine is up but still loading the model — keep waiting. This is
    /// llama.cpp's documented `/health` contract: HTTP 503 while the model is
    /// loading, HTTP 200 once it is ready.
    Loading,
    /// The server is alive but model loading has terminally failed.
    Failed(String),
    /// The port is not (yet) answering — connection refused, timeout, or any
    /// other transport error. Treated the same as `Loading` for retry purposes
    /// but kept distinct for clarity.
    NotUp,
}

fn model_load_error(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    if value.pointer("/error/type")?.as_str()? != "model_load_error" {
        return None;
    }
    let message = value
        .pointer("/error/message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("The MLX model could not be loaded")
        .trim();
    let message = if message.is_empty() {
        "The MLX model could not be loaded"
    } else {
        message
    };
    Some(message.chars().take(500).collect())
}

/// Probe an engine's readiness following llama.cpp's `/health` contract, with a
/// fallback to the OpenAI-compatible `/v1/models` 2xx check for servers that do
/// not expose `/health`.
///
/// - `GET /health` → 200 ⇒ `Ready`, 503 ⇒ `Loading` (model still loading).
/// - `GET /health` → 404 / not-found ⇒ server lacks the endpoint; fall back to
///   `GET /v1/models` and treat any 2xx as `Ready`.
async fn engine_port_ready(port: u16, timeout_secs: u64) -> ReadinessProbe {
    let Ok(client) = crate::http_util::short_client(timeout_secs) else {
        return ReadinessProbe::NotUp;
    };

    let health_url = format!("http://127.0.0.1:{port}/health");
    match client.get(&health_url).send().await {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                return ReadinessProbe::Ready;
            }
            if status == reqwest::StatusCode::SERVICE_UNAVAILABLE {
                let body = resp.text().await.unwrap_or_default();
                if let Some(error) = model_load_error(&body) {
                    return ReadinessProbe::Failed(error);
                }
                // llama.cpp and mlx-server both use 503 while loading.
                return ReadinessProbe::Loading;
            }
            if status != reqwest::StatusCode::NOT_FOUND {
                // The server answered but with neither 200 nor 503 nor 404
                // (e.g. transient 5xx during boot). Keep waiting rather than
                // falling through to /v1/models for an ambiguous status.
                return ReadinessProbe::Loading;
            }
            // 404: this server does not expose /health (mlx-server). Fall
            // through to the legacy /v1/models 2xx check below.
        }
        // Transport error reaching /health: port not up yet, keep waiting.
        Err(_) => return ReadinessProbe::NotUp,
    }

    let models_url = format!("http://127.0.0.1:{port}/v1/models");
    match client.get(&models_url).send().await {
        Ok(resp) if resp.status().is_success() => ReadinessProbe::Ready,
        Ok(resp) => {
            let body = resp.text().await.unwrap_or_default();
            model_load_error(&body)
                .map(ReadinessProbe::Failed)
                .unwrap_or(ReadinessProbe::Loading)
        }
        Err(_) => ReadinessProbe::NotUp,
    }
}

/// Wait until the engine on `port` reports ready, bounded by `timeout`.
///
/// `engine_id` lets us fast-fail: inside the poll loop we `try_wait()` the
/// registered child, so if the engine process has already exited (bad model,
/// OOM, wrong arch) we return `false` immediately instead of blocking the full
/// readiness ceiling. The `timeout` stays the hard upper bound for a process
/// that stays alive but never finishes loading.
pub(super) async fn wait_engine_ready(
    registry: &EngineRegistry,
    engine_id: &str,
    port: u16,
    timeout: Duration,
) -> Result<bool, String> {
    let deadline = Instant::now() + timeout;
    loop {
        // Fast-fail: if the child has already exited there is no point waiting
        // out the rest of the readiness window — the port will never serve.
        if engine_process_exited(registry, engine_id) {
            return Ok(false);
        }
        match engine_port_ready(port, 3).await {
            ReadinessProbe::Ready => return Ok(true),
            ReadinessProbe::Failed(error) => return Err(error),
            ReadinessProbe::Loading | ReadinessProbe::NotUp => {}
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::model_load_error;

    #[test]
    fn extracts_terminal_model_load_error() {
        let body = r#"{"error":{"message":"missing tokenizer.json","type":"model_load_error"}}"#;
        assert_eq!(
            model_load_error(body).as_deref(),
            Some("missing tokenizer.json")
        );
    }

    #[test]
    fn loading_and_invalid_bodies_are_not_terminal() {
        assert_eq!(
            model_load_error(r#"{"error":{"message":"loading","type":"model_loading"}}"#),
            None
        );
        assert_eq!(model_load_error("not json"), None);
    }
}
