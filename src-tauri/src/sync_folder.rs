//! Folder commands for multi-device sync: the native half of the folder protocol in
//! `specs/todo/multi-laptop-sync.md` ("Folder protocol"), documented as shipped behavior in
//! `docs/storage-and-backups.md` ("Sync folder commands").
//!
//! Rust treats a bundle as OPAQUE BYTES: it never decodes one. It owns paths, folder roles, the
//! atomic publish order, the manifest `domains` entries (file name, generation, size, SHA-256) and
//! verified reads. Everything the webview sends is a configured folder root plus a role, an
//! environment, and a device id validated with the `device_id` rule, so no command can be steered
//! outside `<root>/<sync|sync-dev>/dev-<uuid>/` (the device directory name is the device id with its
//! `dev:` prefix written `dev-`, because `:` is illegal in Windows file names and shown as `/` by
//! Finder; the manifest's `deviceId` keeps the `dev:` form). Like `backup.rs`, the root must already exist: an
//! unmounted Google Drive path is an error, never a local shadow directory.
//!
//! Layout and modules:
//! - `folder`: root validation, the `.trackdidia-folder-role` marker, nested/backup-folder refusal.
//! - `publish`: bundle first, manifest last, per-device lock, generation pruning.
//! - `peers`: listing peers' manifests defensively and verified bundle reads.
//!
//! All blocking file I/O runs on the blocking thread pool under a timeout (Drive "stream files"
//! can block a first read on an online-only file). A timed-out call returns `timeout` to the
//! webview but the thread cannot be interrupted: it keeps running underneath. Publishes are
//! therefore serialized per device directory by a lock held for the whole publish, and a publish
//! that timed out while still WAITING for that lock never starts.

mod folder;
mod peers;
mod publish;

#[cfg(test)]
mod tests;

use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::device_id::is_valid_device_id;

/// The directory carrying a `gtd` role marker that `root` is, lies inside, or directly contains.
/// The backup command refuses such a destination (see `backup::ensure_backup_directory`).
pub fn gtd_folder_marker_around(root: &Path) -> Option<std::path::PathBuf> {
    folder::gtd_marker_around(root)
}

/// A `manifest.json` (and the manifest the webview sends to publish) may not exceed this.
pub const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
/// Largest bundle Rust will store or return. Bundles cross the webview boundary as base64 inside
/// a JSON IPC message: 64 MiB of bundle is ~85 MB of string, and the webview holds the string, the
/// decoded bytes and the parsed change set at once, so peak memory is several times the bundle.
/// Real bundles are far smaller (a GTD bundle is on the order of a megabyte); a bundle over the cap
/// is refused with `too_large` instead of risking the webview.
pub const MAX_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;
/// Largest `.trackdidia-folder-role` marker we will read.
pub const MAX_MARKER_BYTES: u64 = 4 * 1024;
/// Safety bound on directory scans of a folder that Drive may have filled with anything.
pub const MAX_SCANNED_ENTRIES: usize = 2000;
/// Highest generation we will issue (the largest integer a JavaScript number holds exactly).
pub const MAX_GENERATION: u64 = (1 << 53) - 1;

pub const PREPARE_TIMEOUT: Duration = Duration::from_secs(20);
pub const LIST_TIMEOUT: Duration = Duration::from_secs(20);
pub const READ_TIMEOUT: Duration = Duration::from_secs(45);
pub const PUBLISH_TIMEOUT: Duration = Duration::from_secs(45);

pub const MARKER_FILE_NAME: &str = ".trackdidia-folder-role";
pub const MARKER_FORMAT_VERSION: u64 = 1;

/// Error codes the TypeScript wrapper maps (`src/lib/sync/folder-api.ts`).
pub mod code {
    pub const FOLDER_NOT_FOUND: &str = "folder_not_found";
    /// The folder exists but has no role marker yet: `sync_prepare_folder` was not run for it.
    pub const FOLDER_NOT_PREPARED: &str = "folder_not_prepared";
    pub const ROLE_MISMATCH: &str = "role_mismatch";
    pub const NESTED_FOLDER: &str = "nested_folder";
    pub const DOMAIN_NOT_ALLOWED: &str = "domain_not_allowed";
    pub const DEVICE_ID_INVALID: &str = "device_id_invalid";
    pub const TOO_LARGE: &str = "too_large";
    pub const TIMEOUT: &str = "timeout";
    pub const IO: &str = "io";
    /// An unknown role/environment string, an unreadable manifest argument, bad base64.
    pub const INVALID_ARGUMENT: &str = "invalid_argument";
}

/// What a command rejects with: serialized as `{ "code": ..., "message": ... }`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SyncError {
    pub code: &'static str,
    pub message: String,
}

impl SyncError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn io(context: &str, error: &std::io::Error) -> Self {
        Self::new(code::IO, format!("{context}: {error}"))
    }
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

/// The two folder roles. The role, not a path, decides which domains a folder may hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// The shared GTD folder, visible to personal AND work laptops.
    Gtd,
    /// The personal folder (also the backup destination), visible to personal laptops only.
    Personal,
}

impl Role {
    pub fn parse(value: &str) -> Result<Role, SyncError> {
        match value {
            "gtd" => Ok(Role::Gtd),
            "personal" => Ok(Role::Personal),
            other => Err(SyncError::new(
                code::INVALID_ARGUMENT,
                format!("Role de dossier inconnu: {other}"),
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Gtd => "gtd",
            Role::Personal => "personal",
        }
    }

    /// The only domains a folder of this role may ever hold, in either direction.
    pub fn allowed_domains(self) -> &'static [&'static str] {
        match self {
            Role::Gtd => &["gtd"],
            Role::Personal => &["personal", "finance"],
        }
    }

    pub fn allows(self, domain: &str) -> bool {
        self.allowed_domains().contains(&domain)
    }

    pub fn require_domain(self, domain: &str) -> Result<(), SyncError> {
        if self.allows(domain) {
            Ok(())
        } else {
            Err(SyncError::new(
                code::DOMAIN_NOT_ALLOWED,
                format!(
                    "Le domaine {domain} n'est pas autorise dans un dossier de role {}.",
                    self.as_str()
                ),
            ))
        }
    }
}

/// `sync/` in production, `sync-dev/` in development, like `backups` / `backups-dev`.
pub fn sync_subdir(environment: &str) -> Result<&'static str, SyncError> {
    match environment {
        "development" => Ok("sync-dev"),
        "production" => Ok("sync"),
        other => Err(SyncError::new(
            code::INVALID_ARGUMENT,
            format!("Environnement de sync inconnu: {other}"),
        )),
    }
}

/// A valid device id: `dev:` + lowercase UUID v4, so it contains no path separator, no `..`, no
/// uppercase and no whitespace. The on-disk directory name is derived from it by `device_dir_name`
/// (`dev-<uuid>`, filename-safe); the id itself is never used as a path.
pub fn require_device_id(value: &str, what: &str) -> Result<(), SyncError> {
    if is_valid_device_id(value) {
        Ok(())
    } else {
        Err(SyncError::new(
            code::DEVICE_ID_INVALID,
            format!("Identifiant d'appareil invalide ({what})."),
        ))
    }
}

/// The directory a device writes to: its id with `dev:` spelled `dev-` (`dev:<uuid>` ->
/// `dev-<uuid>`). The only place that builds a device directory name. Rejects anything that is not a
/// valid device id, so the name can never carry a separator or `..`.
pub fn device_dir_name(device_id: &str) -> Result<String, SyncError> {
    require_device_id(device_id, "dossier")?;
    Ok(format!("dev-{}", &device_id["dev:".len()..]))
}

/// Inverse of [`device_dir_name`], and strict: exactly `dev-` + a lowercase UUID v4. Any other
/// spelling (a `dev:<uuid>` directory, uppercase, a Drive " (1)" copy, trailing text) is `None`,
/// i.e. not a device directory.
pub fn device_id_from_dir_name(name: &str) -> Option<String> {
    let id = format!("dev:{}", name.strip_prefix("dev-")?);
    is_valid_device_id(&id).then_some(id)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// `<domain>-<generation>.bundle`: the only bundle file name Rust writes or reads.
pub fn bundle_file_name(domain: &str, generation: u64) -> String {
    format!("{domain}-{generation}.bundle")
}

/// Splits `<domain>-<generation>.bundle` (canonical decimal generation, lowercase letters only
/// in the domain). Anything else is not a bundle file of ours.
pub fn parse_bundle_file_name(name: &str) -> Option<(&str, u64)> {
    let stem = name.strip_suffix(".bundle")?;
    let (domain, generation) = stem.rsplit_once('-')?;
    if domain.is_empty() || !domain.bytes().all(|byte| byte.is_ascii_lowercase()) {
        return None;
    }
    let parsed: u64 = generation.parse().ok()?;
    (parsed.to_string() == generation).then_some((domain, parsed))
}

/// One validated `domains.<name>` manifest entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DomainEntry {
    pub generation: u64,
    pub file: String,
    pub sha256: String,
    pub bytes: u64,
    pub rows: u64,
}

impl DomainEntry {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("generation".into(), Value::from(self.generation));
        map.insert("file".into(), Value::from(self.file.clone()));
        map.insert("sha256".into(), Value::from(self.sha256.clone()));
        map.insert("bytes".into(), Value::from(self.bytes));
        map.insert("rows".into(), Value::from(self.rows));
        Value::Object(map)
    }

    /// Accepts an entry only if every field has the exact shape we write, in particular a `file`
    /// that is precisely `<domain>-<generation>.bundle`: a manifest is untrusted input (a peer, a
    /// Drive copy, a hand edit) and the file name in it must never steer a read elsewhere.
    pub fn from_value(domain: &str, value: &Value) -> Option<DomainEntry> {
        let object = value.as_object()?;
        let generation = object.get("generation")?.as_u64()?;
        let file = object.get("file")?.as_str()?;
        let sha256 = object.get("sha256")?.as_str()?;
        let bytes = object.get("bytes")?.as_u64()?;
        let rows = object.get("rows")?.as_u64()?;
        if generation > MAX_GENERATION
            || file != bundle_file_name(domain, generation)
            || !is_sha256_hex(sha256)
        {
            return None;
        }
        Some(DomainEntry {
            generation,
            file: file.to_string(),
            sha256: sha256.to_string(),
            bytes,
            rows,
        })
    }
}

/// Why a file read failed, before any content judgement.
#[derive(Debug)]
pub enum FileReadError {
    Missing,
    /// A symlink, directory, FIFO or device node. Only regular files are ever read: opening a FIFO
    /// would block forever, and a symlink could point outside the folder.
    NotRegular,
    TooLarge,
    Io(std::io::Error),
}

/// Opens `path` for reading WITHOUT following a symlink in its last component, and returns the
/// handle with the metadata of the OPENED file. Checking the path and opening it as two steps is a
/// race (another process can swap a regular file for a symlink in between and the open would follow
/// it outside the folder), so on unix the open itself refuses links (`O_NOFOLLOW`, `ELOOP` becomes
/// `NotRegular`) and never blocks on a FIFO (`O_NONBLOCK`); the type is then judged from the handle
/// (`fstat`), not from the path. Non-unix builds keep the check-then-open order, which is weaker.
/// Only the last component is covered: the directories above it are validated by the callers.
pub fn open_regular_nofollow(path: &Path) -> Result<(fs::File, fs::Metadata), FileReadError> {
    #[cfg(unix)]
    let opened = {
        use std::os::unix::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
    };
    #[cfg(not(unix))]
    let opened = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => return Err(FileReadError::NotRegular),
        Ok(_) => fs::File::open(path),
        Err(error) => Err(error),
    };
    let file = match opened {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(FileReadError::Missing)
        }
        // A symlink in the last component under O_NOFOLLOW.
        #[cfg(unix)]
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            return Err(FileReadError::NotRegular)
        }
        Err(error) => return Err(FileReadError::Io(error)),
    };
    let metadata = file.metadata().map_err(FileReadError::Io)?;
    if !metadata.file_type().is_file() {
        return Err(FileReadError::NotRegular);
    }
    Ok((file, metadata))
}

/// Reads a regular file of at most `cap` bytes (a symlink is refused, not followed; see
/// [`open_regular_nofollow`]).
pub fn read_regular_file_limited(path: &Path, cap: u64) -> Result<Vec<u8>, FileReadError> {
    let (file, metadata) = open_regular_nofollow(path)?;
    if metadata.len() > cap {
        return Err(FileReadError::TooLarge);
    }
    let mut buffer = Vec::with_capacity(metadata.len() as usize);
    // The file can grow between the stat and the read; `take` keeps that bounded too.
    file.take(cap + 1)
        .read_to_end(&mut buffer)
        .map_err(FileReadError::Io)?;
    if buffer.len() as u64 > cap {
        return Err(FileReadError::TooLarge);
    }
    Ok(buffer)
}

/// Replaces `dir/final_name` atomically from the reader's point of view: the bytes are written to
/// `<final_name>.partial`, fsynced, and renamed over the final name. A leftover partial (a crashed
/// publish, or a symlink planted in the folder) is removed first and the new one is created with
/// `create_new`, so the write can never follow a link or append to someone else's file. A
/// `rename` replaces a symlink at the destination instead of following it.
pub fn atomic_write(dir: &Path, final_name: &str, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let partial = dir.join(format!("{final_name}.partial"));
    match fs::remove_file(&partial) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    if let Err(error) = fs::rename(&partial, dir.join(final_name)) {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }
    Ok(())
}

/// Flushes `dir`'s entries so just-renamed names survive power loss. Returned as a WARNING rather
/// than an error: the sync folder lives on a cloud-synced volume where flushing a directory can be
/// unsupported, and failing every publish there would make sync unusable. The safety property does
/// not depend on it: a reader verifies `bytes` and `sha256` and treats a mismatch as "not ready", so
/// a manifest that outlives its bundle after a crash is never applied.
pub fn directory_sync_warning(dir: &Path) -> Option<String> {
    crate::device_id::sync_directory(dir)
        .err()
        .map(|error| format!("directory_sync_failed: {} ({error})", dir.display()))
}

/// Result of [`run_blocking`]. A timeout sets `cancelled` so work still QUEUED behind a lock never
/// starts; work already running cannot be interrupted and finishes underneath.
pub async fn run_blocking<T, F>(timeout: Duration, work: F) -> Result<T, SyncError>
where
    T: Send + 'static,
    F: FnOnce(&AtomicBool) -> Result<T, SyncError> + Send + 'static,
{
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_flag = Arc::clone(&cancelled);
    let handle = tokio::task::spawn_blocking(move || work(&worker_flag));
    match tokio::time::timeout(timeout, handle).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(SyncError::new(
            code::IO,
            format!("L'operation de dossier a echoue: {error}"),
        )),
        Err(_) => {
            cancelled.store(true, Ordering::SeqCst);
            Err(SyncError::new(
                code::TIMEOUT,
                "Le dossier de sync n'a pas repondu a temps (Google Drive est peut-etre hors ligne).",
            ))
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Commands. Each is a thin wrapper: parse the strings, run the testable function off the main
// thread under a timeout. None accepts a path other than the configured folder root.
// ---------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareResult {
    pub sync_dir: String,
    pub role: &'static str,
}

/// Validates the folder root for `role`, writes or verifies its role marker, creates `sync/`
/// (or `sync-dev/`) lazily and returns it. `other_folder_dir` is the OTHER role's configured
/// folder, when there is one, for the nesting check.
#[tauri::command]
pub async fn sync_prepare_folder(
    folder_dir: String,
    role: String,
    environment: String,
    other_folder_dir: Option<String>,
) -> Result<PrepareResult, SyncError> {
    let role = Role::parse(&role)?;
    sync_subdir(&environment)?;
    run_blocking(PREPARE_TIMEOUT, move |cancelled| {
        let context = folder::prepare_folder_cancellable(
            &folder_dir,
            other_folder_dir.as_deref(),
            role,
            &environment,
            cancelled,
        )?;
        Ok(PrepareResult {
            sync_dir: context.sync_dir.to_string_lossy().into_owned(),
            role: role.as_str(),
        })
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub generation: u64,
    pub file: String,
    pub sha256: String,
    pub bytes: u64,
    /// Non-fatal problems: directory flush unsupported, old generations that could not be deleted.
    pub warnings: Vec<String>,
}

/// Writes this device's bundle for `domain` (bytes arrive as base64), then the manifest. Rust
/// chooses the generation (previous + 1) and fills the domain entry; `manifest_json` carries the
/// rest of the manifest and its `deviceId` must equal `device_id`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sync_publish(
    folder_dir: String,
    role: String,
    environment: String,
    device_id: String,
    domain: String,
    bundle_base64: String,
    rows: u64,
    manifest_json: String,
) -> Result<PublishResult, SyncError> {
    let role = Role::parse(&role)?;
    sync_subdir(&environment)?;
    require_device_id(&device_id, "publication")?;
    role.require_domain(&domain)?;
    if bundle_base64.len() as u64 > base64_len_cap(MAX_BUNDLE_BYTES) {
        return Err(SyncError::new(
            code::TOO_LARGE,
            "Le bundle depasse la taille maximale.",
        ));
    }
    run_blocking(PUBLISH_TIMEOUT, move |cancelled| {
        let bundle = BASE64.decode(bundle_base64.as_bytes()).map_err(|error| {
            SyncError::new(
                code::INVALID_ARGUMENT,
                format!("Bundle base64 invalide: {error}"),
            )
        })?;
        let manifest = publish::parse_caller_manifest(&manifest_json)?;
        publish::publish(
            &publish::PublishRequest {
                folder_dir: &folder_dir,
                role,
                environment: &environment,
                device_id: &device_id,
                domain: &domain,
                bundle: &bundle,
                rows,
                manifest,
            },
            cancelled,
        )
        .map(|outcome| PublishResult {
            generation: outcome.entry.generation,
            file: outcome.entry.file,
            sha256: outcome.entry.sha256,
            bytes: outcome.entry.bytes,
            warnings: outcome.warnings,
        })
    })
    .await
}

/// Lists every other device's manifest, plus this device's own (`own`, so a transport can read its
/// own generation without a fifth command). Never fails on a bad entry: it is skipped and reported.
#[tauri::command]
pub async fn sync_list_peers(
    folder_dir: String,
    role: String,
    environment: String,
    own_device_id: String,
) -> Result<peers::ListPeersResult, SyncError> {
    let role = Role::parse(&role)?;
    sync_subdir(&environment)?;
    require_device_id(&own_device_id, "appareil local")?;
    run_blocking(LIST_TIMEOUT, move |_| {
        peers::list_peers(&folder_dir, role, &environment, &own_device_id)
    })
    .await
}

/// Reads one peer's bundle for `domain`. The manifest is read again here and the file name comes
/// from it, never from the webview. A bundle that is missing, short or fails `sha256` is a
/// `notReady` RESULT; only an unreachable folder, a refused request or a timeout is an error.
#[tauri::command]
pub async fn sync_read_bundle(
    folder_dir: String,
    role: String,
    environment: String,
    own_device_id: String,
    peer_device_id: String,
    domain: String,
) -> Result<peers::ReadBundleResult, SyncError> {
    let role = Role::parse(&role)?;
    sync_subdir(&environment)?;
    require_device_id(&own_device_id, "appareil local")?;
    require_device_id(&peer_device_id, "pair")?;
    role.require_domain(&domain)?;
    run_blocking(READ_TIMEOUT, move |_| {
        peers::read_bundle(
            &folder_dir,
            role,
            &environment,
            &own_device_id,
            &peer_device_id,
            &domain,
        )
    })
    .await
}

/// Length of the base64 text of `bytes` raw bytes (with padding).
pub fn base64_len_cap(bytes: u64) -> u64 {
    bytes.div_ceil(3) * 4
}

pub fn encode_base64(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}
