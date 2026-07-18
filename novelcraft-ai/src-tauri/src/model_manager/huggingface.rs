//! Hugging Face search/listing + resumable single-file (.part + Range + sha256)
//! and multi-file snapshot downloads.

use super::local::upsert_installed_metadata;
use super::paths::{
    managed_download_dir, managed_download_file_path, managed_snapshot_destination_dir,
    managed_snapshot_file_path, model_dir_for, snapshot_checkpoint_dir,
};
use super::{
    api_client, current_unix, DownloadArgs, DownloadPhase, DownloadProgress, DownloadRegistry,
    HfModelFile, HfSearchResult, InstalledModelMetadata, SnapshotArgs,
};
use crate::http_util::{download_client, encode_query, http_err, io_err};
use crate::inkmarshal_home;
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::io::AsyncWriteExt;
use url::{Host, Url};

pub const HF_OFFICIAL_ENDPOINT: &str = "https://huggingface.co";
#[cfg(test)]
pub const HF_MIRROR_ENDPOINT: &str = "https://hf-mirror.com";
const HF_ENDPOINT_SETTING_FILE: &str = "hf-endpoint.txt";
pub(super) const HF_SEARCH_MAX_LIMIT: u32 = 50;
pub(super) const HF_SEARCH_MAX_QUERY_CHARS: usize = 120;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HfEndpointStatus {
    configured_endpoint: Option<String>,
    effective_endpoint: String,
    source: String,
}

fn hf_endpoint_settings_path() -> Result<PathBuf, String> {
    Ok(inkmarshal_home::inkmarshal_app_dir()?.join(HF_ENDPOINT_SETTING_FILE))
}

pub(super) fn normalize_hf_endpoint(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Model download source URL is required".to_string());
    }
    let parsed =
        Url::parse(trimmed).map_err(|_| "Model download source must be a valid URL".to_string())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Model download source URL cannot contain credentials".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Model download source URL cannot contain a query or fragment".to_string());
    }
    let is_loopback = match parsed.host() {
        Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    match parsed.scheme() {
        "https" => {}
        "http" if is_loopback => {}
        _ => {
            return Err(
                "Model download source must use HTTPS (HTTP is allowed only for localhost)"
                    .to_string(),
            )
        }
    }
    Ok(trimmed.to_string())
}

fn read_configured_hf_endpoint() -> Result<Option<String>, String> {
    let path = hf_endpoint_settings_path()?;
    let raw = match std::fs::read_to_string(path) {
        Ok(value) => value,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(io_err(
                "Couldn't read the model download source setting",
                &err,
            ))
        }
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    normalize_hf_endpoint(trimmed).map(Some)
}

pub(super) fn resolve_hf_endpoint_from(
    environment: Option<&str>,
    configured: Option<&str>,
) -> Result<(String, &'static str), String> {
    if let Some(value) = environment.filter(|value| !value.trim().is_empty()) {
        return normalize_hf_endpoint(value).map(|endpoint| (endpoint, "environment"));
    }
    if let Some(value) = configured.filter(|value| !value.trim().is_empty()) {
        return normalize_hf_endpoint(value).map(|endpoint| (endpoint, "setting"));
    }
    Ok((HF_OFFICIAL_ENDPOINT.to_string(), "default"))
}

fn hf_endpoint_status() -> Result<HfEndpointStatus, String> {
    let configured = read_configured_hf_endpoint()?;
    let environment = std::env::var("HF_ENDPOINT").ok();
    let (effective_endpoint, source) =
        resolve_hf_endpoint_from(environment.as_deref(), configured.as_deref())?;
    Ok(HfEndpointStatus {
        configured_endpoint: configured,
        effective_endpoint,
        source: source.to_string(),
    })
}

fn effective_hf_endpoint() -> Result<String, String> {
    Ok(hf_endpoint_status()?.effective_endpoint)
}

#[tauri::command]
pub fn hf_get_endpoint() -> Result<HfEndpointStatus, String> {
    hf_endpoint_status()
}

#[tauri::command]
pub fn hf_set_endpoint(endpoint: Option<String>) -> Result<HfEndpointStatus, String> {
    let path = hf_endpoint_settings_path()?;
    let normalized = endpoint.as_deref().map(normalize_hf_endpoint).transpose()?;
    let should_use_default = match normalized.as_deref() {
        None => true,
        Some(value) => value == HF_OFFICIAL_ENDPOINT,
    };

    if should_use_default {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(io_err(
                    "Couldn't reset the model download source setting",
                    &err,
                ))
            }
        }
    } else if let Some(value) = normalized {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| io_err("Couldn't prepare the app settings folder", &err))?;
        }
        if std::fs::symlink_metadata(&path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("Model download source setting cannot be a symlink".to_string());
        }
        std::fs::write(&path, value.as_bytes())
            .map_err(|err| io_err("Couldn't save the model download source setting", &err))?;
    }
    hf_endpoint_status()
}

fn with_hf_source_hint(message: impl Into<String>) -> String {
    format!(
        "{}. Switch the model download source in Settings if this endpoint is unavailable.",
        message.into().trim_end_matches('.')
    )
}

fn hf_model_url(endpoint: &str, repo_id: &str, filename: &str) -> String {
    format!(
        "{endpoint}/{}/resolve/main/{}",
        hf_path(repo_id),
        hf_path(filename)
    )
}

// ── Streaming payloads (camelCase on the wire — LOCKED with B.1) ────────────

/// Map a caller-supplied format string to the canonical HF filter value.
/// "mlx" → "mlx"; anything else (including "gguf", None, unknown) → "gguf".
pub fn hf_filter_for(format: &str) -> &'static str {
    match format.to_ascii_lowercase().as_str() {
        "mlx" => "mlx",
        _ => "gguf",
    }
}

pub(super) fn normalize_hf_search_request(query: &str, limit: u32) -> (String, u32) {
    let query = query
        .trim()
        .chars()
        .filter(|ch| !ch.is_control())
        .take(HF_SEARCH_MAX_QUERY_CHARS)
        .collect::<String>();
    let limit = limit.clamp(1, HF_SEARCH_MAX_LIMIT);
    (query, limit)
}

/// GET {configured endpoint}/api/models?search=&filter={gguf|mlx}&sort=downloads&direction=-1
/// &limit=&full=true → `[{ repo, downloads, format }]`.
/// `format` defaults to `"gguf"` when `None` or unrecognised.
#[tauri::command]
pub async fn hf_search_models(
    query: String,
    format: Option<String>,
    limit: u32,
) -> Result<Vec<HfSearchResult>, String> {
    let endpoint = effective_hf_endpoint()?;
    hf_search_models_at(&endpoint, query, format, limit).await
}

pub(super) async fn hf_search_models_at(
    endpoint: &str,
    query: String,
    format: Option<String>,
    limit: u32,
) -> Result<Vec<HfSearchResult>, String> {
    let filter = hf_filter_for(format.as_deref().unwrap_or("gguf"));
    let (query, limit) = normalize_hf_search_request(&query, limit);
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let client = api_client()?;
    let url = format!(
        "{endpoint}/api/models?search={}&filter={filter}&sort=downloads&direction=-1&limit={}&full=true",
        crate::http_util::encode_query(&query),
        limit
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| with_hf_source_hint(http_err("Couldn't reach Hugging Face", &e)))?;
    if !resp.status().is_success() {
        return Err(with_hf_source_hint(format!(
            "Hugging Face search returned HTTP {}",
            resp.status()
        )));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| {
        log::warn!("Hugging Face search returned invalid JSON: {e}");
        "Hugging Face returned an unexpected response for the model search".to_string()
    })?;
    let results = body
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let repo = m
                        .get("id")
                        .and_then(|v| v.as_str())
                        .or_else(|| m.get("modelId").and_then(|v| v.as_str()))?
                        .to_string();
                    let downloads = m.get("downloads").and_then(|v| v.as_u64()).unwrap_or(0);
                    Some(HfSearchResult {
                        repo,
                        downloads,
                        format: filter.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(results)
}

/// Derive a quant label (e.g. `Q4_K_M`, `IQ3_XXS`, `Q8_0`) from a GGUF
/// filename when one is present, else `None`.
pub(super) fn quant_from_filename(filename: &str) -> Option<String> {
    let stem = filename.rsplit('/').next().unwrap_or(filename);
    // Scan the raw (upper-cased) stem for a known GGUF quant token. Multi-part
    // names like Q4_K_M are matched whole; longest match wins so Q4_K_M is not
    // shadowed by a bare Q4.
    let upper = stem.to_uppercase();
    // Common GGUF quant patterns, longest first so Q4_K_M wins over Q4.
    const PATTERNS: &[&str] = &[
        "Q2_K", "Q3_K_S", "Q3_K_M", "Q3_K_L", "Q4_K_S", "Q4_K_M", "Q5_K_S", "Q5_K_M", "Q6_K",
        "Q8_0", "Q4_0", "Q4_1", "Q5_0", "Q5_1", "IQ1_S", "IQ1_M", "IQ2_XXS", "IQ2_XS", "IQ2_S",
        "IQ2_M", "IQ3_XXS", "IQ3_XS", "IQ3_S", "IQ3_M", "IQ4_XS", "IQ4_NL", "F16", "F32", "BF16",
    ];
    let mut best: Option<&str> = None;
    for p in PATTERNS {
        if upper.contains(p) {
            match best {
                Some(b) if b.len() >= p.len() => {}
                _ => best = Some(p),
            }
        }
    }
    best.map(|s| s.to_string())
}

/// GET {configured endpoint}/api/models/{repo}/tree/main?recursive=true → filtered
/// `HfModelFile` list. For `gguf` (default): every `.gguf` entry — exact same
/// inclusion predicate, ordering and field values as pre-C1 (byte-identical for
/// the gguf path). For `mlx`: the current MLX snapshot sidecars, tokenizer
/// assets and model weights.
/// `format` defaults to `"gguf"` when `None` or unrecognised.
#[tauri::command]
pub async fn hf_list_gguf_files(
    repo_id: String,
    format: Option<String>,
) -> Result<Vec<HfModelFile>, String> {
    let endpoint = effective_hf_endpoint()?;
    hf_list_gguf_files_at(&endpoint, repo_id, format).await
}

pub(super) async fn hf_list_gguf_files_at(
    endpoint: &str,
    repo_id: String,
    format: Option<String>,
) -> Result<Vec<HfModelFile>, String> {
    let resolved_format = hf_filter_for(format.as_deref().unwrap_or("gguf"));
    let client = api_client()?;
    let url = format!(
        "{endpoint}/api/models/{}/tree/main?recursive=true",
        hf_path(&repo_id)
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| with_hf_source_hint(http_err("Couldn't reach Hugging Face", &e)))?;
    if !resp.status().is_success() {
        return Err(with_hf_source_hint(format!(
            "Hugging Face tree for {repo_id} returned HTTP {}",
            resp.status()
        )));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| {
        log::warn!("Hugging Face tree returned invalid JSON: {e}");
        "Hugging Face returned an unexpected response for the file listing".to_string()
    })?;

    let files = body
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    let path = entry.get("path").and_then(|v| v.as_str())?;
                    let include = if resolved_format == "mlx" {
                        allowed_mlx_snapshot_filename(path)
                    } else {
                        // GGUF path — byte-identical predicate to pre-C1
                        path.to_lowercase().ends_with(".gguf")
                    };
                    if !include {
                        return None;
                    }
                    let lfs = entry.get("lfs");
                    let size_bytes = lfs
                        .and_then(|l| l.get("size"))
                        .and_then(|v| v.as_u64())
                        .or_else(|| entry.get("size").and_then(|v| v.as_u64()))
                        .unwrap_or(0);
                    let sha256 = lfs
                        .and_then(|l| l.get("oid"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.strip_prefix("sha256:").unwrap_or(s).to_string());
                    let quant = if resolved_format == "gguf" {
                        quant_from_filename(path)
                    } else {
                        None
                    };
                    Some(HfModelFile {
                        repo: repo_id.clone(),
                        filename: path.to_string(),
                        size_bytes,
                        quant,
                        sha256,
                        format: resolved_format.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(files)
}

pub(super) fn allowed_mlx_snapshot_filename(filename: &str) -> bool {
    let lower = filename.to_lowercase();
    if lower.ends_with(".safetensors") || lower.ends_with(".safetensors.index.json") {
        return true;
    }
    if lower.contains('/') || lower.contains('\\') {
        return false;
    }
    matches!(
        lower.as_str(),
        "chat_template.jinja"
            | "config.json"
            | "generation_config.json"
            | "kv_config.json"
            | "optiq_metadata.json"
            | "special_tokens_map.json"
            | "tokenizer.json"
            | "tokenizer.model"
            | "tokenizer_config.json"
    )
}

pub(super) fn allowed_mlx_snapshot_file(file: &HfModelFile) -> bool {
    if file.format != "mlx" {
        return false;
    }
    allowed_mlx_snapshot_filename(&file.filename)
}

// ── HF resumable download ───────────────────────────────────────────────────

/// The deterministic GGUF download task id (see module-level contract).
pub(super) fn task_id(repo_id: &str, filename: &str) -> String {
    format!(
        "hf:gguf:v2:{}/{}",
        encode_query(repo_id),
        encode_query(filename)
    )
}

pub(super) fn hf_path(input: &str) -> String {
    input
        .split('/')
        .map(encode_query)
        .collect::<Vec<_>>()
        .join("/")
}

pub(super) fn emit(
    on_progress: &Channel<DownloadProgress>,
    received: u64,
    total: u64,
    phase: DownloadPhase,
    message: Option<String>,
) {
    // A failed channel send means the JS listener is gone; the download will
    // still finish/clean up on the Rust side, so we don't hard-fail on it.
    let _ = on_progress.send(DownloadProgress {
        received_bytes: received,
        total_bytes: total,
        phase,
        message,
    });
}

/// Resumable, integrity-verified GGUF download.
///
/// GET `{configured endpoint}/{repo}/resolve/main/{file}` (redirects to
/// cdn-lfs are followed by reqwest's default redirect policy). Streams into
/// `{dest}.part`; if that file already exists we resume with a `Range` header
/// and append. Progress is throttled (≥256 KiB or ≥200 ms). The registry
/// cancel flag is checked between chunks. On completion, if `expected_sha256`
/// is given, the full file is hashed and compared case-insensitively; on
/// match the `.part` is renamed to `dest_path`. The task is always
/// deregistered from the registry.
#[tauri::command]
pub async fn hf_download_gguf(
    args: DownloadArgs,
    on_progress: Channel<DownloadProgress>,
    registry: tauri::State<'_, DownloadRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let tid = task_id(&args.repo_id, &args.filename);
    let cancel = registry.register(&tid)?;

    let safe_dest = model_dir_for(&app)
        .and_then(|root| managed_download_file_path(&root, &args.dest_path, Some("gguf")));
    let result = match safe_dest {
        Ok(dest) => {
            let mut safe_args = args.clone();
            safe_args.dest_path = dest.to_string_lossy().into_owned();
            let result = download_inner(&safe_args, &on_progress, &cancel).await;
            if result.is_ok() {
                let label = dest
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&args.filename)
                    .to_string();
                let _ = upsert_installed_metadata(
                    &app,
                    &safe_args.dest_path,
                    InstalledModelMetadata {
                        label,
                        source_repo: args.repo_id.clone(),
                        format: "gguf".to_string(),
                        installed_at_unix: current_unix(),
                    },
                );
            }
            result
        }
        Err(err) => Err(err),
    };

    // Always deregister, success or failure.
    registry.deregister(&tid);
    result
}

pub(super) async fn download_inner(
    args: &DownloadArgs,
    on_progress: &Channel<DownloadProgress>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let endpoint = effective_hf_endpoint()?;
    download_inner_at(args, on_progress, cancel, &endpoint).await
}

pub(super) async fn download_inner_at(
    args: &DownloadArgs,
    on_progress: &Channel<DownloadProgress>,
    cancel: &Arc<AtomicBool>,
    endpoint: &str,
) -> Result<(), String> {
    let dest = Path::new(&args.dest_path);
    let part_path = format!("{}.part", args.dest_path);
    let part = Path::new(&part_path);

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| io_err("Couldn't save the model", &e))?;
    }

    // Resume support: how many bytes are already on disk in the `.part` file.
    let existing_len = partial_download_len(part)?;

    let url = hf_model_url(endpoint, &args.repo_id, &args.filename);

    // 416 retry guard: download_one_file handles the normal flow; if it asks
    // for a clean restart (existing_len > 0 triggered a 416) we delete the
    // stale `.part` and recurse once from scratch.
    let result = download_one_file(DownloadOneFileArgs {
        url: &url,
        dest_path: &args.dest_path,
        expected_sha256: args.expected_sha256.as_deref(),
        expected_size: args.expected_size_bytes,
        on_progress,
        cancel,
        base_received: 0,
        base_total: 0,
        existing_len,
    })
    .await;

    // If download_one_file returned the special "416-restart" sentinel, delete
    // the stale `.part` and retry the whole thing from scratch.
    if let Err(ref msg) = result {
        if msg == "__416_restart__" {
            let _ = tokio::fs::remove_file(part).await;
            return Box::pin(download_inner_at(args, on_progress, cancel, endpoint)).await;
        }
    }

    result.map(|_| ())
}

pub(super) fn partial_download_len(part: &Path) -> Result<u64, String> {
    Ok(regular_partial_download_metadata(part)?
        .map(|md| md.len())
        .unwrap_or(0))
}

pub(super) fn regular_partial_download_metadata(
    part: &Path,
) -> Result<Option<std::fs::Metadata>, String> {
    match std::fs::symlink_metadata(part) {
        Ok(md) => {
            if md.file_type().is_symlink() {
                return Err("Partial model download path cannot be a symlink".to_string());
            }
            if !md.is_file() {
                return Err("Partial model download path is not a regular file".to_string());
            }
            Ok(Some(md))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(io_err("Couldn't inspect the partial model download", &err)),
    }
}

pub(super) fn open_partial_download_file(
    part: &Path,
    append: bool,
) -> Result<tokio::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true);
    if append {
        options.append(true);
    } else {
        options.create(true).truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(part)
        .map_err(|e| io_err("Couldn't save the model", &e))?;
    Ok(tokio::fs::File::from_std(file))
}

pub(super) async fn replace_download_file(part: &Path, dest: &Path) -> Result<(), String> {
    tokio::fs::rename(part, dest)
        .await
        .map_err(|e| io_err("Couldn't finalize the download", &e))
}

/// Download a single remote file to `dest_path` (resumable via `.part` + Range
/// only when a digest is available, integrity-checked if `expected_sha256` is
/// `Some`, atomic rename on success).
///
/// Progress is emitted as part of an **aggregate**: `base_received` / `base_total`
/// are the bytes already completed / grand total across a multi-file job.
/// Pass `base_received = 0` and `base_total = 0` (sentinel: compute from this
/// file) for the single-file GGUF case — the emitted `received_bytes` /
/// `total_bytes` will then be identical to the pre-refactor behaviour.
///
/// `existing_len` is the byte-count already on disk in the `.part` file (caller
/// computes it so the 416 retry in `download_inner` can re-invoke cleanly).
///
/// Returns the number of bytes this file contributed, or a `String` error.
/// The special sentinel error `"__416_restart__"` means the server rejected our
/// Range header (HTTP 416); the caller should delete the `.part` and retry.
pub(super) struct DownloadOneFileArgs<'a> {
    url: &'a str,
    dest_path: &'a str,
    expected_sha256: Option<&'a str>,
    expected_size: Option<u64>,
    on_progress: &'a Channel<DownloadProgress>,
    cancel: &'a Arc<AtomicBool>,
    base_received: u64,
    base_total: u64,
    existing_len: u64,
}

pub(super) async fn download_one_file(args: DownloadOneFileArgs<'_>) -> Result<u64, String> {
    let DownloadOneFileArgs {
        url,
        dest_path,
        expected_sha256,
        expected_size,
        on_progress,
        cancel,
        base_received,
        base_total,
        existing_len,
    } = args;
    let mut existing_len = existing_len;
    let dest = Path::new(dest_path);
    let part_path = format!("{dest_path}.part");
    let part = Path::new(&part_path);
    let has_expected_sha = has_expected_sha256(expected_sha256);
    if existing_len > 0 && !has_expected_sha {
        tokio::fs::remove_file(part).await.map_err(|e| {
            io_err(
                "Couldn't discard the unverifiable partial model download",
                &e,
            )
        })?;
        existing_len = 0;
    }
    let checked_existing_len = partial_download_len(part)?;
    if checked_existing_len != existing_len {
        return Err("Partial model download changed during validation — aborting".to_string());
    }

    let client = download_client()?;
    let mut request = client.get(url);
    if existing_len > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={existing_len}-"));
    }

    let resp = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = with_hf_source_hint(http_err("Couldn't reach Hugging Face", &e));
            emit(
                on_progress,
                base_received + existing_len,
                base_total,
                DownloadPhase::Error,
                Some(msg.clone()),
            );
            return Err(msg);
        }
    };

    let status = resp.status();
    // 416 = the server rejected our Range (e.g. file already complete on disk
    // or changed). Signal the caller to restart from zero.
    let resuming = status == reqwest::StatusCode::PARTIAL_CONTENT;
    if existing_len > 0 && status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        return Err("__416_restart__".to_string());
    }
    if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
        let msg = with_hf_source_hint(format!("Hugging Face returned HTTP {status} for {url}"));
        emit(
            on_progress,
            base_received + existing_len,
            base_total,
            DownloadPhase::Error,
            Some(msg.clone()),
        );
        return Err(msg);
    }

    // this_file_total = already-on-disk (if resuming) + Content-Length of this response.
    let body_len = resp.content_length().unwrap_or(0);
    let this_file_total: u64 = if resuming {
        existing_len + body_len
    } else {
        body_len
    };
    // Aggregate total: caller supplies base_total for multi-file jobs; for the
    // single-file case (base_total == 0 sentinel) we use this file's total so
    // emitted values are byte-identical to pre-refactor.
    let agg_total = if base_total == 0 {
        this_file_total
    } else {
        base_total
    };

    // If we are NOT resuming (200, not 206) any prior partial is stale.
    let mut file = open_partial_download_file(part, resuming && existing_len > 0)?;

    let mut received: u64 = if resuming { existing_len } else { 0 };
    emit(
        on_progress,
        base_received + received,
        agg_total,
        DownloadPhase::Downloading,
        None,
    );

    let mut stream = resp.bytes_stream();
    let mut last_emit = Instant::now();
    let mut since_emit: u64 = 0;

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            // Flush what we have so the `.part` stays resumable, then bail.
            let _ = file.flush().await;
            emit(
                on_progress,
                base_received + received,
                agg_total,
                DownloadPhase::Error,
                Some("cancelled".to_string()),
            );
            return Err("cancelled".to_string());
        }

        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = file.flush().await;
                let msg = with_hf_source_hint(http_err("Couldn't download the model", &e));
                emit(
                    on_progress,
                    base_received + received,
                    agg_total,
                    DownloadPhase::Error,
                    Some(msg.clone()),
                );
                return Err(msg);
            }
        };

        file.write_all(&chunk)
            .await
            .map_err(|e| io_err("Couldn't save the model", &e))?;
        received += chunk.len() as u64;
        since_emit += chunk.len() as u64;

        // Throttle: emit at most every ~256 KiB or ~200 ms.
        if since_emit >= 256 * 1024 || last_emit.elapsed() >= Duration::from_millis(200) {
            emit(
                on_progress,
                base_received + received,
                agg_total,
                DownloadPhase::Downloading,
                None,
            );
            since_emit = 0;
            last_emit = Instant::now();
        }
    }

    file.flush()
        .await
        .map_err(|e| io_err("Couldn't finalize the download", &e))?;
    drop(file);

    validate_downloaded_size(received, expected_size)?;

    // Final downloading tick so the UI shows 100% before verify/done.
    emit(
        on_progress,
        base_received + received,
        agg_total,
        DownloadPhase::Downloading,
        None,
    );

    // Integrity verification (if an expected digest was provided).
    if let Some(expected) = expected_sha256
        .map(|s| s.trim().trim_start_matches("sha256:"))
        .filter(|s| !s.is_empty())
    {
        emit(
            on_progress,
            base_received + received,
            agg_total,
            DownloadPhase::Verifying,
            Some("Verifying checksum".to_string()),
        );
        let actual = sha256_file(part).await?;
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(part).await;
            let msg = format!(
                "Checksum mismatch: expected {expected}, got {actual}. The partial file was deleted."
            );
            emit(
                on_progress,
                base_received + received,
                agg_total,
                DownloadPhase::Error,
                Some(msg.clone()),
            );
            return Err(msg);
        }
    }

    // Atomically swap the verified `.part` into place. Never remove the current
    // destination first: a failed rename must leave the known-good model usable.
    if regular_partial_download_metadata(part)?.is_none() {
        return Err("Partial model download path is missing".to_string());
    }
    replace_download_file(part, dest).await?;

    emit(
        on_progress,
        base_received + received,
        agg_total,
        DownloadPhase::Done,
        None,
    );
    Ok(received)
}

pub(super) fn has_expected_sha256(expected_sha256: Option<&str>) -> bool {
    expected_sha256
        .map(|s| s.trim().trim_start_matches("sha256:"))
        .is_some_and(|s| !s.is_empty())
}

pub(super) fn validate_downloaded_size(
    received: u64,
    expected_size: Option<u64>,
) -> Result<(), String> {
    if let Some(expected) = expected_size {
        if received != expected {
            return Err(format!(
                "Downloaded model file size mismatch: expected {expected} bytes, got {received} bytes."
            ));
        }
    }
    Ok(())
}

/// Stream the file through SHA-256 in 1 MiB chunks (never load a multi-GB
/// model fully into memory).
pub(super) async fn sha256_file(path: &Path) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    if regular_partial_download_metadata(path)?.is_none() {
        return Err("Partial model download path is missing".to_string());
    }
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| io_err("Couldn't verify the model", &e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| io_err("Couldn't verify the model", &e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

pub(super) fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// The deterministic snapshot task id (task id == repo_id for multi-file jobs).
pub(super) fn snapshot_task_id(repo_id: &str) -> String {
    repo_id.to_string()
}

/// Stable checkpoint key for a snapshot: a hash of the repo id + the full file
/// list (name, size, digest). Identical inputs → identical key (so a resumed
/// download reuses the same checkpoint dir); any change to the file set (a new
/// revision) → a different key, so incompatible checkpoints never mix (MM-01).
pub(super) fn snapshot_checkpoint_key(repo_id: &str, files: &[HfModelFile]) -> String {
    let mut lines: Vec<String> = files
        .iter()
        .map(|f| {
            format!(
                "{}\t{}\t{}",
                f.filename,
                f.size_bytes,
                f.sha256.as_deref().unwrap_or("")
            )
        })
        .collect();
    lines.sort();
    let mut hasher = Sha256::new();
    hasher.update(repo_id.as_bytes());
    hasher.update(b"\n");
    hasher.update(lines.join("\n").as_bytes());
    hex_lower(&hasher.finalize())[..16].to_string()
}

/// True when a finalized snapshot file from a previous run is already present and
/// valid (size matches, and digest matches when known), so it can be reused as-is
/// across download tasks. A file that exists but is a symlink/non-file, the wrong
/// size, or fails its checksum is deleted and reported incomplete so it will be
/// re-fetched (MM-01: skip completed+valid files, drop only the corrupt one).
pub(super) async fn snapshot_file_already_complete(
    dest_path: &Path,
    file: &HfModelFile,
) -> Result<bool, String> {
    let md = match tokio::fs::symlink_metadata(dest_path).await {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(io_err("Couldn't inspect the model snapshot file", &e)),
    };
    if md.file_type().is_symlink() || !md.is_file() || md.len() != file.size_bytes {
        let _ = tokio::fs::remove_file(dest_path).await;
        return Ok(false);
    }
    if let Some(expected) = file
        .sha256
        .as_deref()
        .map(|s| s.trim().trim_start_matches("sha256:"))
        .filter(|s| !s.is_empty())
    {
        let actual = sha256_file(dest_path).await?;
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(dest_path).await;
            return Ok(false);
        }
    }
    Ok(true)
}

/// Download every file of an MLX repo into `dest_dir`, reusing the resumable
/// single-file core. One cancel flag for the whole repo (task id == repo_id).
/// Aggregate progress: total = sum(file sizes), received accumulates across
/// files. Same DownloadPhase semantics as the GGUF path; final Done emit.
#[tauri::command]
pub async fn hf_download_repo_snapshot(
    args: SnapshotArgs,
    on_progress: Channel<DownloadProgress>,
    registry: tauri::State<'_, DownloadRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let endpoint = effective_hf_endpoint()?;
    let tid = snapshot_task_id(&args.repo_id);
    let cancel = registry.register(&tid)?;
    let total: u64 = args.files.iter().map(|f| f.size_bytes).sum();
    let mut received: u64 = 0;
    let dest_root = model_dir_for(&app)
        .and_then(|root| managed_snapshot_destination_dir(&root, &args.dest_dir));
    let result: Result<(), String> = async {
        let final_root = dest_root?;
        // Stable, resumable checkpoint dir keyed by repo + file list. NOT wiped
        // on entry: a prior interrupted run's completed files and `.part` files
        // are reused (MM-01). A changed file set hashes to a different dir, so
        // incompatible checkpoints never collide; abandoned ones are GC'd by the
        // 72h orphan sweep.
        let checkpoint_key = snapshot_checkpoint_key(&args.repo_id, &args.files);
        let temp_root = snapshot_checkpoint_dir(&final_root, &checkpoint_key)?;
        tokio::fs::create_dir_all(&temp_root)
            .await
            .map_err(|e| io_err("Couldn't create the temporary model folder", &e))?;
        for f in &args.files {
            if !allowed_mlx_snapshot_file(f) {
                return Err(
                    "Model snapshot contains a file type outside the MLX allowlist".to_string(),
                );
            }
            let dest_path = managed_snapshot_file_path(&temp_root, &f.filename)?;
            // Reuse a finalized, still-valid file from a previous run without
            // re-downloading; a stale/corrupt one is dropped and re-fetched.
            if snapshot_file_already_complete(&dest_path, f).await? {
                received += f.size_bytes;
                emit(
                    &on_progress,
                    received,
                    total,
                    DownloadPhase::Downloading,
                    None,
                );
                continue;
            }
            let url = hf_model_url(&endpoint, &args.repo_id, &f.filename);
            let dest = dest_path.to_string_lossy().into_owned();
            let part = format!("{dest}.part");
            let mut existing_len = partial_download_len(Path::new(&part))?;
            // Per-file download with ONE 416-restart retry (sentinel handling
            // mirrors download_inner — never let "__416_restart__" escape).
            let got = loop {
                match download_one_file(DownloadOneFileArgs {
                    url: &url,
                    dest_path: &dest,
                    expected_sha256: f.sha256.as_deref(),
                    expected_size: Some(f.size_bytes),
                    on_progress: &on_progress,
                    cancel: &cancel,
                    base_received: received,
                    base_total: total,
                    existing_len,
                })
                .await
                {
                    Ok(n) => break n,
                    Err(ref m) if m == "__416_restart__" => {
                        let _ = tokio::fs::remove_file(&part).await;
                        existing_len = 0;
                        continue;
                    }
                    Err(e) => return Err(e),
                }
            };
            received += got;
        }
        if final_root.exists() {
            let md = tokio::fs::symlink_metadata(&final_root)
                .await
                .map_err(|e| io_err("Couldn't inspect the model snapshot destination", &e))?;
            if !md.is_dir() {
                let _ = tokio::fs::remove_dir_all(&temp_root).await;
                return Err("Model snapshot destination already exists".to_string());
            }
            let mut entries = tokio::fs::read_dir(&final_root)
                .await
                .map_err(|e| io_err("Couldn't inspect the model snapshot destination", &e))?;
            if entries
                .next_entry()
                .await
                .map_err(|e| io_err("Couldn't inspect the model snapshot destination", &e))?
                .is_some()
            {
                let _ = tokio::fs::remove_dir_all(&temp_root).await;
                return Err("Model snapshot destination already exists".to_string());
            }
            tokio::fs::remove_dir(&final_root)
                .await
                .map_err(|e| io_err("Couldn't prepare the model snapshot destination", &e))?;
        }
        tokio::fs::rename(&temp_root, &final_root)
            .await
            .map_err(|e| io_err("Couldn't finalize the model snapshot", &e))?;
        emit(&on_progress, received, total, DownloadPhase::Done, None);
        Ok(())
    }
    .await;
    if result.is_ok() {
        let label = args
            .repo_id
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or(&args.repo_id)
            .to_string();
        if let Ok(dest_root) =
            model_dir_for(&app).and_then(|root| managed_download_dir(&root, &args.dest_dir))
        {
            let _ = upsert_installed_metadata(
                &app,
                &dest_root.to_string_lossy(),
                InstalledModelMetadata {
                    label,
                    source_repo: args.repo_id.clone(),
                    format: "mlx".to_string(),
                    installed_at_unix: current_unix(),
                },
            );
        }
    }
    registry.deregister(&tid);
    result
}
