#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod db;
mod email_triage_desktop;
mod llm_bridge;
mod oauth_loopback;
mod provider_http;
mod storage_paths;
mod vault;
mod yahoo_imap;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoragePaths {
    database_path: String,
    connection_string: String,
    environment: String,
}

#[tauri::command]
fn resolve_storage_paths(app: tauri::AppHandle) -> Result<StoragePaths, String> {
    let app_data_dir = storage_paths::app_data_dir(&app)?;
    let (database_file_name, environment) = storage_paths::database_file_name();

    let database_path = app_data_dir.join(database_file_name);
    let connection_string = format!("sqlite:{database_file_name}");

    Ok(StoragePaths {
        database_path: database_path.to_string_lossy().into_owned(),
        connection_string,
        environment: environment.to_string(),
    })
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
        .manage(llm_bridge::LlmBridgeState::default())
        .setup(|app| {
            email_triage_desktop::register_close_handler(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            resolve_storage_paths,
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
            email_triage_desktop::email_triage_set_desktop_prefs,
            llm_bridge::llm_bridge_configure,
            llm_bridge::llm_bridge_respond
        ])
        .run(tauri::generate_context!())
        .expect("error while running Trackdidia");
}
