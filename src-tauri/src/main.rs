#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoragePaths {
  database_path: String,
  backup_dir: String,
}

#[tauri::command]
fn resolve_storage_paths(app: tauri::AppHandle) -> Result<StoragePaths, String> {
  let app_data_dir = app
    .path()
    .app_data_dir()
    .map_err(|error| format!("Impossible de resoudre le dossier app_data_dir: {error}"))?;

  fs::create_dir_all(&app_data_dir)
    .map_err(|error| format!("Impossible de creer le dossier de donnees: {error}"))?;

  let backup_dir = app_data_dir.join("backups");
  fs::create_dir_all(&backup_dir)
    .map_err(|error| format!("Impossible de creer le dossier de backups: {error}"))?;

  let database_path = app_data_dir.join("trackdidia.db");

  Ok(StoragePaths {
    database_path: database_path.to_string_lossy().into_owned(),
    backup_dir: backup_dir.to_string_lossy().into_owned(),
  })
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_sql::Builder::default().build())
    .invoke_handler(tauri::generate_handler![resolve_storage_paths])
    .run(tauri::generate_context!())
    .expect("error while running Trackdidia");
}
