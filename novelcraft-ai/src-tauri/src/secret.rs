//! Secret storage with three-tier fallback:
//!   1. OS keychain (macOS Keychain, Windows Credential Manager, freedesktop
//!      Secret Service) — preferred path.
//!   2. AES-256-GCM encrypted file under the app data dir — used when the OS
//!      keychain probe fails (Linux sandboxes that block libsecret, certain
//!      CI/headless boxes, etc.). The master key is generated on first run and
//!      stored alongside as `secret.key` with 0600 perms on Unix.
//!   3. (informational) `PlaintextFile` would be the last-ditch tier on
//!      sandboxes that cannot persist a private key — currently NOT enabled.
//!      The fallback file is always encrypted.

use crate::inkmarshal_home;
use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use keyring::{Entry, Error as KeyringError};
use rand::RngCore;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const SERVICE: &str = "co.inkmarshal.studio";
const CONNECTION_SECRET_PREFIX: &str = "connection:";
const MAX_SECRET_ACCOUNT_BYTES: usize = 2_096;
const MAX_SECRET_VALUE_BYTES: usize = 16_384;

/// Backend probe is sticky for the lifetime of the process: the OS keychain
/// either works or it doesn't, and re-probing on every secret call adds a
/// round-trip + leaves a stray test credential each time.
static BACKEND_CACHE: OnceLock<SecretBackend> = OnceLock::new();
static FALLBACK_STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretBackend {
    Keychain,
    EncryptedFile,
}

#[derive(Debug, Serialize)]
pub struct SecretGetResult {
    pub value: Option<String>,
    pub backend: SecretBackend,
}

#[derive(Debug, Serialize)]
pub struct SecretBackendStatus {
    pub backend: SecretBackend,
}

fn probe_keychain() -> SecretBackend {
    *BACKEND_CACHE.get_or_init(|| {
        let Ok(entry) = Entry::new(SERVICE, "_probe_") else {
            return SecretBackend::EncryptedFile;
        };
        // Some keyring backends accept set+get but not delete; treat any error
        // in the round-trip as a fallback signal.
        match entry.set_password("probe") {
            Ok(()) => {
                let read_ok = entry.get_password().is_ok();
                let _ = entry.delete_credential();
                if read_ok {
                    SecretBackend::Keychain
                } else {
                    SecretBackend::EncryptedFile
                }
            }
            Err(_) => SecretBackend::EncryptedFile,
        }
    })
}

fn fallback_dir(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = inkmarshal_home::inkmarshal_app_dir()?.join("secrets");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create secret dir: {e}"))?;
    ensure_private_secret_dir(&dir)?;
    Ok(dir)
}

fn ensure_private_secret_dir(dir: &Path) -> Result<(), String> {
    let md = std::fs::symlink_metadata(dir).map_err(|e| format!("Cannot stat secret dir: {e}"))?;
    if md.file_type().is_symlink() {
        return Err("Secret dir cannot be a symlink".to_string());
    }
    if !md.is_dir() {
        return Err("Secret dir is not a directory".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Cannot secure secret dir permissions: {e}"))?;
    }
    Ok(())
}

fn master_key_path(dir: &Path) -> PathBuf {
    dir.join("secret.key")
}

fn fallback_store_path(dir: &Path) -> PathBuf {
    dir.join("secrets.bin")
}

fn read_or_create_master_key(dir: &Path) -> Result<[u8; 32], String> {
    let path = master_key_path(dir);
    match read_secret_file_if_exists(&path)? {
        Some(bytes) => {
            if bytes.len() != 32 {
                return Err("Master key file is corrupted (wrong length)".to_string());
            }
            let mut k = [0u8; 32];
            k.copy_from_slice(&bytes);
            Ok(k)
        }
        None => {
            let mut k = [0u8; 32];
            OsRng.fill_bytes(&mut k);
            write_secret_file(&path, &k)?;
            Ok(k)
        }
    }
}

fn read_secret_file_if_exists(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(md) => {
            if md.file_type().is_symlink() {
                return Err(format!(
                    "Secret file cannot be a symlink: {}",
                    path.display()
                ));
            }
            if !md.is_file() {
                return Err(format!("Secret path is not a file: {}", path.display()));
            }
            ensure_private_secret_file(path)?;
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Cannot stat secret file: {err}")),
    }

    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("Cannot read secret file: {e}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot read secret file: {e}"))?;
    Ok(Some(bytes))
}

fn ensure_private_secret_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let md = std::fs::symlink_metadata(path)
            .map_err(|e| format!("Cannot stat secret file permissions: {e}"))?;
        if md.file_type().is_symlink() {
            return Err(format!(
                "Secret file cannot be a symlink: {}",
                path.display()
            ));
        }
        if md.permissions().mode() & 0o777 != 0o600 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("Cannot secure secret file permissions: {e}"))?;
        }
    }
    let _ = path;
    Ok(())
}

fn write_secret_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Secret file path has no parent".to_string())?;
    ensure_private_secret_dir(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("secret");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(".{file_name}.{}.{}.tmp", std::process::id(), nanos));
    let result: Result<(), String> = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options
            .open(&tmp)
            .map_err(|e| format!("Cannot create secret temp file: {e}"))?;
        file.write_all(bytes)
            .map_err(|e| format!("Cannot write secret temp file: {e}"))?;
        let _ = file.sync_all();
        std::fs::rename(&tmp, path).map_err(|e| format!("Cannot replace secret file: {e}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn load_store(dir: &Path, key: &[u8; 32]) -> Result<HashMap<String, String>, String> {
    let path = fallback_store_path(dir);
    let Some(raw) = read_secret_file_if_exists(&path)? else {
        return Ok(HashMap::new());
    };
    if raw.len() < 12 {
        return Err("Secret store is corrupted (truncated)".to_string());
    }
    let (nonce_bytes, ciphertext) = raw.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| "Secret store decryption failed".to_string())?;
    let mapping: HashMap<String, String> = serde_json::from_slice(&plaintext)
        .map_err(|e| format!("Secret store JSON parse failed: {e}"))?;
    Ok(mapping)
}

fn save_store(dir: &Path, key: &[u8; 32], mapping: &HashMap<String, String>) -> Result<(), String> {
    let plaintext = serde_json::to_vec(mapping)
        .map_err(|e| format!("Secret store JSON serialize failed: {e}"))?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_ref())
        .map_err(|_| "Secret store encryption failed".to_string())?;
    let mut out = Vec::with_capacity(12 + ciphertext.len());
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ciphertext);
    let path = fallback_store_path(dir);
    write_secret_file(&path, &out)?;
    Ok(())
}

fn b64_account(account: &str) -> String {
    B64.encode(account.as_bytes())
}

fn validate_secret_account(account: &str) -> Result<(), String> {
    if account.is_empty()
        || account.len() > MAX_SECRET_ACCOUNT_BYTES
        || !account.starts_with(CONNECTION_SECRET_PREFIX)
        || account.len() == CONNECTION_SECRET_PREFIX.len()
        || account.chars().any(char::is_control)
    {
        return Err("Secret account is invalid".to_string());
    }
    Ok(())
}

fn validate_secret_value(secret: &str) -> Result<(), String> {
    // We intentionally check `chars().any(char::is_control)` on the raw
    // string rather than after trim — leading/trailing newlines pasted from
    // a UI accidentally become part of an API key, which then fails to
    // authenticate in a way that's frustrating to debug. Surfacing this as
    // a validation error keeps the user in the keychain UI rather than
    // letting the bad value reach a model provider.
    if secret.trim().is_empty()
        || secret.len() > MAX_SECRET_VALUE_BYTES
        || secret.chars().any(char::is_control)
    {
        return Err("Secret value is invalid".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn keychain_status(app: tauri::AppHandle) -> SecretBackendStatus {
    let _ = app; // accepted for symmetry with the other commands
    SecretBackendStatus {
        backend: probe_keychain(),
    }
}

#[tauri::command]
pub fn keychain_set(
    app: tauri::AppHandle,
    account: String,
    secret: String,
) -> Result<SecretBackend, String> {
    validate_secret_account(&account)?;
    validate_secret_value(&secret)?;
    match probe_keychain() {
        SecretBackend::Keychain => {
            let entry = Entry::new(SERVICE, &account).map_err(|e| e.to_string())?;
            entry.set_password(&secret).map_err(|e| e.to_string())?;
            Ok(SecretBackend::Keychain)
        }
        SecretBackend::EncryptedFile => {
            let _guard = FALLBACK_STORE_LOCK
                .lock()
                .map_err(|_| "Secret store lock poisoned".to_string())?;
            let dir = fallback_dir(&app)?;
            let key = read_or_create_master_key(&dir)?;
            let mut mapping = load_store(&dir, &key)?;
            mapping.insert(b64_account(&account), secret);
            save_store(&dir, &key, &mapping)?;
            Ok(SecretBackend::EncryptedFile)
        }
    }
}

#[tauri::command]
pub fn keychain_get(app: tauri::AppHandle, account: String) -> Result<SecretGetResult, String> {
    validate_secret_account(&account)?;
    match probe_keychain() {
        SecretBackend::Keychain => {
            let entry = Entry::new(SERVICE, &account).map_err(|e| e.to_string())?;
            match entry.get_password() {
                Ok(secret) => Ok(SecretGetResult {
                    value: Some(secret),
                    backend: SecretBackend::Keychain,
                }),
                Err(KeyringError::NoEntry) => Ok(SecretGetResult {
                    value: None,
                    backend: SecretBackend::Keychain,
                }),
                Err(e) => Err(e.to_string()),
            }
        }
        SecretBackend::EncryptedFile => {
            let _guard = FALLBACK_STORE_LOCK
                .lock()
                .map_err(|_| "Secret store lock poisoned".to_string())?;
            let dir = fallback_dir(&app)?;
            let key = read_or_create_master_key(&dir)?;
            let mapping = load_store(&dir, &key)?;
            Ok(SecretGetResult {
                value: mapping.get(&b64_account(&account)).cloned(),
                backend: SecretBackend::EncryptedFile,
            })
        }
    }
}

#[tauri::command]
pub fn keychain_delete(app: tauri::AppHandle, account: String) -> Result<SecretBackend, String> {
    validate_secret_account(&account)?;
    match probe_keychain() {
        SecretBackend::Keychain => {
            let entry = Entry::new(SERVICE, &account).map_err(|e| e.to_string())?;
            match entry.delete_credential() {
                Ok(()) | Err(KeyringError::NoEntry) => Ok(SecretBackend::Keychain),
                Err(e) => Err(e.to_string()),
            }
        }
        SecretBackend::EncryptedFile => {
            let _guard = FALLBACK_STORE_LOCK
                .lock()
                .map_err(|_| "Secret store lock poisoned".to_string())?;
            let dir = fallback_dir(&app)?;
            let key = read_or_create_master_key(&dir)?;
            let mut mapping = load_store(&dir, &key)?;
            mapping.remove(&b64_account(&account));
            save_store(&dir, &key, &mapping)?;
            Ok(SecretBackend::EncryptedFile)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn unique_tmp(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "inkmarshal-secret-test-{prefix}-{}-{nanos}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("tmp dir");
        path
    }

    #[test]
    fn secret_backend_serializes_as_ts_string_contract() {
        assert_eq!(
            serde_json::to_value(SecretBackend::Keychain).unwrap(),
            serde_json::json!("keychain"),
        );
        assert_eq!(
            serde_json::to_value(SecretBackendStatus {
                backend: SecretBackend::EncryptedFile,
            })
            .unwrap(),
            serde_json::json!({ "backend": "encrypted_file" }),
        );
    }

    #[test]
    fn secret_commands_accept_only_namespaced_bounded_values() {
        validate_secret_account("connection:abc").expect("valid account");
        validate_secret_value("sk-valid-token").expect("valid secret");

        assert!(validate_secret_account("").is_err());
        assert!(validate_secret_account("provider").is_err());
        assert!(validate_secret_account("connection:").is_err());
        assert!(validate_secret_account("connection:bad\nid").is_err());
        assert!(validate_secret_account(&format!(
            "connection:{}",
            "a".repeat(MAX_SECRET_ACCOUNT_BYTES)
        ))
        .is_err());

        assert!(validate_secret_value("").is_err());
        assert!(validate_secret_value("   ").is_err());
        assert!(validate_secret_value("sk-line\nbreak").is_err());
        assert!(validate_secret_value(&"s".repeat(MAX_SECRET_VALUE_BYTES + 1)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn master_key_rejects_symlink_files() {
        use std::os::unix::fs::symlink;

        let dir = unique_tmp("master-symlink");
        ensure_private_secret_dir(&dir).expect("secure dir");
        let outside =
            dir.with_file_name(format!("inkmarshal-secret-outside-{}", std::process::id()));
        fs::write(&outside, [7_u8; 32]).expect("outside key");
        symlink(&outside, master_key_path(&dir)).expect("key symlink");

        let err = read_or_create_master_key(&dir).expect_err("reject symlink key");
        assert!(err.contains("symlink"));
        assert_eq!(fs::read(&outside).expect("outside unchanged"), [7_u8; 32]);

        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn secret_store_write_replaces_symlink_without_touching_target() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let dir = unique_tmp("store-symlink");
        ensure_private_secret_dir(&dir).expect("secure dir");
        let outside = dir.with_file_name(format!(
            "inkmarshal-secret-store-outside-{}",
            std::process::id()
        ));
        fs::write(&outside, b"do-not-touch").expect("outside");
        symlink(&outside, fallback_store_path(&dir)).expect("store symlink");

        let key = [3_u8; 32];
        let mut mapping = HashMap::new();
        mapping.insert(b64_account("provider"), "secret-value".to_string());
        save_store(&dir, &key, &mapping).expect("save store");

        assert_eq!(
            fs::read_to_string(&outside).expect("outside unchanged"),
            "do-not-touch"
        );
        let link_md = fs::symlink_metadata(fallback_store_path(&dir)).expect("store metadata");
        assert!(!link_md.file_type().is_symlink());
        assert_eq!(link_md.permissions().mode() & 0o777, 0o600);
        assert_eq!(
            load_store(&dir, &key)
                .expect("load encrypted store")
                .get(&b64_account("provider"))
                .cloned(),
            Some("secret-value".to_string())
        );

        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn reading_existing_secret_file_tightens_world_readable_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = unique_tmp("tighten-file");
        ensure_private_secret_dir(&dir).expect("secure dir");
        let key_path = master_key_path(&dir);
        fs::write(&key_path, [9_u8; 32]).expect("key");
        fs::set_permissions(&key_path, fs::Permissions::from_mode(0o644)).expect("chmod key");

        assert_eq!(
            read_or_create_master_key(&dir).expect("read key"),
            [9_u8; 32]
        );
        let mode = fs::symlink_metadata(&key_path)
            .expect("key metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);

        let _ = fs::remove_dir_all(&dir);
    }
}
