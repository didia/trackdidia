//! Reading: other devices' manifests (defensively) and verified bundle reads.
//!
//! Everything under `sync/` is untrusted input written by other machines and by Google Drive: a
//! stray file, a "(1)" conflict copy, a manifest copied into the wrong directory, a symlink, a
//! partial upload. None of those is ever an error; they are skipped and reported.

use std::fs;
use std::io::Read;
use std::path::Path;

use serde::Serialize;
use serde_json::{Map, Value};

use super::folder::open_folder;
use super::publish::MANIFEST_FILE_NAME;
use super::{
    code, device_dir_name, device_id_from_dir_name, encode_base64, open_regular_nofollow,
    read_regular_file_limited, require_device_id, sha256_hex, DomainEntry, FileReadError, Role,
    SyncError, MAX_BUNDLE_BYTES, MAX_MANIFEST_BYTES, MAX_SCANNED_ENTRIES,
};

/// Reports beyond this are dropped (a folder full of junk must not produce a huge IPC reply).
const MAX_IGNORED_REPORTED: usize = 100;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct IgnoredEntry {
    /// Relative to the sync directory, e.g. `dev-<uuid>/manifest (1).json`.
    pub path: String,
    pub reason: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ListPeersResult {
    /// Every other device's validated manifest, sorted by device id. `domains` holds only the
    /// entries the role allows and that have the exact shape Rust writes.
    pub peers: Vec<Value>,
    /// This device's own validated manifest, when it has published (its generations).
    pub own: Option<Value>,
    pub ignored: Vec<IgnoredEntry>,
}

#[derive(Serialize, Debug)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ReadBundleResult {
    #[serde(rename_all = "camelCase")]
    Ok {
        bytes_base64: String,
        generation: u64,
        sha256: String,
        bytes: u64,
        rows: u64,
    },
    /// The peer's upload has not finished propagating (or the manifest is unusable). Keep the
    /// previous state and retry on the next trigger.
    #[serde(rename_all = "camelCase")]
    NotReady { reason: String },
}

fn not_ready(reason: &str) -> ReadBundleResult {
    ReadBundleResult::NotReady {
        reason: reason.to_string(),
    }
}

/// Result of loading one `<deviceId>/manifest.json`.
#[derive(Debug)]
pub enum ManifestOutcome {
    /// No manifest file (a peer mid first publish): not worth reporting.
    Missing,
    /// The manifest exists but could not be read (an I/O failure). Distinct from [`Self::Ignored`]
    /// (readable but malformed or untrustworthy): this one is transient, so a reader reports it as
    /// retryable and the publisher must NOT replace the manifest it could not read.
    Unreadable,
    Ignored(&'static str),
    Valid {
        manifest: Map<String, Value>,
        /// Domain entries dropped from `manifest.domains`: `(domain, reason)`.
        removed: Vec<(String, &'static str)>,
    },
}

/// Loads and validates `dir/manifest.json` for `expected_device_id`. A manifest whose `deviceId`
/// differs from its directory name is ignored (a copy claiming to be another device). `domains`
/// entries the role does not allow, or that are malformed, are removed and reported.
pub fn load_manifest(dir: &Path, expected_device_id: &str, role: Role) -> ManifestOutcome {
    let bytes = match read_regular_file_limited(&dir.join(MANIFEST_FILE_NAME), MAX_MANIFEST_BYTES) {
        Ok(bytes) => bytes,
        Err(FileReadError::Missing) => return ManifestOutcome::Missing,
        Err(FileReadError::NotRegular) => return ManifestOutcome::Ignored("not_regular_file"),
        Err(FileReadError::TooLarge) => return ManifestOutcome::Ignored("manifest_too_large"),
        // Not corrupt, just not readable right now (permissions, a Drive download failing, EIO).
        Err(FileReadError::Io(_)) => return ManifestOutcome::Unreadable,
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return ManifestOutcome::Ignored("manifest_invalid_json");
    };
    let Value::Object(mut manifest) = value else {
        return ManifestOutcome::Ignored("manifest_not_object");
    };
    if manifest.get("deviceId").and_then(Value::as_str) != Some(expected_device_id) {
        return ManifestOutcome::Ignored("device_id_mismatch");
    }
    let Some(Value::Object(raw_domains)) = manifest.remove("domains") else {
        return ManifestOutcome::Ignored("domains_invalid");
    };
    let mut kept = Map::new();
    let mut removed = Vec::new();
    for (name, value) in raw_domains {
        if !role.allows(&name) {
            removed.push((name, "domain_not_allowed"));
        } else if let Some(entry) = DomainEntry::from_value(&name, &value) {
            kept.insert(name, entry.to_value());
        } else {
            removed.push((name, "invalid_domain_entry"));
        }
    }
    manifest.insert("domains".to_string(), Value::Object(kept));
    ManifestOutcome::Valid { manifest, removed }
}

struct Ignored {
    entries: Vec<IgnoredEntry>,
}

impl Ignored {
    fn push(&mut self, path: impl Into<String>, reason: impl Into<String>) {
        if self.entries.len() < MAX_IGNORED_REPORTED {
            self.entries.push(IgnoredEntry {
                path: path.into(),
                reason: reason.into(),
            });
        }
    }
}

/// `true` for `manifest (1).json`, `manifest 2.json`, `manifest.json (1)`... but not for the real
/// `manifest.json` nor the in-flight `manifest.json.partial`.
fn is_manifest_conflict_copy(name: &str) -> bool {
    name.starts_with("manifest") && name != MANIFEST_FILE_NAME && name != "manifest.json.partial"
}

pub fn list_peers(
    folder_dir: &str,
    role: Role,
    environment: &str,
    own_device_id: &str,
) -> Result<ListPeersResult, SyncError> {
    require_device_id(own_device_id, "appareil local")?;
    let context = open_folder(folder_dir, role, environment)?;

    let mut result = ListPeersResult {
        peers: Vec::new(),
        own: None,
        ignored: Vec::new(),
    };
    let mut ignored = Ignored {
        entries: Vec::new(),
    };

    match fs::symlink_metadata(&context.sync_dir) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        // Nobody has published yet.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Ok(_) => {
            return Err(SyncError::new(
                code::IO,
                "Le dossier sync n'est pas un dossier ordinaire.",
            ))
        }
        Err(error) => return Err(SyncError::io("Impossible de lire le dossier sync", &error)),
    }

    let listing = fs::read_dir(&context.sync_dir)
        .map_err(|error| SyncError::io("Impossible de lister le dossier sync", &error))?;
    let mut entries: Vec<(String, bool)> = Vec::new();
    for (index, entry) in listing.enumerate() {
        if index >= MAX_SCANNED_ENTRIES {
            ignored.push("", "too_many_entries");
            break;
        }
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_real_dir = entry
            .file_type()
            .map(|file_type| file_type.is_dir())
            .unwrap_or(false);
        entries.push((name, is_real_dir));
    }
    entries.sort();

    for (name, is_real_dir) in entries {
        if name.starts_with('.') {
            continue;
        }
        // Strict: exactly `dev-<uuid v4>`. A `dev:<uuid>` directory (never shipped), a Drive
        // "(1)" copy or any other spelling is not a device directory.
        let Some(device_id) = device_id_from_dir_name(&name) else {
            ignored.push(&name, "invalid_device_directory");
            continue;
        };
        if !is_real_dir {
            ignored.push(&name, "not_a_directory");
            continue;
        }
        let device_dir = context.sync_dir.join(&name);
        if let Ok(files) = fs::read_dir(&device_dir) {
            for file in files.take(MAX_SCANNED_ENTRIES).flatten() {
                let file_name = file.file_name().to_string_lossy().into_owned();
                if is_manifest_conflict_copy(&file_name) {
                    ignored.push(format!("{name}/{file_name}"), "conflict_copy");
                }
            }
        }
        let is_own = device_id == own_device_id;
        // The manifest's `deviceId` must be the id this directory name maps to.
        match load_manifest(&device_dir, &device_id, role) {
            ManifestOutcome::Missing => {}
            // Retryable: the next listing reads it again (unlike the malformed reasons).
            ManifestOutcome::Unreadable => {
                ignored.push(
                    format!("{name}/{MANIFEST_FILE_NAME}"),
                    "manifest_unreadable",
                );
            }
            ManifestOutcome::Ignored(reason) => {
                ignored.push(format!("{name}/{MANIFEST_FILE_NAME}"), reason);
            }
            ManifestOutcome::Valid { manifest, removed } => {
                for (domain, reason) in removed {
                    ignored.push(
                        format!("{name}/{MANIFEST_FILE_NAME}#domains.{domain}"),
                        reason,
                    );
                }
                if is_own {
                    result.own = Some(Value::Object(manifest));
                } else {
                    result.peers.push(Value::Object(manifest));
                }
            }
        }
    }
    result.ignored = ignored.entries;
    Ok(result)
}

fn real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_dir())
        .unwrap_or(false)
}

/// Reads and verifies one peer's bundle. The file name comes from the peer's manifest, which is
/// read here, and must be exactly `<domain>-<generation>.bundle`; the file must be a regular file
/// inside the peer's own directory (symlinks are refused outright: the file is opened without following
/// a link and judged from the opened handle, see `open_regular_nofollow`), its size must equal the manifest's `bytes` and its SHA-256 the manifest's `sha256`.
pub fn read_bundle(
    folder_dir: &str,
    role: Role,
    environment: &str,
    own_device_id: &str,
    peer_device_id: &str,
    domain: &str,
) -> Result<ReadBundleResult, SyncError> {
    require_device_id(own_device_id, "appareil local")?;
    require_device_id(peer_device_id, "pair")?;
    if peer_device_id == own_device_id {
        return Err(SyncError::new(
            code::DEVICE_ID_INVALID,
            "Un appareil ne lit pas son propre bundle.",
        ));
    }
    role.require_domain(domain)?;
    let context = open_folder(folder_dir, role, environment)?;

    let peer_dir_name = device_dir_name(peer_device_id)?;
    let peer_dir = context.sync_dir.join(&peer_dir_name);
    if !real_dir(&context.sync_dir) || !real_dir(&peer_dir) {
        return Ok(not_ready("peer_directory_missing"));
    }
    // Containment: the peer directory must really be a direct child of the sync directory.
    let (Ok(canonical_sync), Ok(canonical_peer)) =
        (context.sync_dir.canonicalize(), peer_dir.canonicalize())
    else {
        return Ok(not_ready("peer_directory_missing"));
    };
    if canonical_peer.parent() != Some(canonical_sync.as_path())
        || canonical_peer.file_name().and_then(|name| name.to_str()) != Some(peer_dir_name.as_str())
    {
        return Ok(not_ready("peer_directory_outside_sync_dir"));
    }

    let manifest = match load_manifest(&peer_dir, peer_device_id, role) {
        ManifestOutcome::Valid { manifest, .. } => manifest,
        ManifestOutcome::Missing => return Ok(not_ready("manifest_missing")),
        ManifestOutcome::Unreadable => return Ok(not_ready("manifest_unreadable")),
        ManifestOutcome::Ignored(reason) => return Ok(not_ready(reason)),
    };
    let entry = manifest
        .get("domains")
        .and_then(Value::as_object)
        .and_then(|domains| domains.get(domain))
        .and_then(|value| DomainEntry::from_value(domain, value));
    let Some(entry) = entry else {
        return Ok(not_ready("domain_missing"));
    };
    if entry.bytes > MAX_BUNDLE_BYTES {
        return Err(SyncError::new(
            code::TOO_LARGE,
            "Le bundle du pair depasse la taille maximale.",
        ));
    }

    let bundle_path = canonical_peer.join(&entry.file);
    // One open decides everything: no symlink is followed, and the type and size come from the
    // opened handle, so a swap after a path check cannot redirect the read.
    let (file, metadata) = match open_regular_nofollow(&bundle_path) {
        Ok(opened) => opened,
        Err(FileReadError::Missing) => return Ok(not_ready("file_missing")),
        Err(FileReadError::NotRegular) => return Ok(not_ready("file_not_regular")),
        Err(FileReadError::TooLarge) => return Ok(not_ready("size_mismatch")),
        Err(FileReadError::Io(error)) => {
            return Err(SyncError::io("Impossible d'ouvrir le bundle", &error))
        }
    };
    if metadata.len() != entry.bytes {
        return Ok(not_ready("size_mismatch"));
    }
    // `bytes + 1` so a file that grew after the stat is a size mismatch, not a silent truncation.
    let mut buffer = Vec::with_capacity(entry.bytes as usize);
    file.take(entry.bytes + 1)
        .read_to_end(&mut buffer)
        .map_err(|error| SyncError::io("Impossible de lire le bundle", &error))?;
    if buffer.len() as u64 != entry.bytes {
        return Ok(not_ready("size_mismatch"));
    }
    if sha256_hex(&buffer) != entry.sha256 {
        return Ok(not_ready("hash_mismatch"));
    }
    Ok(ReadBundleResult::Ok {
        bytes_base64: encode_base64(&buffer),
        generation: entry.generation,
        sha256: entry.sha256,
        bytes: entry.bytes,
        rows: entry.rows,
    })
}
