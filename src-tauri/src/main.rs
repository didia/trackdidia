#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;

use serde::Serialize;
use std::fs;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoragePaths {
    database_path: String,
    backup_dir: String,
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
    let (database_file_name, backup_dir_name, environment) = if is_development {
        ("trackdidia.dev.db", "backups-dev", "development")
    } else {
        ("trackdidia.db", "backups", "production")
    };

    let backup_dir = app_data_dir.join(backup_dir_name);
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("Impossible de creer le dossier de backups: {error}"))?;

    let database_path = app_data_dir.join(database_file_name);
    let connection_string = format!("sqlite:{database_file_name}");

    Ok(StoragePaths {
        database_path: database_path.to_string_lossy().into_owned(),
        backup_dir: backup_dir.to_string_lossy().into_owned(),
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
        .manage(db::DbState::default())
        .invoke_handler(tauri::generate_handler![
            resolve_storage_paths,
            rescuetime_http_get,
            db::db_connect,
            db::db_execute,
            db::db_select
        ])
        .run(tauri::generate_context!())
        .expect("error while running Trackdidia");
}
