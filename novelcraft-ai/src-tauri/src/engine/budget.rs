//! Resource-budget admission (atomic reservation that closes the spawn TOCTOU)
//! and coarse RAM footprint estimation for GGUF files / MLX snapshot dirs.

use super::registry::{prune_exited_engines, EngineRegistry};
use super::{EngineFootprint, EngineFormat};
use std::path::{Path, PathBuf};

/// OS reserve baked into the available-RAM calculation: even if every running
/// engine fits inside total RAM, we never advertise the last 4 GB as free —
/// the host OS, the Next runtime, and the webview all need headroom.
pub(super) const RESERVED_FOR_OS_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// GGUF in-RAM footprint multiplier vs. file size — covers KV cache + scratch.
/// 1.15 is conservative-ish for Q4/Q5; intentionally an over-estimate, the UI
/// will let users override per-engine in a follow-up commit.
pub(super) const GGUF_FOOTPRINT_MULTIPLIER: f64 = 1.15;

/// MLX snapshot dirs hold safetensors + tokenizer + config; runtime overhead
/// is slightly lower than GGUF because MLX doesn't pre-allocate KV cache the
/// same way. 1.10 is the matching coarse coefficient.
pub(super) const MLX_FOOTPRINT_MULTIPLIER: f64 = 1.10;

/// Available RAM after subtracting the OS reserve and everything already
/// committed (running plus reserved). Pure, so the admission decision is
/// unit-testable without spawning engines. saturating_sub keeps an
/// over-committed box honest (available=0, never a wrap-around to "18 EB free").
pub(super) fn budget_available_bytes(total: u64, running_sum: u64, reserved_sum: u64) -> u64 {
    total
        .saturating_sub(RESERVED_FOR_OS_BYTES)
        .saturating_sub(running_sum)
        .saturating_sub(reserved_sum)
}

/// RAII reservation: the footprint admitted into `registry.1` is removed when
/// this guard drops, whatever exit path engine_start takes (success, duplicate,
/// spawn failure, readiness timeout, or panic). During a successful start the
/// engine is also in the running map for the guard's lifetime, so the budget
/// briefly counts the footprint in BOTH maps — a safe over-count, never an
/// under-count that could over-commit.
pub(super) struct ReservationGuard<'a> {
    registry: &'a EngineRegistry,
    engine_id: String,
}

impl Drop for ReservationGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut reserved) = self.registry.1.lock() {
            reserved.remove(&self.engine_id);
        }
    }
}

/// Atomically admit an engine of `footprint` bytes. Under the admission lock,
/// sum the committed RAM (running + already-reserved) and reject if this start
/// would exceed the budget; otherwise reserve the footprint and return a guard
/// that frees it on drop. This closes the check→spawn race the advisory TS-side
/// check cannot: two concurrent starts can no longer both see the same free RAM.
/// A footprint of 0 (unmeasurable model) is always admitted and contributes 0 —
/// same honesty caveat as `engine_resource_budget`.
pub(super) fn admit_engine<'a>(
    registry: &'a EngineRegistry,
    footprint: u64,
    engine_id: &str,
) -> Result<ReservationGuard<'a>, String> {
    // Lock order: admission (.1) first, then running (.0). See EngineRegistry.
    let mut reserved = registry
        .1
        .lock()
        .map_err(|_| "engine admission lock poisoned".to_string())?;
    let running_sum: u64 = registry
        .0
        .lock()
        .map(|mut m| {
            prune_exited_engines(&mut m);
            m.values().map(|e| e.info.footprint_bytes).sum()
        })
        .unwrap_or(0);
    let reserved_sum: u64 = reserved.values().sum();
    let total = crate::system_memory_bytes().unwrap_or(0);
    let available = budget_available_bytes(total, running_sum, reserved_sum);
    if footprint > available {
        return Err(format!(
            "ENGINE_BUDGET_EXCEEDED:{{\"requiredBytes\":{footprint},\"availableBytes\":{available},\"reservedForOsBytes\":{RESERVED_FOR_OS_BYTES},\"totalBytes\":{total}}}"
        ));
    }
    reserved.insert(engine_id.to_string(), footprint);
    Ok(ReservationGuard {
        registry,
        engine_id: engine_id.to_string(),
    })
}

pub(super) fn estimate_footprint_inner(
    path: &Path,
    format: EngineFormat,
) -> Result<EngineFootprint, String> {
    let model_size = match format {
        EngineFormat::Gguf => {
            let meta = std::fs::metadata(path)
                .map_err(|e| format!("Cannot stat GGUF model at {}: {e}", path.display()))?;
            if !meta.is_file() {
                return Err(format!(
                    "GGUF model path is not a regular file: {}",
                    path.display()
                ));
            }
            meta.len()
        }
        EngineFormat::Mlx => {
            let meta = std::fs::metadata(path)
                .map_err(|e| format!("Cannot stat MLX snapshot dir at {}: {e}", path.display()))?;
            if !meta.is_dir() {
                return Err(format!(
                    "MLX model path is not a directory: {}",
                    path.display()
                ));
            }
            dir_size_bytes(path)?
        }
    };

    let multiplier = match format {
        EngineFormat::Gguf => GGUF_FOOTPRINT_MULTIPLIER,
        EngineFormat::Mlx => MLX_FOOTPRINT_MULTIPLIER,
    };
    let ram = ((model_size as f64) * multiplier) as u64;
    Ok(EngineFootprint {
        model_size_bytes: model_size,
        ram_bytes: ram,
        vram_hint_bytes: ram,
    })
}

pub(super) fn validate_engine_model_path(
    path: &Path,
    format: EngineFormat,
) -> Result<PathBuf, String> {
    let link_md = std::fs::symlink_metadata(path)
        .map_err(|e| format!("Cannot stat model path at {}: {e}", path.display()))?;
    if link_md.file_type().is_symlink() {
        return Err(format!(
            "Model path cannot be a symlink: {}",
            path.display()
        ));
    }
    let resolved = path
        .canonicalize()
        .map_err(|e| format!("Cannot resolve model path at {}: {e}", path.display()))?;
    let md = std::fs::metadata(&resolved)
        .map_err(|e| format!("Cannot stat model path at {}: {e}", resolved.display()))?;

    match format {
        EngineFormat::Gguf => {
            if !md.is_file() {
                return Err(format!(
                    "GGUF model path is not a regular file: {}",
                    resolved.display()
                ));
            }
            if !resolved
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("gguf"))
                .unwrap_or(false)
            {
                return Err("GGUF engine requires a .gguf model file".to_string());
            }
        }
        EngineFormat::Mlx => {
            if !md.is_dir() {
                return Err(format!(
                    "MLX model path is not a directory: {}",
                    resolved.display()
                ));
            }
            if !resolved.join("config.json").is_file() {
                return Err("MLX engine requires a model folder with config.json".to_string());
            }
            if !resolved.join("tokenizer.json").is_file() {
                return Err("MLX engine requires a model folder with tokenizer.json".to_string());
            }
            let has_root_weights = std::fs::read_dir(&resolved)
                .map_err(|e| {
                    format!(
                        "Cannot inspect MLX snapshot dir {}: {e}",
                        resolved.display()
                    )
                })?
                .filter_map(Result::ok)
                .any(|entry| {
                    entry
                        .file_type()
                        .map(|kind| kind.is_file())
                        .unwrap_or(false)
                        && entry
                            .path()
                            .extension()
                            .and_then(|ext| ext.to_str())
                            .map(|ext| ext.eq_ignore_ascii_case("safetensors"))
                            .unwrap_or(false)
                });
            if !has_root_weights {
                return Err("MLX engine requires root-level safetensors weights".to_string());
            }
        }
    }
    Ok(resolved)
}

pub(super) fn normalize_engine_model_path_for_match(model_path: &str) -> Result<String, String> {
    let path = Path::new(model_path);
    let link_md = std::fs::symlink_metadata(path)
        .map_err(|e| format!("Cannot stat model path at {}: {e}", path.display()))?;
    if link_md.file_type().is_symlink() {
        return Err(format!(
            "Model path cannot be a symlink: {}",
            path.display()
        ));
    }
    path.canonicalize()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("Cannot resolve model path at {}: {e}", path.display()))
}

/// Recursive sum of regular-file sizes under `dir`. Symlinks are not followed
/// to avoid double-counting (and to stay safe on a maliciously-crafted dir).
pub(super) fn dir_size_bytes(dir: &Path) -> Result<u64, String> {
    fn walk(dir: &Path, acc: &mut u64) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let ftype = entry.file_type()?;
            if ftype.is_symlink() {
                continue;
            }
            if ftype.is_dir() {
                walk(&entry.path(), acc)?;
            } else if ftype.is_file() {
                let md = entry.metadata()?;
                *acc = acc.saturating_add(md.len());
            }
        }
        Ok(())
    }
    let mut total: u64 = 0;
    walk(dir, &mut total)
        .map_err(|e| format!("Cannot size snapshot dir {}: {e}", dir.display()))?;
    Ok(total)
}
