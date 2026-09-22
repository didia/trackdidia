//! Single source of truth for "where is the database", shared between `main.rs`
//! (`resolve_storage_paths`, reported to Settings) and `db.rs` (`db_connect`, which opens the
//! live connection). Keeping both call sites on this module prevents them from ever resolving
//! to different files.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// Resolves the app-data directory for the current Tauri app and ensures it exists.
pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Impossible de resoudre le dossier app_data_dir: {error}"))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|error| format!("Impossible de creer le dossier de donnees: {error}"))?;

    Ok(app_data_dir)
}

/// The database file name and environment label, chosen at compile time from the build profile:
/// `trackdidia.dev.db` / "development" in debug builds, `trackdidia.db` / "production" otherwise.
pub fn database_file_name() -> (&'static str, &'static str) {
    if cfg!(debug_assertions) {
        ("trackdidia.dev.db", "development")
    } else {
        ("trackdidia.db", "production")
    }
}

/// Resolves a `sqlite:<file>` connection string to a full path under `app_data_dir`.
pub fn database_path_for(app: &AppHandle, connection_string: &str) -> Result<PathBuf, String> {
    let app_data_dir = app_data_dir(app)?;
    let file_name = connection_string_to_file_name(connection_string);
    Ok(app_data_dir.join(file_name))
}

/// Strips the `sqlite:` prefix from a connection string, returning the bare file name.
/// Falls back to the input unchanged if there is no `:` separator.
fn connection_string_to_file_name(connection_string: &str) -> &str {
    connection_string
        .split_once(':')
        .map(|(_, rest)| rest)
        .unwrap_or(connection_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_string_to_file_name_strips_the_sqlite_prefix() {
        assert_eq!(connection_string_to_file_name("sqlite:trackdidia.db"), "trackdidia.db");
        assert_eq!(connection_string_to_file_name("sqlite:trackdidia.dev.db"), "trackdidia.dev.db");
    }

    #[test]
    fn connection_string_to_file_name_returns_input_unchanged_without_a_prefix() {
        assert_eq!(connection_string_to_file_name("trackdidia.db"), "trackdidia.db");
    }
}
