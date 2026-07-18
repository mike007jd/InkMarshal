//! Model-supply capability layer (WS-B.2).
//!
//! Real implementations — no stubs, no fake data:
//!   * `ollama_list_tags`   — GET {base}/api/tags, returns the tag names.
//!   * `ollama_pull`        — POST {base}/api/pull (stream), NDJSON line parse.
//!   * `hf_search_models`   — GET the configured Hub endpoint (gguf filter).
//!   * `hf_list_gguf_files` — GET the configured Hub endpoint's repo tree.
//!   * `hf_download_gguf`   — resumable `.part` + Range + real sha256 + rename.
//!   * `cancel_download`    — flips the registry cancel flag for a task id.
//!   * `model_dir_free_bytes` — free bytes on the models-dir filesystem.
//!
//! ## Download task-id contract (LOCKED — cross-task with B.4)
//!
//! `hf_download_gguf` does not take or return a task id (B.1's wrapper signature
//! is frozen). The task id is therefore the DETERMINISTIC string
//! `hf:gguf:v2:{escaped_repo}/{escaped_filename}`. `hf_download_gguf` registers
//! a cancel flag under that key on start and removes it on completion/error;
//! `cancel_download(task_id)` flips the flag for that key. B.4 MUST derive the
//! exact same task id to cancel an in-flight download.
//!
//! ## Wire contract (LOCKED with B.1 `lib/model-supply/types.ts`)
//!
//! Every serialized struct uses `#[serde(rename_all = "camelCase")]` so the
//! JSON matches B.1's TS exactly. Do not change field names/casing.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::http_util::short_client;

mod huggingface;
mod local;
mod ollama;
mod paths;

/// One Ollama `/api/pull` NDJSON progress line.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    pub status: String,
    pub digest: Option<String>,
    pub total: Option<u64>,
    pub completed: Option<u64>,
}

/// Phase of an HF GGUF download. Serializes to exactly the lowercase words
/// `"downloading" | "verifying" | "done" | "error"` per the B.1 contract.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadPhase {
    Downloading,
    Verifying,
    Done,
    Error,
}

/// HF GGUF download progress, streamed over a `Channel<DownloadProgress>`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub received_bytes: u64,
    pub total_bytes: u64,
    pub phase: DownloadPhase,
    pub message: Option<String>,
}

/// Args for `hf_download_gguf` — mirrors B.1's `hfDownloadGguf({ args })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadArgs {
    pub repo_id: String,
    pub filename: String,
    pub dest_path: String,
    pub expected_sha256: Option<String>,
    pub expected_size_bytes: Option<u64>,
}

/// One GGUF file inside a Hugging Face repo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HfModelFile {
    pub repo: String,
    pub filename: String,
    pub size_bytes: u64,
    pub quant: Option<String>,
    pub sha256: Option<String>,
    /// C1 additive: resolved format ("gguf" | "mlx").
    pub format: String,
}

/// One Hugging Face repo search hit.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HfSearchResult {
    pub repo: String,
    pub downloads: u64,
    /// C1 additive: resolved format filter ("gguf" | "mlx").
    pub format: String,
}

/// One model already present in the desktop model folder.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledLocalModel {
    pub label: String,
    pub model_path: String,
    pub format: String,
    pub size_bytes: u64,
    pub source_repo: Option<String>,
    pub source_filename: Option<String>,
    pub installed_at_unix: Option<u64>,
    pub managed_by_app: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct InstalledModelMetadata {
    label: String,
    source_repo: String,
    format: String,
    installed_at_unix: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ImportedModelMetadata {
    label: String,
    format: String,
    imported_at_unix: u64,
}

/// Maps a download task id (`{repo_id}/{filename}`) to its cancel flag.
/// `.manage(DownloadRegistry::default())` registers it on the Tauri Builder.
#[derive(Default)]
pub struct DownloadRegistry(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl DownloadRegistry {
    /// Register a fresh cancel flag for `task_id`, returning the shared handle.
    /// Rejects duplicate active jobs so one task cannot steal another task's
    /// cancel flag or deregister it on completion.
    fn register(&self, task_id: &str) -> Result<Arc<AtomicBool>, String> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut map = self
            .0
            .lock()
            .map_err(|_| "Download registry lock poisoned".to_string())?;
        if map.contains_key(task_id) {
            return Err("Download is already running".to_string());
        }
        map.insert(task_id.to_string(), Arc::clone(&flag));
        Ok(flag)
    }

    /// Remove a task's flag (on completion or failure). Idempotent.
    fn deregister(&self, task_id: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(task_id);
        }
    }

    /// Flip the cancel flag for `task_id`. No-op if the task is already gone.
    fn cancel(&self, task_id: &str) -> Result<(), String> {
        let map = self
            .0
            .lock()
            .map_err(|_| "Download registry lock poisoned".to_string())?;
        if let Some(flag) = map.get(task_id) {
            flag.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
}

// ── HTTP client ─────────────────────────────────────────────────────────────

/// Short client for the JSON metadata/list/search calls — 20s timeout (kept
/// identical to the pre-refactor inline builder).
fn api_client() -> Result<reqwest::Client, String> {
    short_client(20)
}

// ── Ollama ──────────────────────────────────────────────────────────────────

/// Flip the cancel flag for `task_id`. No-op (Ok) if the task already finished.
#[tauri::command]
pub fn cancel_download(
    task_id: String,
    registry: tauri::State<DownloadRegistry>,
) -> Result<(), String> {
    registry.cancel(&task_id)
}

// ── Disk space ──────────────────────────────────────────────────────────────

fn current_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Args for `hf_download_repo_snapshot` — mirrors the TS `SnapshotDownloadArgs`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotArgs {
    pub repo_id: String,
    pub files: Vec<HfModelFile>,
    pub dest_dir: String,
}

// HfModelFile must also be Deserialize for SnapshotArgs to work.
// Add a blanket impl since the struct derives Serialize already.

// ── Command re-exports (paths consumed by lib.rs generate_handler!) ──────────
// Glob over each submodule so #[tauri::command] macro helper items keep their
// model_manager::<command> paths. registered_model_path is pub(crate), so it is
// re-exported explicitly (the glob only carries pub items).
pub use huggingface::*;
pub(crate) use local::registered_model_path;
pub use local::*;
pub use ollama::*;
pub use paths::*;

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod search_format_tests {
    use super::huggingface::*;

    #[test]
    fn filter_maps_per_format() {
        assert_eq!(hf_filter_for("gguf"), "gguf");
        assert_eq!(hf_filter_for("mlx"), "mlx");
        assert_eq!(hf_filter_for("GGUF"), "gguf");
        assert_eq!(hf_filter_for("anything-else"), "gguf");
    }

    #[test]
    fn hf_search_request_is_bounded_before_hitting_the_network() {
        let long = format!("  {} \n bad", "q".repeat(HF_SEARCH_MAX_QUERY_CHARS + 20));
        let (query, limit) = normalize_hf_search_request(&long, u32::MAX);

        assert_eq!(limit, HF_SEARCH_MAX_LIMIT);
        assert_eq!(query.chars().count(), HF_SEARCH_MAX_QUERY_CHARS);
        assert!(!query.chars().any(char::is_control));

        let (min_query, min_limit) = normalize_hf_search_request(" model ", 0);
        assert_eq!(min_query, "model");
        assert_eq!(min_limit, 1);
    }
}

#[cfg(test)]
mod installed_model_scan_tests {
    use super::local::*;
    use super::*;
    use std::fs;

    fn test_root(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "inkmarshal-model-scan-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("root");
        root
    }

    #[test]
    fn scans_gguf_files_and_mlx_snapshots() {
        let root = test_root("mixed");
        fs::write(root.join("draft.Q4_K_M.gguf"), b"GGUFtest").expect("gguf");
        let mlx = root.join("mlx-community_Qwen3.5-9B-OptiQ-4bit");
        fs::create_dir_all(&mlx).expect("mlx dir");
        fs::write(mlx.join("config.json"), b"{}").expect("config");
        fs::write(mlx.join("tokenizer.json"), b"{}").expect("tokenizer");
        fs::write(mlx.join("model.safetensors"), [4_u8, 5]).expect("weights");

        let found = scan_installed_models_root(&root).expect("scan");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(found.len(), 2);
        assert!(found
            .iter()
            .any(|m| { m.format == "gguf" && m.label == "draft.Q4_K_M" && m.size_bytes == 8 }));
        assert!(found.iter().any(|m| {
            m.format == "mlx"
                && m.label == "mlx-community/Qwen3.5-9B-OptiQ-4bit"
                && m.size_bytes >= 2
        }));
    }

    #[test]
    fn scans_download_metadata_for_installed_models() {
        let root = test_root("metadata");
        let flat_model = root.join("writer.Q4_K_M.gguf");
        fs::write(&flat_model, b"GGUFtest").expect("gguf");
        let nested_dir = root.join("nested");
        fs::create_dir_all(&nested_dir).expect("nested dir");
        let nested_model = nested_dir.join("writer.Q5_K_M.gguf");
        fs::write(&nested_model, b"GGUFnested").expect("nested gguf");
        let mut metadata = std::collections::HashMap::new();
        metadata.insert(
            metadata_key(&flat_model),
            InstalledModelMetadata {
                label: "Qwen3.5 9B Flat".to_string(),
                source_repo: "unsloth/Qwen3.5-9B-GGUF".to_string(),
                format: "gguf".to_string(),
                installed_at_unix: 1_717_171_717,
            },
        );
        metadata.insert(
            metadata_key(&nested_model),
            InstalledModelMetadata {
                label: "Qwen3.5 9B Nested".to_string(),
                source_repo: "unsloth/Qwen3.5-9B-GGUF".to_string(),
                format: "gguf".to_string(),
                installed_at_unix: 1_717_171_717,
            },
        );
        write_installed_metadata(&root, &metadata).expect("write metadata");

        let found = scan_installed_models_root(&root).expect("scan");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(found.len(), 2);
        let flat = found.iter().find(|m| m.label == "Qwen3.5 9B Flat").unwrap();
        assert_eq!(flat.source_repo.as_deref(), Some("unsloth/Qwen3.5-9B-GGUF"));
        assert_eq!(flat.source_filename.as_deref(), Some("writer.Q4_K_M.gguf"));
        assert_eq!(flat.installed_at_unix, Some(1_717_171_717));

        let nested = found
            .iter()
            .find(|m| m.label == "Qwen3.5 9B Nested")
            .unwrap();
        assert_eq!(
            nested.source_repo.as_deref(),
            Some("unsloth/Qwen3.5-9B-GGUF")
        );
        assert_eq!(
            nested.source_filename.as_deref(),
            Some("nested/writer.Q5_K_M.gguf")
        );
        assert_eq!(nested.installed_at_unix, Some(1_717_171_717));
    }

    #[test]
    fn scans_imported_external_models_without_taking_ownership() {
        let root = test_root("import-registry");
        let external_root = test_root("external");
        let model = external_root.join("outside.Q4_K_M.gguf");
        fs::write(&model, b"GGUFexternal").expect("external gguf");
        let canonical = model.canonicalize().expect("canonical");
        let mut imported = std::collections::HashMap::new();
        imported.insert(
            metadata_key(&canonical),
            ImportedModelMetadata {
                label: "External Writer".to_string(),
                format: "gguf".to_string(),
                imported_at_unix: 1_818_181_818,
            },
        );
        write_imported_metadata(&root, &imported).expect("write imported metadata");

        let found = scan_installed_models_root(&root).expect("scan");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&external_root);

        assert_eq!(found.len(), 1);
        let model = &found[0];
        assert_eq!(model.label, "External Writer");
        assert_eq!(model.format, "gguf");
        assert_eq!(model.size_bytes, 12);
        assert_eq!(model.installed_at_unix, Some(1_818_181_818));
        assert!(!model.managed_by_app);
    }

    #[test]
    fn rejects_imported_gguf_with_wrong_magic() {
        let root = test_root("bad-gguf");
        let model = root.join("renamed.gguf");
        fs::write(&model, b"nope").expect("fake gguf");

        let err = imported_model_from_path(&root, &model, None).expect_err("reject fake gguf");
        let _ = fs::remove_dir_all(&root);

        assert!(err.contains("valid GGUF"));
    }

    #[test]
    fn imported_model_labels_are_bounded_and_control_free() {
        let root = test_root("import-label");
        let model = root.join("external.Q4_K_M.gguf");
        fs::write(&model, b"GGUFexternal").expect("external gguf");

        let clean =
            imported_model_from_path(&root, &model, Some("  External Writer  ".to_string()))
                .expect("clean label");
        assert_eq!(clean.label, "External Writer");

        let control = imported_model_from_path(&root, &model, Some("External\nWriter".to_string()))
            .expect("control label dropped");
        assert_eq!(control.label, "external.Q4_K_M");

        let oversized =
            imported_model_from_path(&root, &model, Some("x".repeat(MAX_MODEL_LABEL_BYTES + 1)))
                .expect("oversized label dropped");
        assert_eq!(oversized.label, "external.Q4_K_M");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ignores_partial_downloads_and_non_model_dirs() {
        let root = test_root("partial");
        fs::write(root.join("draft.Q4_K_M.gguf.part"), [1_u8]).expect("part");
        let incomplete = root.join("not-ready");
        fs::create_dir_all(&incomplete).expect("dir");
        fs::write(incomplete.join("config.json"), b"{}").expect("config");
        fs::write(incomplete.join("model.safetensors"), b"weights").expect("weights");

        let found = scan_installed_models_root(&root).expect("scan");
        let _ = fs::remove_dir_all(&root);

        assert!(found.is_empty());
    }

    #[test]
    fn removable_managed_model_path_accepts_only_real_models() {
        let root = test_root("remove-validate");
        let gguf = root.join("writer.Q4_K_M.gguf");
        fs::write(&gguf, b"GGUFmodel").expect("gguf");
        let notes = root.join("notes.txt");
        fs::write(&notes, b"not a model").expect("notes");
        let scratch = root.join("scratch");
        fs::create_dir_all(&scratch).expect("scratch");
        fs::write(scratch.join("metadata.json"), b"{}").expect("scratch metadata");

        let removable =
            removable_managed_model_path(&root, &gguf.to_string_lossy()).expect("valid gguf model");
        assert_eq!(removable, gguf.canonicalize().expect("canonical gguf"));
        assert!(
            removable_managed_model_path(&root, &notes.to_string_lossy())
                .expect_err("plain file")
                .contains("Choose a .gguf file or an MLX model folder")
        );
        assert!(
            removable_managed_model_path(&root, &scratch.to_string_lossy())
                .expect_err("plain dir")
                .contains("Choose a .gguf file or an MLX model folder")
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn registered_model_path_reveals_only_real_models() {
        let root = test_root("reveal-validate");
        let gguf = root.join("writer.Q4_K_M.gguf");
        fs::write(&gguf, b"GGUFmodel").expect("gguf");
        let notes = root.join("notes.txt");
        fs::write(&notes, b"not a model").expect("notes");
        let scratch = root.join("scratch");
        fs::create_dir_all(&scratch).expect("scratch");
        fs::write(scratch.join("metadata.json"), b"{}").expect("scratch metadata");

        let imported_root = test_root("reveal-imported");
        let imported_model = imported_root.join("external.Q4_K_M.gguf");
        fs::write(&imported_model, b"GGUFexternal").expect("imported gguf");
        let imported_notes = imported_root.join("external-notes.txt");
        fs::write(&imported_notes, b"not a model").expect("imported notes");

        let mut imported = std::collections::HashMap::new();
        imported.insert(
            metadata_key(&imported_model.canonicalize().expect("canonical imported")),
            ImportedModelMetadata {
                label: "External Writer".to_string(),
                format: "gguf".to_string(),
                imported_at_unix: 1,
            },
        );
        imported.insert(
            metadata_key(&imported_notes.canonicalize().expect("canonical notes")),
            ImportedModelMetadata {
                label: "Fake External".to_string(),
                format: "gguf".to_string(),
                imported_at_unix: 1,
            },
        );

        let managed = registered_model_path_inner(&root, &gguf.to_string_lossy(), &imported)
            .expect("managed gguf");
        assert_eq!(managed, gguf.canonicalize().expect("canonical gguf"));
        assert!(
            registered_model_path_inner(&root, &notes.to_string_lossy(), &imported)
                .expect_err("plain managed file")
                .contains("Choose a .gguf file or an MLX model folder")
        );
        assert!(
            registered_model_path_inner(&root, &scratch.to_string_lossy(), &imported)
                .expect_err("plain managed dir")
                .contains("Choose a .gguf file or an MLX model folder")
        );

        let external =
            registered_model_path_inner(&root, &imported_model.to_string_lossy(), &imported)
                .expect("imported gguf");
        assert_eq!(
            external,
            imported_model.canonicalize().expect("canonical imported")
        );
        assert!(
            registered_model_path_inner(&root, &imported_notes.to_string_lossy(), &imported)
                .expect_err("imported metadata for non-model")
                .contains("Choose a .gguf file or an MLX model folder")
        );

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&imported_root);
    }

    #[cfg(unix)]
    #[test]
    fn scan_and_size_skip_symlinked_model_content() {
        use std::os::unix::fs::symlink;

        let root = test_root("symlink-scan");
        let outside = test_root("symlink-outside");
        let mlx = root.join("mlx-community_Qwen3-4B-4bit");
        fs::create_dir_all(&mlx).expect("mlx dir");
        fs::write(mlx.join("config.json"), b"{}").expect("config");
        fs::write(mlx.join("tokenizer.json"), b"{}").expect("tokenizer");
        fs::write(mlx.join("model.safetensors"), [4_u8, 5]).expect("weights");
        fs::write(outside.join("outside.gguf"), b"GGUFoutside").expect("outside file");
        fs::create_dir_all(outside.join("outside-dir")).expect("outside dir");
        fs::write(
            outside.join("outside-dir").join("extra.safetensors"),
            [9_u8; 20],
        )
        .expect("outside weights");
        symlink(outside.join("outside.gguf"), root.join("linked.gguf")).expect("file symlink");
        symlink(outside.join("outside-dir"), mlx.join("linked-dir")).expect("dir symlink");

        let found = scan_installed_models_root(&root).expect("scan");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].format, "mlx");
        assert_eq!(found[0].size_bytes, 6);
    }
}

#[cfg(test)]
mod snapshot_tests {
    use super::huggingface::*;
    use super::paths::*;
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;

    #[test]
    fn hf_endpoint_precedence_and_validation_are_explicit() {
        assert_eq!(
            resolve_hf_endpoint_from(None, None).expect("default"),
            (HF_OFFICIAL_ENDPOINT.to_string(), "default")
        );
        assert_eq!(
            resolve_hf_endpoint_from(None, Some("https://hf-mirror.com/")).expect("saved mirror"),
            (HF_MIRROR_ENDPOINT.to_string(), "setting")
        );
        assert_eq!(
            resolve_hf_endpoint_from(
                Some("https://private-hub.example"),
                Some(HF_MIRROR_ENDPOINT),
            )
            .expect("environment wins"),
            ("https://private-hub.example".to_string(), "environment")
        );
        assert!(normalize_hf_endpoint("http://hf-mirror.com").is_err());
        assert!(normalize_hf_endpoint("https://user:secret@example.com").is_err());
        assert_eq!(
            normalize_hf_endpoint("http://127.0.0.1:9876/").expect("local mock"),
            "http://127.0.0.1:9876"
        );
    }

    fn serve_one_http_response(body: &'static [u8]) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let endpoint = format!("http://{}", listener.local_addr().expect("mock address"));
        let (path_tx, path_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept mock request");
            let mut request = [0_u8; 4096];
            let read = stream.read(&mut request).expect("read mock request");
            let request = String::from_utf8_lossy(&request[..read]);
            let path = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or_default()
                .to_string();
            path_tx.send(path).expect("capture request path");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .expect("write mock headers");
            stream.write_all(body).expect("write mock body");
        });
        (endpoint, path_rx)
    }

    #[test]
    fn hf_search_request_uses_the_selected_endpoint() {
        let (endpoint, path_rx) =
            serve_one_http_response(br#"[{"id":"org/writer-gguf","downloads":42}]"#);
        let results = tauri::async_runtime::block_on(hf_search_models_at(
            &endpoint,
            "writer".to_string(),
            Some("gguf".to_string()),
            5,
        ))
        .expect("search through mock endpoint");

        let path = path_rx.recv().expect("captured search request");
        assert!(path.starts_with("/api/models?"));
        assert!(path.contains("search=writer"));
        assert!(path.contains("filter=gguf"));
        assert_eq!(results[0].repo, "org/writer-gguf");
    }

    #[test]
    fn hf_download_request_uses_the_selected_endpoint() {
        let (endpoint, path_rx) = serve_one_http_response(b"tiny-model");
        let root = std::env::temp_dir().join(format!(
            "inkmarshal-hf-endpoint-download-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp download root");
        let destination = root.join("config.json");
        let args = DownloadArgs {
            repo_id: "org/tiny".to_string(),
            filename: "config.json".to_string(),
            dest_path: destination.to_string_lossy().into_owned(),
            expected_sha256: None,
            expected_size_bytes: Some(10),
        };
        let channel = tauri::ipc::Channel::<DownloadProgress>::new(|_| Ok(()));
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

        tauri::async_runtime::block_on(download_inner_at(&args, &channel, &cancel, &endpoint))
            .expect("download through mock endpoint");

        assert_eq!(
            path_rx.recv().expect("captured download request"),
            "/org/tiny/resolve/main/config.json"
        );
        assert_eq!(
            std::fs::read(&destination).expect("downloaded bytes"),
            b"tiny-model"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn gguf_task_id_escapes_repo_and_filename_separator_bytes() {
        let a = task_id("org/model", "nested/file.gguf");
        let b = task_id("org", "model/nested/file.gguf");

        assert_eq!(a, "hf:gguf:v2:org%2Fmodel/nested%2Ffile.gguf");
        assert_ne!(a, b);
        assert_eq!(
            task_id("org/model", "weird #1%.gguf"),
            "hf:gguf:v2:org%2Fmodel/weird%20%231%25.gguf"
        );
    }

    #[test]
    fn hf_paths_preserve_hierarchy_but_escape_path_control_bytes() {
        assert_eq!(hf_path("org/model"), "org/model");
        assert_eq!(
            hf_path("nested/weird #1%.gguf"),
            "nested/weird%20%231%25.gguf"
        );
    }

    #[test]
    fn snapshot_task_id_is_repo_id() {
        assert_eq!(
            snapshot_task_id("mlx-community/Qwen3.5-9B-OptiQ-4bit"),
            "mlx-community/Qwen3.5-9B-OptiQ-4bit"
        );
    }

    #[test]
    fn download_registry_rejects_duplicate_active_task_ids() {
        let registry = DownloadRegistry::default();
        let first = registry
            .register("hf:gguf:v2:org%2Fmodel/file.gguf")
            .expect("first registration succeeds");
        let err = registry
            .register("hf:gguf:v2:org%2Fmodel/file.gguf")
            .expect_err("duplicate active task rejected");
        assert!(err.contains("already running"));

        registry
            .cancel("hf:gguf:v2:org%2Fmodel/file.gguf")
            .expect("cancel registered task");
        assert!(first.load(Ordering::SeqCst));

        registry.deregister("hf:gguf:v2:org%2Fmodel/file.gguf");
        registry
            .register("hf:gguf:v2:org%2Fmodel/file.gguf")
            .expect("task id reusable after deregister");
    }

    #[test]
    fn managed_download_paths_stay_inside_model_root() {
        let root = std::env::temp_dir().join(format!(
            "inkmarshal-model-download-path-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");

        let ok = managed_download_file_path(
            &root,
            &root.join("nested").join("writer.gguf").to_string_lossy(),
            Some("gguf"),
        )
        .expect("inside");
        assert!(ok.starts_with(root.canonicalize().expect("canonical root")));

        let top_level = managed_download_file_path(
            &root,
            &root.join("writer.gguf").to_string_lossy(),
            Some("gguf"),
        )
        .expect("top-level file");
        assert_eq!(
            top_level,
            root.canonicalize()
                .expect("canonical root")
                .join("writer.gguf")
        );

        let outside = root.parent().unwrap().join("outside.gguf");
        assert!(
            managed_download_file_path(&root, &outside.to_string_lossy(), Some("gguf"))
                .expect_err("outside")
                .contains("managed model folder")
        );
        assert!(managed_download_file_path(
            &root,
            &root.join("metadata.db").to_string_lossy(),
            Some("gguf"),
        )
        .expect_err("extension")
        .contains(".gguf"));
        assert!(managed_download_dir(&root, &root.to_string_lossy())
            .expect_err("root dir")
            .contains("outside"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshot_destination_path_creates_parent_but_not_final_directory() {
        let root = std::env::temp_dir().join(format!(
            "inkmarshal-model-snapshot-dest-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");

        let dest = root.join("nested").join("writer-mlx");
        let resolved = managed_snapshot_destination_dir(&root, &dest.to_string_lossy())
            .expect("snapshot destination");

        assert_eq!(
            resolved,
            root.canonicalize()
                .expect("canonical root")
                .join("nested")
                .join("writer-mlx")
        );
        assert!(root.join("nested").is_dir());
        assert!(!dest.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn managed_download_paths_reject_symlinked_parent_dirs_without_creating_outside() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "inkmarshal-model-download-symlink-{}",
            std::process::id()
        ));
        let outside = std::env::temp_dir().join(format!(
            "inkmarshal-model-download-outside-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&root).expect("root");
        std::fs::create_dir_all(&outside).expect("outside");
        symlink(&outside, root.join("linked")).expect("linked symlink");

        let err = managed_download_file_path(
            &root,
            &root
                .join("linked")
                .join("child")
                .join("writer.gguf")
                .to_string_lossy(),
            Some("gguf"),
        )
        .expect_err("symlinked file parent");
        assert!(err.contains("managed model folder"));
        assert!(!outside.join("child").exists());

        let err = managed_download_dir(
            &root,
            &root.join("linked").join("snapshot").to_string_lossy(),
        )
        .expect_err("symlinked directory parent");
        assert!(err.contains("managed model folder"));
        assert!(!outside.join("snapshot").exists());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn partial_download_paths_reject_symlink_resume_targets() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "inkmarshal-model-part-symlink-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");

        let outside = root
            .parent()
            .expect("tmp parent")
            .join(format!("inkmarshal-outside-part-{}", std::process::id()));
        std::fs::write(&outside, b"do-not-touch").expect("outside");
        let part = root.join("writer.gguf.part");
        symlink(&outside, &part).expect("part symlink");

        let err = partial_download_len(&part).expect_err("reject symlink part");
        assert!(err.contains("symlink"));

        let err = open_partial_download_file(&part, false).expect_err("no-follow create");
        assert!(err.contains("model file"));
        assert_eq!(
            std::fs::read_to_string(&outside).expect("outside unchanged"),
            "do-not-touch"
        );

        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resume_requires_expected_sha256() {
        assert!(!has_expected_sha256(None));
        assert!(!has_expected_sha256(Some("")));
        assert!(!has_expected_sha256(Some("  sha256:  ")));
        assert!(has_expected_sha256(Some("abc123")));
        assert!(has_expected_sha256(Some("sha256:abc123")));
    }

    #[cfg(unix)]
    #[test]
    fn partial_download_hash_rejects_symlink_verify_targets() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "inkmarshal-model-part-verify-symlink-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");

        let outside = root.parent().expect("tmp parent").join(format!(
            "inkmarshal-outside-verify-part-{}",
            std::process::id()
        ));
        std::fs::write(&outside, b"do-not-verify").expect("outside");
        let part = root.join("writer.gguf.part");
        symlink(&outside, &part).expect("part symlink");

        let err = tauri::async_runtime::block_on(sha256_file(&part))
            .expect_err("reject symlink before hashing");
        assert!(err.contains("symlink"));

        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshot_file_paths_cannot_escape_destination_dir() {
        assert_eq!(
            repo_file_relative_path("nested/model.safetensors").expect("relative"),
            PathBuf::from("nested").join("model.safetensors")
        );
        assert!(repo_file_relative_path("../model.safetensors").is_err());
        assert!(repo_file_relative_path("/tmp/model.safetensors").is_err());
        assert!(repo_file_relative_path("").is_err());
    }

    #[test]
    fn mlx_snapshot_downloads_accept_only_mlx_model_files() {
        let file = |filename: &str, format: &str| HfModelFile {
            repo: "mlx-community/writer".to_string(),
            filename: filename.to_string(),
            size_bytes: 1,
            quant: None,
            sha256: None,
            format: format.to_string(),
        };

        assert!(allowed_mlx_snapshot_file(&file("config.json", "mlx")));
        assert!(allowed_mlx_snapshot_file(&file("model.safetensors", "mlx")));
        assert!(allowed_mlx_snapshot_file(&file(
            "model.safetensors.index.json",
            "mlx"
        )));
        assert!(allowed_mlx_snapshot_file(&file("tokenizer.model", "mlx")));
        assert!(allowed_mlx_snapshot_file(&file(
            "tokenizer_config.json",
            "mlx"
        )));
        assert!(allowed_mlx_snapshot_file(&file(
            "chat_template.jinja",
            "mlx"
        )));
        assert!(allowed_mlx_snapshot_file(&file("kv_config.json", "mlx")));
        assert!(allowed_mlx_snapshot_file(&file(
            "optiq_metadata.json",
            "mlx"
        )));

        assert!(!allowed_mlx_snapshot_file(&file("README.md", "mlx")));
        assert!(!allowed_mlx_snapshot_file(&file(
            "scripts/install.sh",
            "mlx"
        )));
        assert!(!allowed_mlx_snapshot_file(&file(
            "chat_template.txt",
            "mlx"
        )));
        assert!(!allowed_mlx_snapshot_file(&file(
            "eval_results.json",
            "mlx"
        )));
        assert!(!allowed_mlx_snapshot_file(&file(
            "nested/config.json",
            "mlx"
        )));
        assert!(!allowed_mlx_snapshot_file(&file("config.json", "gguf")));
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_file_paths_reject_symlinked_parent_dirs() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "inkmarshal-model-snapshot-symlink-{}",
            std::process::id()
        ));
        let outside = std::env::temp_dir().join(format!(
            "inkmarshal-model-snapshot-outside-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&root).expect("root");
        std::fs::create_dir_all(&outside).expect("outside");
        symlink(&outside, root.join("nested")).expect("nested symlink");

        let err = managed_snapshot_file_path(&root, "nested/deeper/model.safetensors")
            .expect_err("symlinked parent");
        assert!(err.contains("outside the selected repository"));
        assert!(!outside.join("deeper").exists());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn downloaded_size_must_match_hf_tree_metadata_when_provided() {
        validate_downloaded_size(128, None).expect("optional size");
        validate_downloaded_size(128, Some(128)).expect("matching size");
        let err = validate_downloaded_size(64, Some(128)).expect_err("truncated file");
        assert!(err.contains("size mismatch"));
    }

    #[test]
    fn failed_model_replace_preserves_the_existing_model() {
        let root = std::env::temp_dir().join(format!(
            "inkmarshal-model-replace-failure-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");
        let dest = root.join("writer.gguf");
        let missing_part = root.join("writer.gguf.part");
        std::fs::write(&dest, b"known-good-model").expect("existing model");

        let err = tauri::async_runtime::block_on(replace_download_file(&missing_part, &dest))
            .expect_err("missing replacement must fail");

        assert!(err.contains("finalize"));
        assert_eq!(
            std::fs::read(&dest).expect("old model remains readable"),
            b"known-good-model"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn gguf_download_args_accept_expected_size_bytes_wire_contract() {
        let args: DownloadArgs = serde_json::from_value(serde_json::json!({
            "repoId": "org/model",
            "filename": "model.Q4_K_M.gguf",
            "destPath": "/tmp/model.Q4_K_M.gguf",
            "expectedSha256": "sha256:abc",
            "expectedSizeBytes": 123
        }))
        .expect("camelCase args deserialize");

        assert_eq!(args.expected_size_bytes, Some(123));
    }

    fn mlx_file(filename: &str, size: u64, sha: &str) -> HfModelFile {
        HfModelFile {
            repo: "org/m".to_string(),
            filename: filename.to_string(),
            size_bytes: size,
            quant: None,
            sha256: Some(sha.to_string()),
            format: "mlx".to_string(),
        }
    }

    #[test]
    fn snapshot_checkpoint_key_is_stable_and_order_independent() {
        let a = mlx_file("model.safetensors", 100, "aa");
        let b = mlx_file("tokenizer.json", 5, "bb");
        let k1 = snapshot_checkpoint_key("org/m", &[a.clone(), b.clone()]);
        let k2 = snapshot_checkpoint_key("org/m", &[b, a]);
        assert_eq!(k1, k2, "key must not depend on file order");
        assert_eq!(k1.len(), 16);
    }

    #[test]
    fn snapshot_checkpoint_key_changes_with_the_file_set() {
        let a = mlx_file("model.safetensors", 100, "aa");
        let base = snapshot_checkpoint_key("org/m", std::slice::from_ref(&a));
        // New digest (a new revision) → different checkpoint.
        assert_ne!(
            base,
            snapshot_checkpoint_key("org/m", &[mlx_file("model.safetensors", 100, "cc")])
        );
        // Different size → different checkpoint.
        assert_ne!(
            base,
            snapshot_checkpoint_key("org/m", &[mlx_file("model.safetensors", 101, "aa")])
        );
        // Different repo → different checkpoint.
        assert_ne!(base, snapshot_checkpoint_key("org/other", &[a]));
    }

    #[test]
    fn snapshot_checkpoint_dir_is_stable_and_recognized_by_the_orphan_sweep() {
        let final_root = std::path::Path::new("/models/org--m");
        let d1 = snapshot_checkpoint_dir(final_root, "deadbeefdeadbeef").expect("dir");
        let d2 = snapshot_checkpoint_dir(final_root, "deadbeefdeadbeef").expect("dir");
        assert_eq!(d1, d2, "same key → same stable checkpoint dir across tasks");
        assert_eq!(d1.parent().unwrap(), final_root.parent().unwrap());
        // Keeps the `.download-` marker so the 72h orphan sweep still GCs it.
        assert!(is_snapshot_temp_dir(&d1));
    }
}
