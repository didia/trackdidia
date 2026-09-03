use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

pub const BACKUP_RETENTION_COUNT: usize = 30;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneResult {
    pub deleted_paths: Vec<String>,
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

pub fn is_backup_file_name(name: &str) -> bool {
    let rest = name
        .strip_prefix("trackdidia-manual-backup-")
        .or_else(|| name.strip_prefix("trackdidia-auto-backup-"));
    matches!(rest, Some(value) if value.ends_with(".db") && value.len() > 3)
}

fn backup_sort_key(name: &str) -> &str {
    name.strip_prefix("trackdidia-manual-backup-")
        .or_else(|| name.strip_prefix("trackdidia-auto-backup-"))
        .and_then(|rest| rest.strip_suffix(".db"))
        .unwrap_or(name)
}

pub fn select_backups_to_prune(names: &[String], keep: usize) -> Vec<String> {
    let mut matching: Vec<String> = names
        .iter()
        .filter(|name| is_backup_file_name(name))
        .cloned()
        .collect();

    matching.sort_by(|left, right| backup_sort_key(right).cmp(backup_sort_key(left)));
    if matching.len() <= keep {
        return Vec::new();
    }

    let mut pruned = matching.split_off(keep);
    pruned.sort_by(|left, right| backup_sort_key(left).cmp(backup_sort_key(right)));
    pruned
}

pub fn ensure_backup_directory(destination_dir: &str, environment: &str) -> Result<String, String> {
    let backup_dir = resolve_backup_dir(destination_dir, environment)?;
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("Impossible de creer le dossier de backups: {error}"))?;
    Ok(backup_dir.to_string_lossy().into_owned())
}

pub fn prune_backup_directory(dir: &Path, keep: usize) -> Result<PruneResult, String> {
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
        names.push(entry.file_name().to_string_lossy().into_owned());
    }

    let to_delete = select_backups_to_prune(&names, keep);
    let mut deleted_paths = Vec::new();
    for name in &to_delete {
        let path = dir.join(name);
        fs::remove_file(&path)
            .map_err(|error| format!("Impossible de supprimer le backup {}: {error}", path.display()))?;
        deleted_paths.push(path.to_string_lossy().into_owned());
    }

    Ok(PruneResult {
        kept_count: names
            .iter()
            .filter(|name| is_backup_file_name(name))
            .count()
            .saturating_sub(deleted_paths.len()),
        deleted_paths,
    })
}

#[tauri::command]
pub fn ensure_backup_dir(destination_dir: String, environment: String) -> Result<String, String> {
    ensure_backup_directory(&destination_dir, &environment)
}

#[tauri::command]
pub fn prune_backups(dir: String, keep: Option<usize>) -> Result<PruneResult, String> {
    prune_backup_directory(Path::new(&dir), keep.unwrap_or(BACKUP_RETENTION_COUNT))
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
}
