//! Folder roots: existence, the `.trackdidia-folder-role` marker, and the refusals that keep the
//! shared GTD folder and the personal (backup) folder apart.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};

use super::{
    atomic_write, code, directory_sync_warning, read_regular_file_limited, sync_subdir,
    FileReadError, Role, SyncError, MARKER_FILE_NAME, MARKER_FORMAT_VERSION, MAX_MARKER_BYTES,
    MAX_SCANNED_ENTRIES,
};

/// A validated folder: the sync directory beneath the canonical root (it may not exist yet). Every
/// path a command touches is built from `sync_dir` and a validated device id.
#[derive(Debug, Clone)]
pub struct FolderContext {
    pub sync_dir: PathBuf,
}

/// Serializes `prepare_folder` so two role markers can never race for one directory.
static PREPARE_LOCK: Mutex<()> = Mutex::new(());

/// Test hook: occupy the prepare lock to queue another prepare behind it.
#[cfg(test)]
pub fn lock_prepare_for_test() -> std::sync::MutexGuard<'static, ()> {
    PREPARE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

/// The configured root must already exist. Never creates anything: an unmounted Google Drive path
/// is an error, not a local shadow directory. The returned path is canonical (a `~/Google Drive`
/// symlink is followed once, here), so locks and containment checks compare real paths.
pub fn resolve_root(folder_dir: &str) -> Result<PathBuf, SyncError> {
    let trimmed = folder_dir.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return Err(SyncError::new(
            code::FOLDER_NOT_FOUND,
            "Le dossier de sync n'est pas configure.",
        ));
    }
    let root = PathBuf::from(trimmed);
    if !root.is_dir() {
        return Err(SyncError::new(
            code::FOLDER_NOT_FOUND,
            format!(
                "Le dossier de sync {} est introuvable. Verifie que Google Drive est monte.",
                root.display()
            ),
        ));
    }
    root.canonicalize()
        .map_err(|error| SyncError::io("Impossible de resoudre le dossier de sync", &error))
}

fn parse_marker(bytes: &[u8]) -> Option<Role> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    match value.get("role")?.as_str()? {
        "gtd" => Some(Role::Gtd),
        "personal" => Some(Role::Personal),
        _ => None,
    }
}

/// `Ok(None)` when there is no marker. A marker that is unreadable, not a regular file, too large
/// or does not name a known role is `role_mismatch`: it is never overwritten, because it may be
/// another role's marker we cannot interpret, and the user can delete it by hand.
fn read_marker(dir: &Path) -> Result<Option<Role>, SyncError> {
    match read_regular_file_limited(&dir.join(MARKER_FILE_NAME), MAX_MARKER_BYTES) {
        Ok(bytes) => parse_marker(&bytes)
            .map(Some)
            .ok_or_else(|| marker_invalid(dir)),
        Err(FileReadError::Missing) => Ok(None),
        Err(FileReadError::NotRegular | FileReadError::TooLarge) => Err(marker_invalid(dir)),
        Err(FileReadError::Io(error)) => Err(SyncError::io(
            "Impossible de lire le marqueur de role du dossier",
            &error,
        )),
    }
}

fn marker_invalid(dir: &Path) -> SyncError {
    SyncError::new(
        code::ROLE_MISMATCH,
        format!(
            "Le marqueur de role de {} est illisible ou inconnu. Il n'a pas ete modifie; \
             supprimez-le manuellement si ce dossier est bien celui a utiliser.",
            dir.display()
        ),
    )
}

/// Best-effort marker lookup in a neighbouring directory (ancestor or child). Anything unreadable
/// counts as "no marker": those directories are not ours to judge.
fn read_marker_lenient(dir: &Path) -> Option<Role> {
    read_regular_file_limited(&dir.join(MARKER_FILE_NAME), MAX_MARKER_BYTES)
        .ok()
        .and_then(|bytes| parse_marker(&bytes))
}

/// A folder holding the full-database backups is the personal folder; it must never be shared.
fn looks_like_personal_folder(root: &Path) -> bool {
    ["backups", "backups-dev"]
        .iter()
        .any(|name| fs::symlink_metadata(root.join(name)).is_ok())
}

fn refuse_backup_folder_as_gtd(root: &Path) -> Result<(), SyncError> {
    if looks_like_personal_folder(root) {
        return Err(SyncError::new(
            code::ROLE_MISMATCH,
            format!(
                "{} contient un dossier backups/: c'est le dossier personnel (copies completes de \
                 la base). Il ne peut pas servir de dossier GTD partage.",
                root.display()
            ),
        ));
    }
    Ok(())
}

fn role_mismatch(root: &Path, found: Role, wanted: Role) -> SyncError {
    SyncError::new(
        code::ROLE_MISMATCH,
        format!(
            "Le dossier {} est deja marque comme dossier {}; il ne peut pas servir de dossier {}.",
            root.display(),
            found.as_str(),
            wanted.as_str()
        ),
    )
}

/// A configured folder for a command other than prepare. Read-only: nothing is created. The root
/// must exist and carry THIS role's marker (a missing marker means the folder was never prepared,
/// so a transport reports it as unreachable instead of writing into an unchecked folder), and a
/// GTD folder is re-checked for backups so a later choice of backup destination cannot silently
/// turn the shared folder into the personal one.
pub fn open_folder(
    folder_dir: &str,
    role: Role,
    environment: &str,
) -> Result<FolderContext, SyncError> {
    let sync_name = sync_subdir(environment)?;
    let root = resolve_root(folder_dir)?;
    match read_marker(&root)? {
        Some(found) if found == role => {}
        Some(found) => return Err(role_mismatch(&root, found, role)),
        None => {
            return Err(SyncError::new(
                code::FOLDER_NOT_PREPARED,
                format!(
                    "Le dossier {} n'a pas de marqueur de role: il n'a pas ete prepare.",
                    root.display()
                ),
            ))
        }
    }
    if role == Role::Gtd {
        refuse_backup_folder_as_gtd(&root)?;
    }
    Ok(FolderContext {
        sync_dir: root.join(sync_name),
    })
}

/// Canonical form when the path exists, the raw path otherwise (the other folder may be an
/// unmounted drive right now; a lexical comparison still catches the common mistakes).
fn comparable(path: &str) -> Option<PathBuf> {
    let trimmed = path.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return None;
    }
    let raw = PathBuf::from(trimmed);
    Some(raw.canonicalize().unwrap_or(raw))
}

fn refuse_nesting(
    root: &Path,
    role: Role,
    other_folder_dir: Option<&str>,
) -> Result<(), SyncError> {
    let nested = |detail: String| SyncError::new(code::NESTED_FOLDER, detail);

    if let Some(other) = other_folder_dir.and_then(comparable) {
        if other.starts_with(root) || root.starts_with(&other) {
            return Err(nested(format!(
                "Le dossier GTD et le dossier personnel ne peuvent pas etre le meme dossier ni \
                 etre imbriques ({} et {}).",
                root.display(),
                other.display()
            )));
        }
    }

    for ancestor in root.ancestors().skip(1) {
        if let Some(found) = read_marker_lenient(ancestor) {
            if found != role {
                return Err(nested(format!(
                    "{} est a l'interieur du dossier {} {}.",
                    root.display(),
                    found.as_str(),
                    ancestor.display()
                )));
            }
        }
    }

    // One level of descendants: a folder of the other role directly beneath this one.
    let children = fs::read_dir(root)
        .map_err(|error| SyncError::io("Impossible de lister le dossier de sync", &error))?;
    for child in children.take(MAX_SCANNED_ENTRIES).flatten() {
        let is_real_dir = child
            .file_type()
            .map(|file_type| file_type.is_dir())
            .unwrap_or(false);
        if !is_real_dir {
            continue;
        }
        if let Some(found) = read_marker_lenient(&child.path()) {
            if found != role {
                return Err(nested(format!(
                    "Le dossier {} {} se trouve a l'interieur de {}.",
                    found.as_str(),
                    child.path().display(),
                    root.display()
                )));
            }
        }
    }
    Ok(())
}

/// Creates `dir` as a real directory if it is missing; refuses a symlink (it could point anywhere)
/// and a non-directory. The parent must already exist: nothing here ever creates a parent chain.
pub fn ensure_real_dir(dir: &Path) -> Result<(), SyncError> {
    match fs::symlink_metadata(dir) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(SyncError::new(
            code::IO,
            format!(
                "{} n'est pas un dossier ordinaire (lien symbolique ou fichier).",
                dir.display()
            ),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(dir)
            .or_else(|error| {
                // A concurrent creator (another process) is fine.
                if error.kind() == std::io::ErrorKind::AlreadyExists && dir.is_dir() {
                    Ok(())
                } else {
                    Err(error)
                }
            })
            .map_err(|error| SyncError::io("Impossible de creer le dossier de sync", &error)),
        Err(error) => Err(SyncError::io(
            "Impossible de lire le dossier de sync",
            &error,
        )),
    }
}

/// Configuration-time entry point. Validates the root for `role`, refuses a folder of the other
/// role, a GTD folder that looks like the personal one, and nested folders; then writes the marker
/// (never over an existing one) and creates the sync directory. Nothing is written before every
/// refusal has been checked.
#[cfg(test)]
pub fn prepare_folder(
    folder_dir: &str,
    other_folder_dir: Option<&str>,
    role: Role,
    environment: &str,
) -> Result<FolderContext, SyncError> {
    prepare_folder_cancellable(
        folder_dir,
        other_folder_dir,
        role,
        environment,
        &AtomicBool::new(false),
    )
}

/// [`prepare_folder`] for the command: `cancelled` is set when the caller timed out. A prepare that
/// was only QUEUED behind the prepare lock then returns `timeout` without writing a marker or
/// creating the sync directory (the caller was told it failed, so it must not half-succeed later).
pub fn prepare_folder_cancellable(
    folder_dir: &str,
    other_folder_dir: Option<&str>,
    role: Role,
    environment: &str,
    cancelled: &AtomicBool,
) -> Result<FolderContext, SyncError> {
    let sync_name = sync_subdir(environment)?;
    let _guard = PREPARE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if cancelled.load(Ordering::SeqCst) {
        return Err(SyncError::new(
            code::TIMEOUT,
            "Preparation abandonnee: l'appel a expire avant que le verrou ne soit libre.",
        ));
    }
    let root = resolve_root(folder_dir)?;

    let existing = read_marker(&root)?;
    if let Some(found) = existing {
        if found != role {
            return Err(role_mismatch(&root, found, role));
        }
    }
    if role == Role::Gtd {
        refuse_backup_folder_as_gtd(&root)?;
    }
    refuse_nesting(&root, role, other_folder_dir)?;

    if existing.is_none() {
        let marker = json!({ "role": role.as_str(), "formatVersion": MARKER_FORMAT_VERSION });
        let bytes = serde_json::to_vec_pretty(&marker).unwrap_or_default();
        atomic_write(&root, MARKER_FILE_NAME, &bytes)
            .map_err(|error| SyncError::io("Impossible d'ecrire le marqueur de role", &error))?;
        // Informational only: a directory flush that is unsupported here must not block setup.
        let _ = directory_sync_warning(&root);
    }

    let sync_dir = root.join(sync_name);
    ensure_real_dir(&sync_dir)?;
    Ok(FolderContext { sync_dir })
}
