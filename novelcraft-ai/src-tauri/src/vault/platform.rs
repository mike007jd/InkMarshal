//! Reveal the vault root in the OS file manager (Finder/Explorer/xdg-open).

use super::path::validate_reveal_vault_root;
use std::path::Path;
use std::process::Command;

#[tauri::command]
pub fn vault_reveal_in_finder(novel_id: String, vault_path: String) -> Result<(), String> {
    let root = validate_reveal_vault_root(&novel_id, &vault_path)?;
    reveal_path(&root)
}

fn reveal_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Cannot open vault in Finder: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Cannot open vault in Explorer: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Cannot open vault folder: {e}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Reveal is not supported on this platform".to_string())
}
