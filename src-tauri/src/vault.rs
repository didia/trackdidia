use keyring::Entry;
use serde::Serialize;

const VAULT_SERVICE: &str = "trackdidia";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultAvailability {
    pub available: bool,
    pub reason: Option<String>,
}

fn resolve_key(kind: &str, account_id: Option<&str>) -> Result<String, String> {
    match kind {
        "triage_api_key" => Ok("email-triage-openrouter-key".to_string()),
        "provider_credentials" => {
            let account = account_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "account_id required for provider credentials".to_string())?;
            if account.len() > 128
                || account
                    .chars()
                    .any(|ch| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_' && ch != ':')
            {
                return Err("invalid account_id".to_string());
            }
            Ok(format!("email-triage-provider:{account}"))
        }
        "calendar_credentials" => Ok("calendar-sync-google-credentials".to_string()),
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
pub fn vault_store_secret(
    kind: String,
    secret: String,
    account_id: Option<String>,
) -> Result<(), String> {
    let key = resolve_key(&kind, account_id.as_deref())?;
    let entry = entry_for(&key)?;
    entry
        .set_password(&secret)
        .map_err(|error| format!("Vault store failed: {error}"))
}

#[tauri::command]
pub fn vault_load_secret(kind: String, account_id: Option<String>) -> Result<Option<String>, String> {
    let key = resolve_key(&kind, account_id.as_deref())?;
    let entry = entry_for(&key)?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("Vault load failed: {error}")),
    }
}

#[tauri::command]
pub fn vault_delete_secret(kind: String, account_id: Option<String>) -> Result<(), String> {
    let key = resolve_key(&kind, account_id.as_deref())?;
    let entry = entry_for(&key)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Vault delete failed: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_key_maps_the_triage_api_key_kind_to_a_fixed_key() {
        assert_eq!(
            resolve_key("triage_api_key", None).unwrap(),
            "email-triage-openrouter-key"
        );
    }

    #[test]
    fn resolve_key_maps_calendar_credentials_to_a_fixed_key_without_an_account_id() {
        assert_eq!(
            resolve_key("calendar_credentials", None).unwrap(),
            "calendar-sync-google-credentials"
        );
        assert_eq!(
            resolve_key("calendar_credentials", Some("ignored")).unwrap(),
            "calendar-sync-google-credentials"
        );
    }

    #[test]
    fn resolve_key_requires_an_account_id_for_provider_credentials() {
        assert!(resolve_key("provider_credentials", None).is_err());
        assert_eq!(
            resolve_key("provider_credentials", Some("acct-1")).unwrap(),
            "email-triage-provider:acct-1"
        );
    }

    #[test]
    fn resolve_key_rejects_an_invalid_provider_credentials_account_id() {
        assert!(resolve_key("provider_credentials", Some("has spaces")).is_err());
        assert!(resolve_key("provider_credentials", Some("")).is_err());
    }

    #[test]
    fn resolve_key_rejects_an_unsupported_kind() {
        assert!(resolve_key("unknown_kind", None).is_err());
    }
}
