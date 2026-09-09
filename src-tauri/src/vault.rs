use keyring::Entry;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultAvailability {
    pub available: bool,
    pub reason: Option<String>,
}

fn entry_for(service: &str, key: &str) -> Result<Entry, String> {
    Entry::new(service, key).map_err(|error| format!("Vault entry unavailable: {error}"))
}

#[tauri::command]
pub fn vault_check_availability() -> VaultAvailability {
    match entry_for("trackdidia", "availability-probe") {
        Ok(entry) => match entry.set_password("__probe__") {
            Ok(()) => {
                let _ = entry.delete_credential();
                VaultAvailability {
                    available: true,
                    reason: None,
                }
            }
            Err(error) => VaultAvailability {
                available: false,
                reason: Some(format!("vault_write_failed:{error}")),
            },
        },
        Err(reason) => VaultAvailability {
            available: false,
            reason: Some(reason),
        },
    }
}

#[tauri::command]
pub fn vault_store_secret(service: String, key: String, secret: String) -> Result<(), String> {
    let entry = entry_for(&service, &key)?;
    entry
        .set_password(&secret)
        .map_err(|error| format!("Vault store failed: {error}"))
}

#[tauri::command]
pub fn vault_load_secret(service: String, key: String) -> Result<Option<String>, String> {
    let entry = entry_for(&service, &key)?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("Vault load failed: {error}")),
    }
}

#[tauri::command]
pub fn vault_delete_secret(service: String, key: String) -> Result<(), String> {
    let entry = entry_for(&service, &key)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Vault delete failed: {error}")),
    }
}
