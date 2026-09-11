#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod db;
mod email_triage_desktop;
mod oauth_loopback;
mod provider_http;
mod vault;
mod yahoo_imap;

use serde::Serialize;
use std::fs;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoragePaths {
    database_path: String,
    connection_string: String,
    environment: String,
}

#[tauri::command]
fn resolve_storage_paths(app: tauri::AppHandle) -> Result<StoragePaths, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Impossible de resoudre le dossier app_data_dir: {error}"))?;

    fs::create_dir_all(&app_data_dir)
        .map_err(|error| format!("Impossible de creer le dossier de donnees: {error}"))?;

    let is_development = cfg!(debug_assertions);
    let (database_file_name, environment) = if is_development {
        ("trackdidia.dev.db", "development")
    } else {
        ("trackdidia.db", "production")
    };

    let database_path = app_data_dir.join(database_file_name);
    let connection_string = format!("sqlite:{database_file_name}");

    Ok(StoragePaths {
        database_path: database_path.to_string_lossy().into_owned(),
        connection_string,
        environment: environment.to_string(),
    })
}

#[tauri::command]
async fn rescuetime_http_get(url: String, api_key: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| format!("RescueTime HTTP client failed: {error}"))?;
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .send()
        .await
        .map_err(|error| format!("RescueTime HTTP request failed: {error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("RescueTime HTTP response unreadable: {error}"))?;

    if !status.is_success() {
        return Err(format!(
            "RescueTime API {}: {}",
            status.as_u16(),
            body.chars().take(200).collect::<String>()
        ));
    }

    Ok(body)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage(db::DbState::default())
        .manage(oauth_loopback::OAuthLoopbackState::default())
        .manage(email_triage_desktop::EmailTriageDesktopState::default())
        .setup(|app| {
            email_triage_desktop::register_close_handler(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            resolve_storage_paths,
            rescuetime_http_get,
            backup::ensure_backup_dir,
            backup::prune_backups,
            db::db_connect,
            db::db_execute,
            db::db_select,
            vault::vault_check_availability,
            vault::vault_store_secret,
            vault::vault_load_secret,
            vault::vault_delete_secret,
            oauth_loopback::oauth_loopback_start,
            oauth_loopback::oauth_loopback_wait,
            provider_http::provider_http_request,
            yahoo_imap::yahoo_imap_discover,
            yahoo_imap::yahoo_imap_fetch_inbox,
            yahoo_imap::yahoo_imap_search_message_id,
            yahoo_imap::yahoo_imap_ensure_mailbox,
            yahoo_imap::yahoo_imap_move_uid,
            yahoo_imap::yahoo_imap_copy_uid,
            yahoo_imap::yahoo_imap_uid_expunge,
            yahoo_imap::yahoo_imap_fetch_uid_message_id,
            email_triage_desktop::email_triage_set_desktop_prefs
        ])
        .run(tauri::generate_context!())
        .expect("error while running Trackdidia");
}
