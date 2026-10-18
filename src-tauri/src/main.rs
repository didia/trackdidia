#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_nap;
mod backup;
mod db;
mod desktop_shell;
mod device_id;
mod llm_bridge;
mod oauth_loopback;
mod pomodoro_alarm;
mod provider_http;
mod storage_paths;
mod vault;

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
        .manage(desktop_shell::DesktopShellState::default())
        .manage(llm_bridge::LlmBridgeState::default())
        .manage(pomodoro_alarm::PomodoroAlarmState::default())
        .setup(|app| {
            desktop_shell::register_close_handler(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            resolve_storage_paths,
            device_id::sync_device_id,
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
            desktop_shell::desktop_set_run_in_tray,
            pomodoro_alarm::pomodoro_alarm_set,
            pomodoro_alarm::pomodoro_alarm_clear,
            llm_bridge::llm_bridge_configure,
            llm_bridge::llm_bridge_respond
        ])
        .run(tauri::generate_context!())
        .expect("error while running Trackdidia");
}
