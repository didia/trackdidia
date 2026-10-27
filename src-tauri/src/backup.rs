use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

pub const BACKUP_RETENTION_COUNT: usize = 30;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneResult {
    pub deleted_paths: Vec<String>,
    pub failed: Vec<String>,
    pub kept_count: usize,
}

pub fn backup_subdir(environment: &str) -> Result<&'static str, String> {
    match environment {
        "development" => Ok("backups-dev"),
        "production" => Ok("backups"),
        other => Err(format!("Environnement de backup inconnu: {other}")),
    }
}

pub fn resolve_backup_dir(destination_dir: &str, environment: &str) -> Result<PathBuf, String> {
    let trimmed = destination_dir.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return Err("Le dossier de backup n'est pas configure.".to_string());
    }

    Ok(PathBuf::from(trimmed).join(backup_subdir(environment)?))
}

const MANUAL_PREFIX: &str = "trackdidia-manual-backup-";
const AUTO_PREFIX: &str = "trackdidia-auto-backup-";
const DEVICE_TAG_LENGTH: usize = 8;

/// The filename-safe device tag used in per-device backup names: the first eight hex digits of the
/// device id's UUID (`dev:3f1c0b9c-...` -> `3f1c0b9c`). The id is validated first (the exact
/// `device_id` rule), so a tag can never carry a path separator or `..`. Eight digits are 32 random
/// bits: two of a user's laptops colliding is about a one-in-four-billion event, and the only
/// consequence would be that those two share one retention group.
pub fn device_backup_tag(device_id: &str) -> Result<String, String> {
    if !crate::device_id::is_valid_device_id(device_id) {
        return Err("Identifiant d'appareil invalide pour le nom de backup.".to_string());
    }
    let uuid = &device_id["dev:".len()..];
    Ok(uuid[..DEVICE_TAG_LENGTH].to_string())
}

struct ParsedBackupName<'a> {
    /// `None` for the legacy unlabeled form `trackdidia-<kind>-backup-<timestamp>.db`.
    tag: Option<&'a str>,
    /// Sorts chronologically within one tag.
    timestamp: &'a str,
}

/// Recognizes both forms: `trackdidia-(manual|auto)-backup-<timestamp>.db` (legacy) and
/// `trackdidia-(manual|auto)-backup-<tag>-<timestamp>.db` where `<tag>` is eight lowercase hex
/// digits. A legacy timestamp starts with a year (`2026-...`), whose fifth character is `-`, so it
/// can never be read as a tag.
fn parse_backup_file_name(name: &str) -> Option<ParsedBackupName<'_>> {
    let rest = name
        .strip_prefix(MANUAL_PREFIX)
        .or_else(|| name.strip_prefix(AUTO_PREFIX))?;
    let stem = rest.strip_suffix(".db").filter(|value| !value.is_empty())?;
    let bytes = stem.as_bytes();
    let tagged = bytes.len() > DEVICE_TAG_LENGTH + 1
        && bytes[DEVICE_TAG_LENGTH] == b'-'
        && bytes[..DEVICE_TAG_LENGTH]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte));
    if tagged {
        Some(ParsedBackupName {
            tag: Some(&stem[..DEVICE_TAG_LENGTH]),
            timestamp: &stem[DEVICE_TAG_LENGTH + 1..],
        })
    } else {
        Some(ParsedBackupName {
            tag: None,
            timestamp: stem,
        })
    }
}

pub fn is_backup_file_name(name: &str) -> bool {
    parse_backup_file_name(name).is_some()
}

/// Names of the backups in ONE retention group (`tag`: one device, or `None`: the legacy unlabeled
/// files) that exceed `keep`, oldest first. Other groups are never selected.
pub fn select_backups_to_prune_for(
    names: &[String],
    keep: usize,
    tag: Option<&str>,
) -> Vec<String> {
    let mut matching: Vec<(&str, &String)> = names
        .iter()
        .filter_map(|name| {
            let parsed = parse_backup_file_name(name)?;
            (parsed.tag == tag).then_some((parsed.timestamp, name))
        })
        .collect();

    matching.sort_by(|left, right| right.0.cmp(left.0));
    if matching.len() <= keep {
        return Vec::new();
    }

    let mut pruned = matching.split_off(keep);
    pruned.sort_by(|left, right| left.0.cmp(right.0));
    pruned.into_iter().map(|(_, name)| name.clone()).collect()
}

/// The legacy group (files with no device tag), which is all a caller without a device id manages.
/// Production reaches it through `prune_backup_directory`; this selector form is kept for tests.
#[cfg(test)]
pub fn select_backups_to_prune(names: &[String], keep: usize) -> Vec<String> {
    select_backups_to_prune_for(names, keep, None)
}

pub fn ensure_backup_directory(destination_dir: &str, environment: &str) -> Result<String, String> {
    let trimmed = destination_dir.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return Err("Le dossier de backup n'est pas configure.".to_string());
    }

    let root = PathBuf::from(trimmed);
    if !root.is_dir() {
        return Err(format!(
            "Le dossier de backup {} est introuvable. Verifie que Google Drive est monte.",
            root.display()
        ));
    }

    // The shared GTD sync folder must never receive a full-database backup. A destination that is,
    // lies inside, or directly contains a folder carrying a `gtd` role marker is refused before
    // anything is created. (The TypeScript side refuses the same overlap from the settings first.)
    if let Some(marked) = crate::sync_folder::gtd_folder_marker_around(&root) {
        return Err(format!(
            "Le dossier de backup {} chevauche le dossier GTD partage {}: les backups contiennent \
             toute la base et seraient partages. Choisis un autre dossier de backup.",
            root.display(),
            marked.display()
        ));
    }

    let backup_dir = root.join(backup_subdir(environment)?);
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("Impossible de creer le dossier de backups: {error}"))?;
    Ok(backup_dir.to_string_lossy().into_owned())
}

pub fn prune_backup_directory(dir: &Path, keep: usize) -> Result<PruneResult, String> {
    prune_backup_directory_for(dir, keep, None)
}

/// Prunes ONE retention group: the files tagged `tag`, or the legacy unlabeled files for `None`.
/// Files of every other group are never listed for deletion, so one laptop cannot evict another's
/// snapshots from a shared `backups/` folder.
pub fn prune_backup_directory_for(
    dir: &Path,
    keep: usize,
    tag: Option<&str>,
) -> Result<PruneResult, String> {
    let entries = fs::read_dir(dir).map_err(|error| {
        format!(
            "Impossible de lire le dossier de backups {}: {error}",
            dir.display()
        )
    })?;

    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("Impossible de lister un backup: {error}"))?;
        if !entry
            .file_type()
            .map_err(|error| format!("Impossible de lire un backup: {error}"))?
            .is_file()
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_backup_file_name(&name) {
            names.push(name);
        }
    }

    let to_delete = select_backups_to_prune_for(&names, keep, tag);
    let mut deleted_paths = Vec::new();
    let mut failed = Vec::new();
    for name in &to_delete {
        let path = dir.join(name);
        match fs::remove_file(&path) {
            Ok(()) => deleted_paths.push(path.to_string_lossy().into_owned()),
            Err(error) => failed.push(format!("{}: {error}", path.display())),
        }
    }

    Ok(PruneResult {
        kept_count: names
            .iter()
            .filter(|name| parse_backup_file_name(name).is_some_and(|parsed| parsed.tag == tag))
            .count()
            .saturating_sub(deleted_paths.len()),
        deleted_paths,
        failed,
    })
}

#[tauri::command]
pub fn ensure_backup_dir(destination_dir: String, environment: String) -> Result<String, String> {
    ensure_backup_directory(&destination_dir, &environment)
}

/// `device_id` is optional and absent from every current caller. Without it this prunes the legacy
/// unlabeled files exactly as before; with it, only that device's own files (30 per device).
#[tauri::command]
pub fn prune_backups(
    destination_dir: String,
    environment: String,
    device_id: Option<String>,
) -> Result<PruneResult, String> {
    let dir = resolve_backup_dir(&destination_dir, &environment)?;
    let tag = device_id.as_deref().map(device_backup_tag).transpose()?;
    match tag {
        Some(tag) => prune_backup_directory_for(&dir, BACKUP_RETENTION_COUNT, Some(&tag)),
        None => prune_backup_directory(&dir, BACKUP_RETENTION_COUNT),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    #[test]
    fn resolves_environment_subfolders() {
        assert_eq!(
            resolve_backup_dir("/Users/didia/Drive/TrackDidia/", "production").unwrap(),
            PathBuf::from("/Users/didia/Drive/TrackDidia/backups")
        );
        assert_eq!(
            resolve_backup_dir("/Users/didia/Drive/TrackDidia", "development").unwrap(),
            PathBuf::from("/Users/didia/Drive/TrackDidia/backups-dev")
        );
    }

    #[test]
    fn rejects_empty_destination() {
        assert!(resolve_backup_dir("  ", "production").is_err());
    }

    #[test]
    fn matches_only_trackdidia_backup_names() {
        assert!(is_backup_file_name(
            "trackdidia-manual-backup-2026-03-31T10-15-22-456Z.db"
        ));
        assert!(is_backup_file_name(
            "trackdidia-auto-backup-2026-03-31T10-15-22-456Z.db"
        ));
        assert!(!is_backup_file_name("notes.txt"));
        assert!(!is_backup_file_name("trackdidia.db"));
    }

    #[test]
    fn prunes_oldest_matching_files_beyond_retention() {
        let names: Vec<String> = (1..=32)
            .map(|index| {
                let kind = if index % 2 == 0 { "auto" } else { "manual" };
                format!("trackdidia-{kind}-backup-2026-03-{index:02}T10-15-22-456Z.db")
            })
            .chain([
                "notes.txt".to_string(),
                "random.db".to_string(),
                ".DS_Store".to_string(),
            ])
            .collect();

        assert_eq!(
            select_backups_to_prune(&names, 30),
            vec![
                "trackdidia-manual-backup-2026-03-01T10-15-22-456Z.db".to_string(),
                "trackdidia-auto-backup-2026-03-02T10-15-22-456Z.db".to_string(),
            ]
        );
    }

    #[test]
    fn prune_directory_deletes_only_excess_backup_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        for index in 1..=32 {
            let kind = if index % 2 == 0 { "auto" } else { "manual" };
            File::create(dir.path().join(format!(
                "trackdidia-{kind}-backup-2026-03-{index:02}T10-15-22-456Z.db"
            )))
            .expect("create backup");
        }
        File::create(dir.path().join("notes.txt")).expect("create notes");

        let result = prune_backup_directory(dir.path(), 30).expect("prune");
        assert_eq!(result.kept_count, 30);
        assert_eq!(result.deleted_paths.len(), 2);
        assert!(result.failed.is_empty());
        assert!(!dir
            .path()
            .join("trackdidia-manual-backup-2026-03-01T10-15-22-456Z.db")
            .exists());
        assert!(!dir
            .path()
            .join("trackdidia-auto-backup-2026-03-02T10-15-22-456Z.db")
            .exists());
        assert!(dir.path().join("notes.txt").exists());
        assert!(dir
            .path()
            .join("trackdidia-manual-backup-2026-03-31T10-15-22-456Z.db")
            .exists());
    }

    #[test]
    fn ensure_creates_environment_subdir() {
        let dir = tempfile::tempdir().expect("temp dir");
        let created = ensure_backup_directory(dir.path().to_str().unwrap(), "development").unwrap();
        assert!(Path::new(&created).ends_with("backups-dev"));
        assert!(Path::new(&created).is_dir());
    }

    fn write_gtd_marker(dir: &Path) {
        fs::write(
            dir.join(crate::sync_folder::MARKER_FILE_NAME),
            r#"{"role":"gtd","formatVersion":1}"#,
        )
        .expect("marker");
    }

    #[test]
    fn refuses_a_destination_that_is_the_gtd_sync_folder() {
        let dir = tempfile::tempdir().expect("temp dir");
        write_gtd_marker(dir.path());
        let result = ensure_backup_directory(dir.path().to_str().unwrap(), "production");
        assert!(result.is_err());
        assert!(!dir.path().join("backups").exists());
    }

    #[test]
    fn refuses_a_destination_inside_the_gtd_sync_folder() {
        let dir = tempfile::tempdir().expect("temp dir");
        write_gtd_marker(dir.path());
        let inside = dir.path().join("archive");
        fs::create_dir(&inside).expect("inside");
        let result = ensure_backup_directory(inside.to_str().unwrap(), "development");
        assert!(result.is_err());
        assert!(!inside.join("backups-dev").exists());
    }

    #[test]
    fn refuses_a_destination_that_contains_the_gtd_sync_folder() {
        let dir = tempfile::tempdir().expect("temp dir");
        let shared = dir.path().join("GTD");
        fs::create_dir(&shared).expect("shared");
        write_gtd_marker(&shared);
        let result = ensure_backup_directory(dir.path().to_str().unwrap(), "production");
        assert!(result.is_err());
        assert!(!dir.path().join("backups").exists());
    }

    #[test]
    fn accepts_the_personal_folder_and_unrelated_siblings() {
        let dir = tempfile::tempdir().expect("temp dir");
        let shared = dir.path().join("GTD");
        let personal = dir.path().join("Perso");
        fs::create_dir(&shared).expect("shared");
        fs::create_dir(&personal).expect("personal");
        write_gtd_marker(&shared);
        // A personal marker, an unreadable marker and no marker are all fine.
        fs::write(
            personal.join(crate::sync_folder::MARKER_FILE_NAME),
            r#"{"role":"personal","formatVersion":1}"#,
        )
        .expect("personal marker");
        let created = ensure_backup_directory(personal.to_str().unwrap(), "production").unwrap();
        assert!(Path::new(&created).is_dir());
        let junk = dir.path().join("Junk");
        fs::create_dir(&junk).expect("junk");
        fs::write(junk.join(crate::sync_folder::MARKER_FILE_NAME), "not json")
            .expect("junk marker");
        assert!(ensure_backup_directory(junk.to_str().unwrap(), "production").is_ok());
    }

    #[test]
    fn rejects_missing_destination_root() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir
            .path()
            .join("CloudStorage")
            .join("GoogleDrive-me")
            .join("TrackDidia");

        let result = ensure_backup_directory(missing.to_str().unwrap(), "production");
        assert!(result.is_err());
        assert!(!missing.exists());
        assert!(!dir.path().join("CloudStorage").exists());
    }

    #[cfg(unix)]
    #[test]
    fn prune_reports_undeletable_files_and_continues() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        for index in 1..=32 {
            let kind = if index % 2 == 0 { "auto" } else { "manual" };
            File::create(dir.path().join(format!(
                "trackdidia-{kind}-backup-2026-03-{index:02}T10-15-22-456Z.db"
            )))
            .expect("create backup");
        }

        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).expect("lock dir");
        let result = prune_backup_directory(dir.path(), 30);
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).expect("unlock dir");

        let result = result.expect("prune should not fail");
        assert!(result.deleted_paths.is_empty());
        assert_eq!(result.failed.len(), 2);
        assert_eq!(result.kept_count, 32);
        assert!(dir
            .path()
            .join("trackdidia-manual-backup-2026-03-01T10-15-22-456Z.db")
            .exists());
    }

    const DEVICE_A: &str = "dev:3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a";
    const DEVICE_B: &str = "dev:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6a";

    fn tagged(tag: &str, kind: &str, index: u32) -> String {
        format!("trackdidia-{kind}-backup-{tag}-2026-03-{index:02}T10-15-22-456Z.db")
    }

    fn legacy(kind: &str, index: u32) -> String {
        format!("trackdidia-{kind}-backup-2026-03-{index:02}T10-15-22-456Z.db")
    }

    #[test]
    fn device_tag_is_the_first_eight_hex_digits_of_a_valid_id() {
        assert_eq!(device_backup_tag(DEVICE_A).unwrap(), "3f1c0b9c");
        assert_eq!(device_backup_tag(DEVICE_B).unwrap(), "0b9c7c1e");
    }

    #[test]
    fn device_tag_rejects_anything_that_is_not_a_device_id() {
        for bad in [
            "",
            "3f1c0b9c",
            "../../etc/passwd",
            "dev:../../../etc/passwd",
            "dev:3f1c0b9c/../x-6a3f-4b8e-9d2a-1f2e3d4c5b6a",
            "/dev:3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a",
            "DEV:3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a",
            "dev:3f1c0b9c-6a3f-1b8e-9d2a-1f2e3d4c5b6a",
        ] {
            assert!(device_backup_tag(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn recognizes_both_the_legacy_and_the_device_tagged_forms() {
        assert!(is_backup_file_name(&legacy("manual", 1)));
        assert!(is_backup_file_name(&tagged("3f1c0b9c", "auto", 1)));
        assert!(is_backup_file_name(&tagged("3f1c0b9c", "manual", 1)));
        assert!(!is_backup_file_name("trackdidia-auto-backup-3f1c0b9c-2026"));
        assert!(!is_backup_file_name("trackdidia-auto-backup-.db"));
        assert!(!is_backup_file_name(
            "trackdidia-3f1c0b9c-auto-backup-2026.db"
        ));
        assert!(!is_backup_file_name(&format!(
            "{}.txt",
            tagged("3f1c0b9c", "auto", 1)
        )));
    }

    #[test]
    fn a_legacy_timestamp_is_never_read_as_a_device_tag() {
        let name = legacy("auto", 7);
        let parsed = parse_backup_file_name(&name).unwrap();
        assert_eq!(parsed.tag, None);
        assert_eq!(parsed.timestamp, "2026-03-07T10-15-22-456Z");
        let name = tagged("3f1c0b9c", "auto", 7);
        let parsed = parse_backup_file_name(&name).unwrap();
        assert_eq!(parsed.tag, Some("3f1c0b9c"));
        assert_eq!(parsed.timestamp, "2026-03-07T10-15-22-456Z");
    }

    #[test]
    fn each_device_keeps_its_own_thirty_and_never_touches_another_devices_files() {
        let mut names = Vec::new();
        for index in 1..=32 {
            let kind = if index % 2 == 0 { "auto" } else { "manual" };
            names.push(tagged("3f1c0b9c", kind, index));
        }
        for index in 1..=5 {
            names.push(tagged("0b9c7c1e", "auto", index));
        }

        assert_eq!(
            select_backups_to_prune_for(&names, 30, Some("3f1c0b9c")),
            vec![
                tagged("3f1c0b9c", "manual", 1),
                tagged("3f1c0b9c", "auto", 2)
            ]
        );
        // The quiet device has nothing to prune, however chatty the other one is.
        assert!(select_backups_to_prune_for(&names, 30, Some("0b9c7c1e")).is_empty());
        // Even with a tiny cap, a group only ever selects its own files.
        let selected = select_backups_to_prune_for(&names, 2, Some("0b9c7c1e"));
        assert_eq!(selected.len(), 3);
        assert!(selected.iter().all(|name| name.contains("0b9c7c1e")));
    }

    #[test]
    fn legacy_and_tagged_files_form_separate_groups() {
        let mut names: Vec<String> = (1..=31).map(|index| legacy("manual", index)).collect();
        names.extend((1..=31).map(|index| tagged("3f1c0b9c", "auto", index)));

        // A caller without a device id prunes the legacy group only.
        let legacy_pruned = select_backups_to_prune(&names, 30);
        assert_eq!(legacy_pruned, vec![legacy("manual", 1)]);
        // A device prunes its own group only: legacy files are not attributable to it.
        let tagged_pruned = select_backups_to_prune_for(&names, 30, Some("3f1c0b9c"));
        assert_eq!(tagged_pruned, vec![tagged("3f1c0b9c", "auto", 1)]);
    }

    #[test]
    fn tagged_groups_sort_by_timestamp_across_kinds() {
        let names = vec![
            tagged("3f1c0b9c", "auto", 3),
            tagged("3f1c0b9c", "manual", 1),
            tagged("3f1c0b9c", "manual", 2),
            tagged("3f1c0b9c", "auto", 4),
        ];
        assert_eq!(
            select_backups_to_prune_for(&names, 2, Some("3f1c0b9c")),
            vec![
                tagged("3f1c0b9c", "manual", 1),
                tagged("3f1c0b9c", "manual", 2)
            ]
        );
    }

    #[test]
    fn prune_directory_for_a_device_leaves_other_devices_and_legacy_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        for index in 1..=32 {
            File::create(dir.path().join(tagged("3f1c0b9c", "auto", index))).unwrap();
        }
        for index in 1..=32 {
            File::create(dir.path().join(tagged("0b9c7c1e", "auto", index))).unwrap();
        }
        for index in 1..=3 {
            File::create(dir.path().join(legacy("manual", index))).unwrap();
        }
        File::create(dir.path().join("notes.txt")).unwrap();

        let result = prune_backup_directory_for(dir.path(), 30, Some("3f1c0b9c")).unwrap();
        assert_eq!(result.deleted_paths.len(), 2);
        assert_eq!(result.kept_count, 30);
        assert!(result.failed.is_empty());
        assert!(!dir.path().join(tagged("3f1c0b9c", "auto", 1)).exists());
        assert!(dir.path().join(tagged("3f1c0b9c", "auto", 3)).exists());
        // The other device and the legacy files were not touched at all.
        for index in 1..=32 {
            assert!(dir.path().join(tagged("0b9c7c1e", "auto", index)).exists());
        }
        for index in 1..=3 {
            assert!(dir.path().join(legacy("manual", index)).exists());
        }
        assert!(dir.path().join("notes.txt").exists());

        // The legacy caller (no device id) still prunes only the legacy group.
        let legacy_result = prune_backup_directory(dir.path(), 2).unwrap();
        assert_eq!(legacy_result.deleted_paths.len(), 1);
        assert_eq!(legacy_result.kept_count, 2);
        assert!(!dir.path().join(legacy("manual", 1)).exists());
        assert!(dir.path().join(tagged("0b9c7c1e", "auto", 1)).exists());
    }
}
