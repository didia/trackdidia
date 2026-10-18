//! Per-installation device identity for multi-device sync.
//!
//! The id lives in a small file beside the database (same app-data directory, resolved through
//! `storage_paths::app_data_dir`). Production and development builds use different file names so
//! they never share an identity, mirroring `storage_paths::database_file_name`.
//!
//! The file is created once, atomically: the id is written and fsynced to a uniquely named
//! temp file, which is then `hard_link`ed to the final name (a link never replaces an existing
//! file, unlike `rename`). The parent directory is fsynced so the new directory entry is durable,
//! and only then is the temp name removed. The final file is never overwritten. A file that
//! exists but is not a valid id is reported as an error and is NOT regenerated: replacing it
//! would silently orphan this device's identity.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use tauri::AppHandle;

use crate::storage_paths;

const DEVICE_ID_PREFIX: &str = "dev:";
/// `dev:` + a 36-character hyphenated UUID.
const DEVICE_ID_LENGTH: usize = DEVICE_ID_PREFIX.len() + 36;

/// Device id file name, chosen at compile time from the build profile like the database name.
pub fn device_id_file_name() -> &'static str {
    if cfg!(debug_assertions) {
        "device-id.dev"
    } else {
        "device-id"
    }
}

fn is_valid_device_id(value: &str) -> bool {
    if value.len() != DEVICE_ID_LENGTH {
        return false;
    }
    let Some(uuid) = value.strip_prefix(DEVICE_ID_PREFIX) else {
        return false;
    };
    uuid.chars().enumerate().all(|(index, ch)| match index {
        8 | 13 | 18 | 23 => ch == '-',
        14 => ch == '4',
        19 => matches!(ch, '8' | '9' | 'a' | 'b'),
        _ => ch.is_ascii_digit() || ('a'..='f').contains(&ch),
    })
}

fn read_existing(path: &Path) -> Result<String, String> {
    // Bound the read so a huge or binary file is rejected without loading it.
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Impossible de lire l'identifiant d'appareil: {error}"))?;
    if metadata.len() > (DEVICE_ID_LENGTH as u64) + 2 {
        return Err(corrupt_error(path));
    }
    let content = fs::read_to_string(path).map_err(|_| corrupt_error(path))?;
    let trimmed = content.trim_end_matches(['\n', '\r']);
    if is_valid_device_id(trimmed) {
        Ok(trimmed.to_string())
    } else {
        Err(corrupt_error(path))
    }
}

fn corrupt_error(path: &Path) -> String {
    format!(
        "Le fichier d'identifiant d'appareil est invalide ({}). Il n'a pas ete regenere pour ne \
         pas perdre l'identite de cet appareil; corrigez ou deplacez ce fichier manuellement.",
        path.display()
    )
}

/// Flushes `directory`'s entries to disk so a just-created name survives power loss.
///
/// Unix only: `File::open` cannot open a directory on Windows, where there is no equivalent
/// std-level call, so the flush is skipped there (NTFS journals directory metadata).
///
/// Failure is returned, not swallowed. The whole point of the durable ordering is that a crash
/// must not leave us with no name at all and a second device id minted on the next run; if we
/// cannot make the name durable we say so instead of pretending the identity is safe. The final
/// file is left in place (it is valid), so a retry reads that same id rather than minting another.
#[cfg(unix)]
fn sync_directory(directory: &Path) -> std::io::Result<()> {
    fs::File::open(directory)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_directory: &Path) -> std::io::Result<()> {
    Ok(())
}

fn create_new(path: &Path, directory: &Path, file_name: &str) -> Result<String, String> {
    let id = format!("{DEVICE_ID_PREFIX}{}", uuid::Uuid::new_v4());
    // Unique per attempt and opened with `create_new`, so we can never touch a file that
    // another creator (or a crash leftover) already linked to the real name.
    let temp_path = directory.join(format!("{file_name}.{}.tmp", uuid::Uuid::new_v4()));

    let write_result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        file.write_all(id.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        // `hard_link` fails if the destination exists, so a concurrent creator can never be
        // overwritten (unlike `rename`, which replaces silently).
        fs::hard_link(&temp_path, path)
    })();
    // Make the new directory entry durable BEFORE the temp name is unlinked: otherwise a power
    // loss could drop both directory updates and lose the id, minting a second one next run.
    let flush_result = match &write_result {
        Ok(()) => Some(sync_directory(directory)),
        Err(_) => None,
    };
    // Runs on success and on every error path of this attempt; the temp name is ours alone.
    let _ = fs::remove_file(&temp_path);

    match write_result {
        Ok(()) => match flush_result {
            Some(Err(error)) => Err(format!(
                "Impossible de synchroniser le dossier de l'identifiant d'appareil: {error}"
            )),
            _ => Ok(id),
        },
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => read_existing(path),
        Err(error) => Err(format!(
            "Impossible de creer l'identifiant d'appareil: {error}"
        )),
    }
}

/// Reads the id in `directory/file_name`, creating it atomically on first use. An existing file
/// is never overwritten; an invalid one is an error.
pub fn read_or_create_device_id(directory: &Path, file_name: &str) -> Result<String, String> {
    let path = directory.join(file_name);
    match fs::symlink_metadata(&path) {
        Ok(_) => read_existing(&path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            create_new(&path, directory, file_name)
        }
        Err(error) => Err(format!(
            "Impossible de lire l'identifiant d'appareil: {error}"
        )),
    }
}

#[tauri::command]
pub fn sync_device_id(app: AppHandle) -> Result<String, String> {
    let directory = storage_paths::app_data_dir(&app)?;
    read_or_create_device_id(&directory, device_id_file_name())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAME: &str = "device-id.test";

    fn dir_entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn creates_a_valid_id_on_first_call() {
        let dir = tempfile::tempdir().expect("temp dir");
        let id = read_or_create_device_id(dir.path(), NAME).unwrap();
        assert!(is_valid_device_id(&id), "{id}");
        assert!(id.starts_with("dev:"));
        assert_eq!(dir_entries(dir.path()), vec![NAME.to_string()]);
    }

    #[test]
    fn final_file_holds_exactly_the_returned_id_and_no_temp_remains() {
        let dir = tempfile::tempdir().expect("temp dir");
        let id = read_or_create_device_id(dir.path(), NAME).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join(NAME)).unwrap(),
            format!("{id}\n")
        );
        assert!(
            dir_entries(dir.path())
                .iter()
                .all(|name| !name.ends_with(".tmp")),
            "{:?}",
            dir_entries(dir.path())
        );
    }

    #[cfg(unix)]
    #[test]
    fn sync_directory_succeeds_on_a_directory_and_reports_a_missing_one() {
        let dir = tempfile::tempdir().expect("temp dir");
        sync_directory(dir.path()).expect("flush an existing directory");
        let missing = dir.path().join("does-not-exist");
        assert!(sync_directory(&missing).is_err());
    }

    #[test]
    fn is_stable_across_calls() {
        let dir = tempfile::tempdir().expect("temp dir");
        let first = read_or_create_device_id(dir.path(), NAME).unwrap();
        let second = read_or_create_device_id(dir.path(), NAME).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn never_overwrites_an_existing_valid_id() {
        let dir = tempfile::tempdir().expect("temp dir");
        let existing = "dev:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6a";
        fs::write(dir.path().join(NAME), existing).unwrap();
        assert_eq!(
            read_or_create_device_id(dir.path(), NAME).unwrap(),
            existing
        );
        assert_eq!(fs::read_to_string(dir.path().join(NAME)).unwrap(), existing);
    }

    #[test]
    fn rejects_corrupt_content_without_regenerating() {
        let cases: Vec<Vec<u8>> = vec![
            Vec::new(),
            b"\n".to_vec(),
            b"not-an-id".to_vec(),
            b"dev:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6".to_vec(),
            b"dev:0b9c7c1e-6a3f-1b8e-9d2a-1f2e3d4c5b6a".to_vec(),
            b"DEV:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6a".to_vec(),
            vec![b'x'; 4096],
            vec![0xff, 0xfe, 0x00],
        ];
        for content in cases {
            let dir = tempfile::tempdir().expect("temp dir");
            fs::write(dir.path().join(NAME), &content).unwrap();
            let result = read_or_create_device_id(dir.path(), NAME);
            assert!(result.is_err(), "{content:?}");
            assert_eq!(fs::read(dir.path().join(NAME)).unwrap(), content);
            assert_eq!(dir_entries(dir.path()), vec![NAME.to_string()]);
        }
    }

    #[test]
    fn leaves_no_temp_or_partial_files_behind() {
        let dir = tempfile::tempdir().expect("temp dir");
        read_or_create_device_id(dir.path(), NAME).unwrap();
        read_or_create_device_id(dir.path(), NAME).unwrap();
        assert_eq!(dir_entries(dir.path()), vec![NAME.to_string()]);
    }

    #[test]
    fn foreign_leftover_temp_files_are_untouched() {
        let dir = tempfile::tempdir().expect("temp dir");
        let leftover = dir.path().join(format!("{NAME}.tmp"));
        fs::write(&leftover, b"garbage").unwrap();
        let id = read_or_create_device_id(dir.path(), NAME).unwrap();
        assert!(is_valid_device_id(&id));
        assert_eq!(
            fs::read_to_string(dir.path().join(NAME)).unwrap(),
            format!("{id}\n")
        );
        assert_eq!(fs::read(&leftover).unwrap(), b"garbage");
        assert_eq!(
            dir_entries(dir.path()),
            vec![NAME.to_string(), format!("{NAME}.tmp")]
        );
    }

    #[test]
    fn production_and_development_use_different_files() {
        // Exactly one of the two names is compiled in; the other must differ from it.
        assert!(matches!(
            device_id_file_name(),
            "device-id" | "device-id.dev"
        ));
        let dir = tempfile::tempdir().expect("temp dir");
        let prod = read_or_create_device_id(dir.path(), "device-id").unwrap();
        let dev = read_or_create_device_id(dir.path(), "device-id.dev").unwrap();
        assert_ne!(prod, dev);
    }
}
