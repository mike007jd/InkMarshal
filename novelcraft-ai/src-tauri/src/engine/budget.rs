//! Resource-budget admission (atomic reservation that closes the spawn TOCTOU)
//! and coarse RAM footprint estimation for GGUF files / MLX snapshot dirs.

use super::registry::{EngineRegistry, ReservationId};
use super::{EngineFootprint, EngineFormat};
use crate::SystemMemory;
use std::path::{Path, PathBuf};

/// Minimum host headroom kept out of the usable pool so the OS, Next runtime,
/// and webview keep breathing room even when OS-reported available is high.
const MIN_HOST_HEADROOM_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Cap on dynamic headroom so very large hosts are not taxed beyond 8 GiB.
const MAX_HOST_HEADROOM_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Dynamic host headroom derived from total physical RAM: `total / 8`, clamped
/// to \[2 GiB, 8 GiB\]. Exposed on the wire as `reservedForOsBytes` so existing
/// TS consumers keep a stable field name while the value scales with the host.
pub(super) fn host_headroom_bytes(total_bytes: u64) -> u64 {
    (total_bytes / 8).clamp(MIN_HOST_HEADROOM_BYTES, MAX_HOST_HEADROOM_BYTES)
}

/// GGUF in-RAM footprint multiplier vs. file size — covers KV cache + scratch.
/// 1.15 is conservative-ish for Q4/Q5; intentionally an over-estimate, the UI
/// will let users override per-engine in a follow-up commit.
pub(super) const GGUF_FOOTPRINT_MULTIPLIER: f64 = 1.15;

/// MLX snapshot dirs hold safetensors + tokenizer + config; runtime overhead
/// is slightly lower than GGUF because MLX doesn't pre-allocate KV cache the
/// same way. 1.10 is the matching coarse coefficient.
pub(super) const MLX_FOOTPRINT_MULTIPLIER: f64 = 1.10;

/// Usable RAM for a new engine: current OS-available physical bytes, minus
/// dynamic host headroom, minus in-flight (not-yet-materialized) reservations.
///
/// Already-resident running engines are **not** subtracted again — the OS
/// `available_bytes` figure already reflects their resident usage. Only cold
/// reservations (admitted but still loading) need explicit protection.
/// saturating_sub keeps an over-committed box honest (usable=0, never a
/// wrap-around to "18 EB free").
pub(super) fn budget_available_bytes(
    available_bytes: u64,
    headroom_bytes: u64,
    reserved_sum: u64,
) -> u64 {
    available_bytes
        .saturating_sub(headroom_bytes)
        .saturating_sub(reserved_sum)
}

/// Structured fail-closed error when the native memory snapshot cannot be
/// obtained. Shape matches sibling admit errors: `ENGINE_MEMORY_UNAVAILABLE:<json>`.
pub(super) fn engine_memory_unavailable_error(reason: &str) -> String {
    let payload = serde_json::json!({ "reason": reason });
    format!("ENGINE_MEMORY_UNAVAILABLE:{payload}")
}

/// RAII reservation: the footprint admitted under a unique [`ReservationId`] in
/// `registry.1` is removed when this guard drops, whatever exit path
/// engine_start takes (success, duplicate, spawn failure, readiness timeout, or
/// panic). The guard identity is the reservation id — not `engine_id` — so
/// dropping one concurrent admission cannot erase another. During cold load the
/// engine is also in the running map while the reservation remains — admission
/// math only counts the reservation (OS available already covers resident
/// pages), so the dual presence is intentional protection for not-yet-faulted
/// pages, never a double-subtract.
pub(super) struct ReservationGuard<'a> {
    registry: &'a EngineRegistry,
    reservation_id: ReservationId,
}

impl Drop for ReservationGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut reserved) = self.registry.1.lock() {
            reserved.remove(self.reservation_id);
        }
    }
}

/// Atomically admit an engine of `footprint` bytes against a provided memory
/// snapshot. Pure w.r.t. the OS query so unit tests can inject large-total /
/// low-available hosts without touching real RAM. Under the admission lock,
/// subtract headroom + already-reserved only; reject if this start would
/// exceed usable bytes; otherwise reserve and return a guard that frees on drop.
///
/// A **genuinely measured** footprint of 0 (e.g. empty model file × multiplier)
/// is always admitted and contributes 0. Estimation failures must never reach
/// this function as 0 — use [`footprint_for_admission`] / [`admit_estimated_footprint`]
/// so unknown size fails closed with `ENGINE_FOOTPRINT_UNKNOWN` before reservation.
pub(super) fn admit_engine_with_snapshot<'a>(
    registry: &'a EngineRegistry,
    footprint: u64,
    _engine_id: &str,
    memory: SystemMemory,
) -> Result<ReservationGuard<'a>, String> {
    // Lock order: admission (.1) only. Running footprints are not subtracted
    // (OS available already reflects them); see EngineRegistry docs.
    // `_engine_id` remains on the admit API for callers / diagnostics; the
    // reservation map is keyed by a unique [`ReservationId`].
    let mut reserved = registry
        .1
        .lock()
        .map_err(|_| "engine admission lock poisoned".to_string())?;
    let reserved_sum = reserved.reserved_sum();
    let headroom = host_headroom_bytes(memory.total_bytes);
    let available = budget_available_bytes(memory.available_bytes, headroom, reserved_sum);
    if footprint > available {
        return Err(format!(
            "ENGINE_BUDGET_EXCEEDED:{{\"requiredBytes\":{footprint},\"availableBytes\":{available},\"reservedForOsBytes\":{headroom},\"totalBytes\":{}}}",
            memory.total_bytes
        ));
    }
    let reservation_id = reserved.insert(footprint);
    Ok(ReservationGuard {
        registry,
        reservation_id,
    })
}

/// Admit against an injected memory-query result. Query `Err` maps to
/// [`engine_memory_unavailable_error`] and never reserves.
pub(super) fn admit_engine_from_memory_result<'a>(
    registry: &'a EngineRegistry,
    footprint: u64,
    engine_id: &str,
    memory: Result<SystemMemory, String>,
) -> Result<ReservationGuard<'a>, String> {
    let memory = memory.map_err(|reason| engine_memory_unavailable_error(&reason))?;
    admit_engine_with_snapshot(registry, footprint, engine_id, memory)
}

/// Atomically admit using a live native memory snapshot. Snapshot failure is
/// fail-closed — no reservation is taken.
pub(super) fn admit_engine<'a>(
    registry: &'a EngineRegistry,
    footprint: u64,
    engine_id: &str,
) -> Result<ReservationGuard<'a>, String> {
    admit_engine_from_memory_result(registry, footprint, engine_id, crate::system_memory())
}

/// Structured fail-closed error when RAM footprint cannot be measured.
/// Shape matches `ENGINE_BUDGET_EXCEEDED`: `ENGINE_FOOTPRINT_UNKNOWN:<json>`.
pub(super) fn engine_footprint_unknown_error(reason: &str) -> String {
    let payload = serde_json::json!({ "reason": reason });
    format!("ENGINE_FOOTPRINT_UNKNOWN:{payload}")
}

/// Resolve measured RAM footprint for admission. Estimation failure is
/// fail-closed — never coerced to 0 — so callers must not reserve or spawn.
pub(super) fn footprint_for_admission(path: &Path, format: EngineFormat) -> Result<u64, String> {
    match estimate_footprint_inner(path, format) {
        Ok(f) => Ok(f.ram_bytes),
        Err(reason) => Err(engine_footprint_unknown_error(&reason)),
    }
}

/// Estimate footprint then atomically admit. On estimate failure the reservation
/// map is untouched (no admission, no process launch by the caller).
pub(super) fn admit_estimated_footprint<'a>(
    registry: &'a EngineRegistry,
    path: &Path,
    format: EngineFormat,
    engine_id: &str,
) -> Result<(u64, ReservationGuard<'a>), String> {
    let footprint = footprint_for_admission(path, format)?;
    let guard = admit_engine(registry, footprint, engine_id)?;
    Ok((footprint, guard))
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
