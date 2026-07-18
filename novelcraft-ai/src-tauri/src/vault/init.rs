//! Vault bootstrap: creates the directory skeleton and the `.ainovel/manifest.json`
//! that binds a vault to a novel id.

use super::path::{
    ensure_dir_inside, ensure_manifest_matches_novel, ensure_manifest_path_inside,
    validate_vault_root_before_init, vault_manifest_path, vault_root,
};
use super::VaultInitResult;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) const VAULT_SUBDIRS: &[&str] = &[
    "characters",
    "worlds",
    "timeline",
    "outline",
    "styles",
    ".ainovel",
    ".ainovel/trash",
    ".ainovel/conflicts",
    ".ainovel/pending-writes",
];

#[tauri::command]
pub fn vault_init(novel_id: String, vault_path: String) -> Result<VaultInitResult, String> {
    let root = PathBuf::from(&vault_path);
    let created_now = validate_vault_root_before_init(&root)?;
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Cannot create vault root '{vault_path}': {e}"))?;
    let root = vault_root(&vault_path)?;

    for sub in VAULT_SUBDIRS {
        ensure_dir_inside(&root, sub)?;
    }

    let manifest_path = vault_manifest_path(&root);
    ensure_manifest_path_inside(&root, &manifest_path)?;
    if manifest_path.exists() {
        ensure_manifest_matches_novel(&manifest_path, &novel_id)?;
    } else {
        let manifest = serde_json::json!({
            "novelId": novel_id,
            "createdAt": chrono_now_iso(),
            "schemaVersion": 1,
            "outlineOrder": [],
        });
        let body = serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("Cannot serialize manifest: {e}"))?;
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&manifest_path)
            .map_err(|e| format!("Cannot create manifest '{}': {e}", manifest_path.display()))?;
        file.write_all(body.as_bytes())
            .map_err(|e| format!("Cannot write manifest: {e}"))?;
    }

    Ok(VaultInitResult {
        vault_path: root.to_string_lossy().into_owned(),
        created: created_now,
        manifest_path: manifest_path.to_string_lossy().into_owned(),
    })
}

/// Tiny ISO-8601 timestamp generator. Self-contained — we don't want to pull
/// in the `chrono` crate just for one timestamp.
fn chrono_now_iso() -> String {
    // YYYY-MM-DDTHH:MM:SS.mmmZ — best-effort, falls back to "epoch+ms".
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let nanos = dur.subsec_nanos();
    // Convert to date components. Algorithm from Howard Hinnant's date.
    let days = secs.div_euclid(86_400);
    let mut secs_of_day = secs.rem_euclid(86_400);
    let h = secs_of_day / 3600;
    secs_of_day %= 3600;
    let m = secs_of_day / 60;
    let s = secs_of_day % 60;
    // 1970-01-01 is day 0 in Unix epoch.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        mo,
        d,
        h,
        m,
        s,
        nanos / 1_000_000
    )
}
