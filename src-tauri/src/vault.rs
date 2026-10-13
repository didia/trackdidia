use keyring::Entry;
use serde::Serialize;

const VAULT_SERVICE: &str = "trackdidia";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultAvailability {
    pub available: bool,
    pub reason: Option<String>,
}

fn resolve_key(kind: &str) -> Result<&'static str, String> {
    match kind {
        "calendar_credentials" => Ok("calendar-sync-google-credentials"),
        _ => Err("unsupported vault key kind".to_string()),
    }
}

fn entry_for(key: &str) -> Result<Entry, String> {
    Entry::new(VAULT_SERVICE, key).map_err(|error| format!("Vault entry unavailable: {error}"))
}

#[tauri::command]
pub fn vault_check_availability() -> VaultAvailability {
    match entry_for("availability-probe") {
        Ok(entry) => match entry.get_password() {
            Ok(_) | Err(keyring::Error::NoEntry) => VaultAvailability {
                available: true,
                reason: None,
            },
            Err(error) => VaultAvailability {
                available: false,
                reason: Some(format!("vault_read_failed:{error}")),
            },
        },
        Err(reason) => VaultAvailability {
            available: false,
            reason: Some(reason),
        },
    }
}

#[tauri::command]
pub fn vault_store_secret(kind: String, secret: String) -> Result<(), String> {
    let key = resolve_key(&kind)?;
    let entry = entry_for(key)?;
    entry
        .set_password(&secret)
        .map_err(|error| format!("Vault store failed: {error}"))
}

#[tauri::command]
pub fn vault_load_secret(kind: String) -> Result<Option<String>, String> {
    let key = resolve_key(&kind)?;
    let entry = entry_for(key)?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("Vault load failed: {error}")),
    }
}

#[tauri::command]
pub fn vault_delete_secret(kind: String) -> Result<(), String> {
    let key = resolve_key(&kind)?;
    let entry = entry_for(key)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Vault delete failed: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_key_maps_calendar_credentials_to_a_fixed_key() {
        assert_eq!(
            resolve_key("calendar_credentials").unwrap(),
            "calendar-sync-google-credentials"
        );
    }

    #[test]
    fn resolve_key_rejects_unsupported_kinds() {
        assert!(resolve_key("unknown_kind").is_err());
        assert!(resolve_key("triage_api_key").is_err());
        assert!(resolve_key("provider_credentials").is_err());
    }
}
