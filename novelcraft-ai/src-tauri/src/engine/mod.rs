//! Bundled inference-engine sidecar manager.
//!
//! Spawns an OpenAI-compatible local server (llama.cpp `llama-server`, or the
//! Swift `mlx-server` on macOS) as a managed child, mirroring `lib.rs`'s
//! NextRuntime process-group discipline so no engine child is ever orphaned.
//!
//! Wave 4 commit A: the registry is now **additive** — `engine_start` no
//! longer mass-kills siblings, so multiple distinct models can co-exist (one
//! per role group). Footprint estimation + a system-wide resource budget are
//! exposed to the TS layer so the UI can make admit/deny decisions before
//! spawning a second engine on a 16 GB box.

use serde::{Deserialize, Serialize};
use std::str::FromStr;

mod budget;
mod commands;
mod log;
mod readiness;
mod registry;
mod spawn;

// ── Shared wire types (camelCase to match the TS layer) ──────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineFormat {
    Gguf,
    Mlx,
}

impl FromStr for EngineFormat {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s.to_ascii_lowercase().as_str() {
            "gguf" => Ok(EngineFormat::Gguf),
            "mlx" => Ok(EngineFormat::Mlx),
            other => Err(format!("Unknown engine format: {other}")),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStartArgs {
    pub model_path: String,
    pub format: EngineFormat,
    /// Optional disambiguator so the same `model_path` can be launched twice
    /// (e.g. one tuned-style instance bound to `polish`, one default-style
    /// instance bound to `draft`). When `None` the engine_id collapses to the
    /// legacy `"{fmt}:{path}"` form so existing TS callers keep working.
    #[serde(default)]
    pub engine_label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub engine_id: String,
    pub format: EngineFormat,
    pub model_path: String,
    pub port: u16,
    /// Coarse RAM footprint estimate computed once at start, cached on the
    /// running engine so `engine_status` is O(1) and `engine_resource_budget`
    /// can sum without re-stat'ing model files on every poll.
    pub footprint_bytes: u64,
    /// Echo of the optional engine_label so the UI can render disambiguators.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineFootprint {
    pub model_size_bytes: u64,
    pub ram_bytes: u64,
    /// Apple Silicon unified memory: vram_hint == ram. On Windows/Linux the
    /// caller treats this purely as a UI hint until CUDA estimation lands.
    pub vram_hint_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningEngineSummary {
    pub engine_id: String,
    pub model_path: String,
    pub footprint_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineBudget {
    pub total_ram_bytes: u64,
    pub available_ram_bytes: u64,
    pub reserved_for_os_bytes: u64,
    pub running: Vec<RunningEngineSummary>,
}

// ── Command + state re-exports (paths consumed by lib.rs generate_handler!) ──
// Glob over commands so the #[tauri::command] macro helper items keep their
// engine::<command> paths. EngineRegistry + stop_all are referenced by name.
pub use commands::*;
pub use registry::{stop_all, EngineRegistry};

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::budget::{
        admit_engine, budget_available_bytes, estimate_footprint_inner,
        normalize_engine_model_path_for_match, validate_engine_model_path,
        GGUF_FOOTPRINT_MULTIPLIER, MLX_FOOTPRINT_MULTIPLIER, RESERVED_FOR_OS_BYTES,
    };
    use super::log::{
        engine_log_file_name, read_log_tail, rotate_engine_log_if_large, MAX_ENGINE_LOG_BYTES,
    };
    use super::registry::{
        prune_exited_engines, register_running_engine, terminate_running_engine,
        RegisterEngineResult, RunningEngine,
    };
    use super::spawn::{
        engine_env_allows, engine_loader_env, make_engine_id, normalize_engine_label,
        pick_free_port, MAX_ENGINE_LABEL_BYTES,
    };
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(windows)]
    use super::spawn::WindowsJob;
    #[cfg(target_os = "macos")]
    use std::ffi::OsString;
    #[cfg(not(target_os = "macos"))]
    use std::path::Path;
    #[cfg(windows)]
    use std::time::Duration;

    #[test]
    fn picks_a_bindable_loopback_port() {
        for _ in 0..10 {
            let p = pick_free_port().expect("port");
            assert!(p >= 1024);
            if std::net::TcpListener::bind(("127.0.0.1", p)).is_ok() {
                return;
            }
        }
        panic!("could not rebind a picked loopback port after 10 attempts");
    }

    #[test]
    fn format_parses_case_insensitively() {
        assert_eq!("GGUF".parse::<EngineFormat>().unwrap(), EngineFormat::Gguf);
        assert_eq!("mlx".parse::<EngineFormat>().unwrap(), EngineFormat::Mlx);
        assert!("bogus".parse::<EngineFormat>().is_err());
    }

    #[test]
    fn budget_available_subtracts_os_running_and_reserved() {
        let total = 16 * 1024 * 1024 * 1024u64;
        let running = 2 * 1024 * 1024 * 1024u64;
        let reserved = 1024 * 1024 * 1024u64;
        let expected = total - RESERVED_FOR_OS_BYTES - running - reserved;
        assert_eq!(budget_available_bytes(total, running, reserved), expected);
    }

    #[test]
    fn budget_available_saturates_when_overcommitted() {
        // running alone exceeds total → available clamps to 0, no wrap-around.
        assert_eq!(budget_available_bytes(1024, u64::MAX, 0), 0);
    }

    #[test]
    fn admit_rejects_impossible_footprint_and_admits_zero() {
        let registry = EngineRegistry::default();
        // Larger than any machine's RAM → rejected with the structured error.
        let err = admit_engine(&registry, u64::MAX, "fmt:/m/huge.gguf")
            .err()
            .expect("over-budget start rejected");
        assert!(err.starts_with("ENGINE_BUDGET_EXCEEDED:"), "got: {err}");
        // A footprint of 0 (unmeasurable model) is always admitted.
        assert!(admit_engine(&registry, 0, "fmt:/m/zero.gguf").is_ok());
    }

    #[test]
    fn reservation_guard_frees_on_drop() {
        let registry = EngineRegistry::default();
        {
            let _guard = admit_engine(&registry, 0, "fmt:/m/a.gguf").expect("admit");
            assert_eq!(registry.1.lock().unwrap().len(), 1);
        }
        assert_eq!(registry.1.lock().unwrap().len(), 0);
    }

    #[test]
    fn engine_log_file_name_is_deterministic_hex_log() {
        let a = engine_log_file_name("gguf:/m/x.gguf");
        assert_eq!(a, engine_log_file_name("gguf:/m/x.gguf"));
        assert!(a.ends_with(".log"));
        let stem = a.trim_end_matches(".log");
        assert_eq!(stem.len(), 64); // sha256 hex
        assert!(stem.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, engine_log_file_name("gguf:/m/y.gguf"));
    }

    #[test]
    fn read_log_tail_returns_trailing_bytes_and_empty_for_missing() {
        use std::io::Write;
        let dir =
            std::env::temp_dir().join(format!("inkmarshal-engine-log-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("tail.log");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(b"0123456789")
            .unwrap();
        assert_eq!(read_log_tail(&path, 4).unwrap(), "6789");
        assert_eq!(read_log_tail(&path, 100).unwrap(), "0123456789");
        assert_eq!(read_log_tail(&dir.join("nope.log"), 10).unwrap(), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotate_engine_log_renames_when_over_cap() {
        use std::io::Write;
        let dir =
            std::env::temp_dir().join(format!("inkmarshal-engine-rot-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("rot.log");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(b"small")
            .unwrap();
        rotate_engine_log_if_large(&path);
        assert!(path.exists() && !dir.join("rot.log.1").exists());
        std::fs::File::create(&path)
            .unwrap()
            .write_all(&vec![b'x'; (MAX_ENGINE_LOG_BYTES + 1) as usize])
            .unwrap();
        rotate_engine_log_if_large(&path);
        assert!(dir.join("rot.log.1").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn make_engine_id_with_and_without_label() {
        // No label collapses to the legacy "{fmt}:{path}" form so existing TS
        // callers keep working without a migration.
        assert_eq!(
            make_engine_id(EngineFormat::Gguf, "/m/llama.gguf", &None),
            "gguf:/m/llama.gguf"
        );
        // Empty label is treated the same as None — we don't want "#" suffixes
        // creeping in from accidentally-empty UI inputs.
        assert_eq!(
            make_engine_id(EngineFormat::Gguf, "/m/llama.gguf", &Some(String::new())),
            "gguf:/m/llama.gguf"
        );
        // Same path, different labels → distinct engine_ids so the registry
        // HashMap can hold both simultaneously. Labeled ids use the v2
        // escaped form so label separators cannot collide with path bytes.
        let a = make_engine_id(EngineFormat::Gguf, "/m/llama.gguf", &Some("draft".into()));
        let b = make_engine_id(EngineFormat::Gguf, "/m/llama.gguf", &Some("polish".into()));
        assert_ne!(a, b);
        assert_eq!(a, "gguf:v2:/m/llama.gguf#draft");
        // Format is part of the key — a gguf+path collision with an mlx+path
        // would otherwise look identical to the registry.
        let mlx = make_engine_id(EngineFormat::Mlx, "/m/llama.gguf", &None);
        assert_eq!(mlx, "mlx:/m/llama.gguf");
        assert_ne!(mlx, "gguf:/m/llama.gguf");
    }

    #[test]
    fn make_engine_id_does_not_confuse_hash_in_path_with_label_separator() {
        let labeled = make_engine_id(EngineFormat::Gguf, "/m/llama.gguf", &Some("draft".into()));
        let hash_path = make_engine_id(EngineFormat::Gguf, "/m/llama.gguf#draft", &None);
        assert_ne!(labeled, hash_path);
        assert_eq!(hash_path, "gguf:v2:/m/llama.gguf%23draft");

        let label_with_hash =
            make_engine_id(EngineFormat::Gguf, "/m/llama.gguf", &Some("draft#1".into()));
        assert_eq!(label_with_hash, "gguf:v2:/m/llama.gguf#draft%231");

        let reserved_legacy_path = make_engine_id(EngineFormat::Gguf, "v2:/m/llama.gguf", &None);
        assert_eq!(reserved_legacy_path, "gguf:v2:v2%3A/m/llama.gguf");
    }

    #[test]
    fn engine_labels_are_trimmed_bounded_and_control_free() {
        assert_eq!(normalize_engine_label(None).unwrap(), None);
        assert_eq!(normalize_engine_label(Some("   ".into())).unwrap(), None);
        assert_eq!(
            normalize_engine_label(Some("  draft  ".into())).unwrap(),
            Some("draft".into())
        );
        assert!(normalize_engine_label(Some("draft\nrewrite".into())).is_err());
        assert!(normalize_engine_label(Some("x".repeat(MAX_ENGINE_LABEL_BYTES + 1))).is_err());
    }

    #[test]
    fn engine_model_path_match_uses_canonical_path() {
        let tmp = unique_tmp("match-canonical");
        let nested = tmp.join("nested");
        fs::create_dir_all(&nested).expect("mk nested");
        let file = nested.join("model.gguf");
        fs::write(&file, b"fake").expect("write fake gguf");
        let non_canonical = nested.join("..").join("nested").join("model.gguf");

        let normalized =
            normalize_engine_model_path_for_match(non_canonical.to_str().expect("utf8 temp path"))
                .expect("normalize");

        assert_eq!(normalized, file.canonicalize().unwrap().to_string_lossy());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn engine_model_path_match_rejects_symlink_paths() {
        use std::os::unix::fs::symlink;

        let tmp = unique_tmp("match-symlink");
        let file = tmp.join("model.gguf");
        let link = tmp.join("link.gguf");
        fs::write(&file, b"fake").expect("write fake gguf");
        symlink(&file, &link).expect("symlink");

        let err = normalize_engine_model_path_for_match(link.to_str().expect("utf8 temp path"))
            .unwrap_err();

        assert!(err.contains("Model path cannot be a symlink"));
        let _ = fs::remove_dir_all(&tmp);
    }

    /// Returns a unique tmp dir for this test run so two parallel tests don't
    /// stomp on each other (cargo runs tests on multiple threads by default).
    fn unique_tmp(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut p = std::env::temp_dir();
        p.push(format!("inkmarshal-engine-test-{prefix}-{nanos}"));
        fs::create_dir_all(&p).expect("mk tmp");
        p
    }

    fn stub_running_child() -> Child {
        // Sleep long enough that the test always finishes first; callers clean
        // the process through stop_all/terminate_running_engine.
        #[cfg(unix)]
        {
            Command::new("sleep")
                .arg("60")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn sleep")
        }
        #[cfg(not(unix))]
        {
            Command::new("cmd")
                .args(["/C", "ping", "-n", "60", "127.0.0.1"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn ping")
        }
    }

    #[cfg(windows)]
    fn test_job_for_child(child: &Child) -> WindowsJob {
        let job = WindowsJob::new().expect("create test job");
        job.assign_child(child).expect("assign child to test job");
        job
    }

    #[cfg(windows)]
    fn windows_pid_is_running(pid: u32) -> bool {
        let filter = format!("PID eq {pid}");
        let Ok(output) = Command::new("tasklist")
            .args(["/FI", &filter, "/NH"])
            .output()
        else {
            return false;
        };
        String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_object_tears_down_engine_process_tree() {
        let tmp = unique_tmp("windows-job-tree");
        let pid_file = tmp.join("grandchild.pid");
        let pid_path = pid_file.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$p = Start-Process -FilePath ping.exe -ArgumentList '-t','127.0.0.1' -PassThru; \
             Set-Content -Path '{pid_path}' -Value $p.Id; \
             Wait-Process -Id $p.Id"
        );
        let child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn powershell parent");
        let job = test_job_for_child(&child);

        for _ in 0..50 {
            if pid_file.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let grandchild_pid: u32 = fs::read_to_string(&pid_file)
            .expect("grandchild pid written")
            .trim()
            .parse()
            .expect("grandchild pid parses");
        assert!(windows_pid_is_running(grandchild_pid));

        let info = EngineInfo {
            engine_id: make_engine_id(EngineFormat::Gguf, "windows-job-test.gguf", &None),
            format: EngineFormat::Gguf,
            model_path: "windows-job-test.gguf".into(),
            port: 40006,
            footprint_bytes: 1_000,
            engine_label: None,
        };
        terminate_running_engine(RunningEngine { info, child, job });

        for _ in 0..20 {
            if !windows_pid_is_running(grandchild_pid) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(!windows_pid_is_running(grandchild_pid));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn estimate_footprint_gguf_is_size_times_multiplier() {
        let tmp = unique_tmp("gguf");
        let file = tmp.join("fake.gguf");
        // 10_000 bytes of zeros — exact, deterministic, and small enough that
        // even slow CI disks don't notice. Multiplier × size is what we assert.
        fs::write(&file, vec![0u8; 10_000]).expect("write fake gguf");

        let f = estimate_footprint_inner(&file, EngineFormat::Gguf).expect("estimate");
        assert_eq!(f.model_size_bytes, 10_000);
        let expected = ((10_000_f64) * GGUF_FOOTPRINT_MULTIPLIER) as u64;
        assert_eq!(f.ram_bytes, expected);
        assert_eq!(f.vram_hint_bytes, expected);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn estimate_footprint_mlx_sums_directory_recursively() {
        let tmp = unique_tmp("mlx");
        let sub = tmp.join("nested");
        fs::create_dir_all(&sub).expect("mk sub");
        fs::write(tmp.join("config.json"), vec![0u8; 100]).expect("config");
        fs::write(tmp.join("model.safetensors"), vec![0u8; 5_000]).expect("weights");
        fs::write(sub.join("tokenizer.json"), vec![0u8; 900]).expect("tok");

        let f = estimate_footprint_inner(&tmp, EngineFormat::Mlx).expect("estimate");
        let raw = 100 + 5_000 + 900;
        assert_eq!(f.model_size_bytes, raw);
        let expected = ((raw as f64) * MLX_FOOTPRINT_MULTIPLIER) as u64;
        assert_eq!(f.ram_bytes, expected);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn estimate_footprint_mlx_ignores_symlinks() {
        use std::os::unix::fs::symlink;

        let tmp = unique_tmp("mlx-symlink");
        let outside = unique_tmp("mlx-outside");
        fs::write(tmp.join("config.json"), vec![0u8; 100]).expect("config");
        fs::write(tmp.join("model.safetensors"), vec![0u8; 5_000]).expect("weights");
        fs::write(outside.join("outside.safetensors"), vec![0u8; 10_000]).expect("outside");
        fs::create_dir_all(outside.join("outside-dir")).expect("outside dir");
        fs::write(
            outside.join("outside-dir").join("extra.bin"),
            vec![0u8; 20_000],
        )
        .expect("extra");
        symlink(
            outside.join("outside.safetensors"),
            tmp.join("linked.safetensors"),
        )
        .expect("file symlink");
        symlink(outside.join("outside-dir"), tmp.join("linked-dir")).expect("dir symlink");

        let f = estimate_footprint_inner(&tmp, EngineFormat::Mlx).expect("estimate");
        let raw = 100 + 5_000;
        assert_eq!(f.model_size_bytes, raw);

        let _ = fs::remove_dir_all(&tmp);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn estimate_footprint_rejects_wrong_kind() {
        let tmp = unique_tmp("wrongkind");
        // GGUF expects a file but receives a directory → error message.
        let err = estimate_footprint_inner(&tmp, EngineFormat::Gguf).unwrap_err();
        assert!(err.contains("not a regular file"));

        let file = tmp.join("not-a-snapshot.gguf");
        fs::write(&file, b"x").expect("write");
        // MLX expects a directory but receives a file → error message.
        let err = estimate_footprint_inner(&file, EngineFormat::Mlx).unwrap_err();
        assert!(err.contains("not a directory"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn validate_engine_model_path_rejects_non_model_paths() {
        let tmp = unique_tmp("validate");
        let gguf = tmp.join("writer.gguf");
        fs::write(&gguf, b"GGUFmodel").expect("gguf");
        let notes = tmp.join("notes.txt");
        fs::write(&notes, b"not a model").expect("notes");
        let mlx = tmp.join("mlx-model");
        fs::create_dir_all(&mlx).expect("mlx");
        fs::write(mlx.join("config.json"), b"{}").expect("config");
        fs::write(mlx.join("tokenizer.json"), b"{}").expect("tokenizer");
        fs::write(mlx.join("model.safetensors"), b"weights").expect("weights");

        assert_eq!(
            validate_engine_model_path(&gguf, EngineFormat::Gguf).expect("gguf"),
            gguf.canonicalize().expect("canonical gguf"),
        );
        assert!(validate_engine_model_path(&notes, EngineFormat::Gguf)
            .expect_err("wrong extension")
            .contains(".gguf"));
        assert!(validate_engine_model_path(&gguf, EngineFormat::Mlx)
            .expect_err("wrong kind")
            .contains("not a directory"));
        assert_eq!(
            validate_engine_model_path(&mlx, EngineFormat::Mlx).expect("mlx"),
            mlx.canonicalize().expect("canonical mlx"),
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn validate_engine_model_path_requires_mlx_weights() {
        let tmp = unique_tmp("validate-missing-weights");
        let mlx = tmp.join("mlx-model");
        fs::create_dir_all(&mlx).expect("mlx");
        fs::write(mlx.join("config.json"), b"{}").expect("config");
        fs::write(mlx.join("tokenizer.json"), b"{}").expect("tokenizer");

        let err = validate_engine_model_path(&mlx, EngineFormat::Mlx)
            .expect_err("missing safetensors rejected");
        assert!(err.contains("safetensors"));

        let nested = mlx.join("nested");
        fs::create_dir_all(&nested).expect("nested");
        fs::write(nested.join("model.safetensors"), b"weights").expect("weights");
        assert!(validate_engine_model_path(&mlx, EngineFormat::Mlx)
            .expect_err("nested safetensors rejected")
            .contains("root-level"));

        fs::write(mlx.join("model.safetensors"), b"weights").expect("root weights");
        assert_eq!(
            validate_engine_model_path(&mlx, EngineFormat::Mlx).expect("mlx"),
            mlx.canonicalize().expect("canonical mlx"),
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn validate_engine_model_path_rejects_symlinks() {
        use std::os::unix::fs::symlink;

        let tmp = unique_tmp("validate-symlink");
        let target = tmp.join("writer.gguf");
        let linked = tmp.join("linked.gguf");
        fs::write(&target, b"GGUFmodel").expect("gguf");
        symlink(&target, &linked).expect("symlink");

        let err =
            validate_engine_model_path(&linked, EngineFormat::Gguf).expect_err("symlink rejected");
        assert!(err.contains("symlink"));

        let _ = fs::remove_dir_all(&tmp);
    }

    /// Registry-level co-existence: we can't actually spawn `llama-server` in
    /// a unit test (no binary in test resources, and we don't want a 30 s
    /// integration test), so we exercise the data-structure path directly —
    /// inserting two pre-built `RunningEngine`s and asserting `engine_status`
    /// returns both. This covers the *contract* the removed `stop_all` call
    /// was breaking: distinct `engine_id`s must co-exist in the HashMap.
    #[test]
    fn two_engines_for_different_paths_coexist_in_registry() {
        let registry = EngineRegistry::default();

        let info_a = EngineInfo {
            engine_id: make_engine_id(EngineFormat::Gguf, "/m/a.gguf", &None),
            format: EngineFormat::Gguf,
            model_path: "/m/a.gguf".into(),
            port: 40001,
            footprint_bytes: 1_000,
            engine_label: None,
        };
        let info_b = EngineInfo {
            engine_id: make_engine_id(EngineFormat::Gguf, "/m/b.gguf", &None),
            format: EngineFormat::Gguf,
            model_path: "/m/b.gguf".into(),
            port: 40002,
            footprint_bytes: 2_000,
            engine_label: None,
        };

        let child_a = stub_running_child();
        let child_b = stub_running_child();
        #[cfg(unix)]
        let (pgid_a, pgid_b) = (child_a.id() as i32, child_b.id() as i32);
        #[cfg(windows)]
        let (job_a, job_b) = (test_job_for_child(&child_a), test_job_for_child(&child_b));

        {
            let mut map = registry.0.lock().expect("lock");
            map.insert(
                info_a.engine_id.clone(),
                RunningEngine {
                    info: info_a.clone(),
                    child: child_a,
                    #[cfg(unix)]
                    pgid: pgid_a,
                    #[cfg(windows)]
                    job: job_a,
                },
            );
            map.insert(
                info_b.engine_id.clone(),
                RunningEngine {
                    info: info_b.clone(),
                    child: child_b,
                    #[cfg(unix)]
                    pgid: pgid_b,
                    #[cfg(windows)]
                    job: job_b,
                },
            );
        }

        assert_eq!(registry.0.lock().unwrap().len(), 2);

        // Clean up so the sleep processes don't linger past the test.
        stop_all(&registry);
        assert_eq!(registry.0.lock().unwrap().len(), 0);
    }

    #[test]
    fn duplicate_active_engine_id_is_not_replaced_in_registry() {
        let registry = EngineRegistry::default();
        let info = EngineInfo {
            engine_id: make_engine_id(EngineFormat::Gguf, "/m/a.gguf", &None),
            format: EngineFormat::Gguf,
            model_path: "/m/a.gguf".into(),
            port: 40004,
            footprint_bytes: 1_000,
            engine_label: None,
        };
        let first_child = stub_running_child();
        #[cfg(unix)]
        let first_pgid = first_child.id() as i32;
        let second_child = stub_running_child();
        #[cfg(unix)]
        let second_pgid = second_child.id() as i32;
        #[cfg(windows)]
        let first_job = test_job_for_child(&first_child);
        #[cfg(windows)]
        let second_job = test_job_for_child(&second_child);

        let inserted = register_running_engine(
            &registry,
            info.engine_id.clone(),
            RunningEngine {
                info: info.clone(),
                child: first_child,
                #[cfg(unix)]
                pgid: first_pgid,
                #[cfg(windows)]
                job: first_job,
            },
        )
        .expect("first insert");
        assert!(matches!(inserted, RegisterEngineResult::Inserted));

        let duplicate = register_running_engine(
            &registry,
            info.engine_id.clone(),
            RunningEngine {
                info: EngineInfo {
                    port: 40005,
                    ..info.clone()
                },
                child: second_child,
                #[cfg(unix)]
                pgid: second_pgid,
                #[cfg(windows)]
                job: second_job,
            },
        )
        .expect("duplicate handled");

        match duplicate {
            RegisterEngineResult::Duplicate { existing, rejected } => {
                assert_eq!(existing.port, 40004);
                terminate_running_engine(*rejected);
            }
            RegisterEngineResult::Inserted => panic!("duplicate should not replace active engine"),
        }
        let ports: Vec<u16> = registry
            .0
            .lock()
            .expect("lock")
            .values()
            .map(|engine| engine.info.port)
            .collect();
        assert_eq!(ports, vec![40004]);

        stop_all(&registry);
    }

    #[test]
    fn engine_env_allowlist_excludes_provider_and_runtime_secrets() {
        assert!(engine_env_allows("HOME"));
        assert!(engine_env_allows("PATH"));
        assert!(engine_env_allows("TMPDIR"));
        assert!(!engine_env_allows("DYLD_LIBRARY_PATH"));
        assert!(!engine_env_allows("DYLD_FALLBACK_LIBRARY_PATH"));
        assert!(!engine_env_allows("OPENAI_API_KEY"));
        assert!(!engine_env_allows("ANTHROPIC_API_KEY"));
        assert!(!engine_env_allows("HF_TOKEN"));
        assert!(!engine_env_allows("INKMARSHAL_DESKTOP_SESSION"));
        assert!(!engine_env_allows("INKMARSHAL_DATA_DIR"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn engine_loader_env_points_dyld_to_bundled_engine_dir_on_macos() {
        let bin = PathBuf::from(
            "/Applications/InkMarshal.app/Contents/Resources/engines/aarch64-apple-darwin/llama-server",
        );
        let envs: HashMap<&str, OsString> = engine_loader_env(&bin).into_iter().collect();
        let engine_dir = OsString::from(
            "/Applications/InkMarshal.app/Contents/Resources/engines/aarch64-apple-darwin",
        );

        assert_eq!(envs.get("DYLD_LIBRARY_PATH"), Some(&engine_dir));
        assert_eq!(envs.get("DYLD_FALLBACK_LIBRARY_PATH"), Some(&engine_dir));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn engine_loader_env_is_empty_off_macos() {
        assert!(engine_loader_env(Path::new("/tmp/llama-server")).is_empty());
    }

    #[test]
    fn status_pruning_removes_exited_engine_processes() {
        fn finished_child() -> Child {
            #[cfg(unix)]
            {
                Command::new("sh")
                    .args(["-c", "exit 0"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .expect("spawn finished child")
            }
            #[cfg(not(unix))]
            {
                Command::new("cmd")
                    .args(["/C", "exit", "0"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .expect("spawn finished child")
            }
        }

        let mut child = finished_child();
        #[cfg(unix)]
        let pgid = child.id() as i32;
        #[cfg(windows)]
        let job = test_job_for_child(&child);
        let _ = child.wait();
        let mut map = HashMap::new();
        let info = EngineInfo {
            engine_id: make_engine_id(EngineFormat::Gguf, "/m/exited.gguf", &None),
            format: EngineFormat::Gguf,
            model_path: "/m/exited.gguf".into(),
            port: 40003,
            footprint_bytes: 1_000,
            engine_label: None,
        };
        map.insert(
            info.engine_id.clone(),
            RunningEngine {
                info,
                child,
                #[cfg(unix)]
                pgid,
                #[cfg(windows)]
                job,
            },
        );

        prune_exited_engines(&mut map);

        assert!(map.is_empty());
    }
}
