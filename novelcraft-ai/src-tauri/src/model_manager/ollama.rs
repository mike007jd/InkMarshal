//! Ollama provider probes: list local tags and stream a model pull.

use super::{api_client, PullProgress};
use crate::http_util::{download_client, http_err, ollama_base, validate_runtime_base_url};
use futures_util::StreamExt;
use tauri::ipc::Channel;

/// GET {base}/api/tags → the installed tag names.
#[tauri::command]
pub async fn ollama_list_tags(base_url: String) -> Result<Vec<String>, String> {
    let client = api_client()?;
    let base_url = validate_runtime_base_url(&base_url)?;
    let url = format!("{}/api/tags", ollama_base(&base_url));
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| http_err(&format!("Couldn't reach Ollama at {url}"), &e))?;
    if !resp.status().is_success() {
        return Err(format!("Ollama returned HTTP {} for {url}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| {
        log::warn!("Ollama /api/tags returned invalid JSON: {e}");
        "Ollama responded but did not return a valid model list".to_string()
    })?;
    let tags = body
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
    Ok(tags)
}

/// POST {base}/api/pull with `{"name": model, "stream": true}`, stream the
/// response body, split on newlines, parse each NDJSON object into
/// `PullProgress`, and forward over the channel. Ok(()) on stream end.
#[tauri::command]
pub async fn ollama_pull(
    base_url: String,
    model: String,
    on_progress: Channel<PullProgress>,
) -> Result<(), String> {
    let client = download_client()?;
    let base_url = validate_runtime_base_url(&base_url)?;
    let url = format!("{}/api/pull", ollama_base(&base_url));
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "name": model, "stream": true }))
        .send()
        .await
        .map_err(|e| http_err(&format!("Couldn't reach Ollama at {url}"), &e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Ollama returned HTTP {} when pulling {model}",
            resp.status()
        ));
    }

    // Cap the line-accumulation buffer: a well-behaved Ollama emits a newline
    // every progress tick, so a buffer that grows past 1 MiB with no newline
    // means the stream is malformed (or not Ollama). Bail instead of OOMing.
    const MAX_LINE_BUF: usize = 1024 * 1024;

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| http_err("Ollama pull stream error", &e))?;
        buf.extend_from_slice(&chunk);

        if buf.len() > MAX_LINE_BUF && !buf.contains(&b'\n') {
            return Err("Unexpected response from Ollama (malformed stream)".to_string());
        }

        // Drain every complete NDJSON line currently in the buffer.
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            let line = &line[..line.len() - 1]; // drop the '\n'
            let trimmed = line
                .iter()
                .copied()
                .skip_while(|b| b.is_ascii_whitespace())
                .collect::<Vec<u8>>();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&trimmed) {
                forward_pull_line(&val, &on_progress)?;
                if val
                    .get("error")
                    .and_then(|e| e.as_str())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false)
                {
                    let msg = val
                        .get("error")
                        .and_then(|e| e.as_str())
                        .unwrap_or("unknown error");
                    return Err(format!("Ollama pull failed: {msg}"));
                }
            }
        }
    }

    // Flush any trailing partial line (Ollama usually ends with a newline, but
    // be defensive against a final newline-less object).
    let tail: Vec<u8> = buf
        .iter()
        .copied()
        .skip_while(|b| b.is_ascii_whitespace())
        .collect();
    if !tail.is_empty() {
        if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&tail) {
            forward_pull_line(&val, &on_progress)?;
        }
    }

    Ok(())
}

fn forward_pull_line(
    val: &serde_json::Value,
    on_progress: &Channel<PullProgress>,
) -> Result<(), String> {
    let progress = PullProgress {
        status: val
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string(),
        digest: val
            .get("digest")
            .and_then(|s| s.as_str())
            .map(|s| s.to_string()),
        total: val.get("total").and_then(|v| v.as_u64()),
        completed: val.get("completed").and_then(|v| v.as_u64()),
    };
    on_progress
        .send(progress)
        .map_err(|e| format!("Failed to forward pull progress: {e}"))
}

// ── Hugging Face search / listing ───────────────────────────────────────────
