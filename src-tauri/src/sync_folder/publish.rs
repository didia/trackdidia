//! Publishing: bundle file first, manifest last (the commit point), under a per-device lock.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Map, Value};

use super::folder::{ensure_real_dir, open_folder};
use super::peers::{load_manifest, ManifestOutcome};
use super::{
    atomic_write, code, device_dir_name, directory_sync_warning, parse_bundle_file_name,
    require_device_id, sha256_hex, DomainEntry, Role, SyncError, MAX_BUNDLE_BYTES, MAX_GENERATION,
    MAX_MANIFEST_BYTES, MAX_SCANNED_ENTRIES,
};

pub const MANIFEST_FILE_NAME: &str = "manifest.json";

pub struct PublishRequest<'a> {
    pub folder_dir: &'a str,
    pub role: Role,
    pub environment: &'a str,
    pub device_id: &'a str,
    pub domain: &'a str,
    pub bundle: &'a [u8],
    pub rows: u64,
    /// The caller's part of the manifest (everything except `domains`).
    pub manifest: Map<String, Value>,
}

#[derive(Debug)]
pub struct PublishOutcome {
    pub entry: DomainEntry,
    pub warnings: Vec<String>,
}

static PUBLISH_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

/// One lock per device directory (keyed by its canonical path). Held for a whole publish, so a
/// publish that timed out in the webview but is still running underneath cannot interleave with the
/// next one: the next waits here until the first has finished its manifest rename.
fn publish_lock(dir: &Path) -> Arc<Mutex<()>> {
    let registry = PUBLISH_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = registry.lock().unwrap_or_else(|error| error.into_inner());
    Arc::clone(locks.entry(dir.to_path_buf()).or_default())
}

/// Parses the caller's manifest JSON: an object of at most 1 MiB whose `deviceId` is a string.
/// `domains` is discarded: Rust owns every `domains` entry.
pub fn parse_caller_manifest(manifest_json: &str) -> Result<Map<String, Value>, SyncError> {
    if manifest_json.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(SyncError::new(
            code::TOO_LARGE,
            "Le manifest depasse la taille maximale.",
        ));
    }
    match serde_json::from_str::<Value>(manifest_json) {
        Ok(Value::Object(mut map)) => {
            map.remove("domains");
            Ok(map)
        }
        _ => Err(SyncError::new(
            code::INVALID_ARGUMENT,
            "Le manifest doit etre un objet JSON.",
        )),
    }
}

pub fn publish(
    request: &PublishRequest<'_>,
    cancelled: &AtomicBool,
) -> Result<PublishOutcome, SyncError> {
    publish_with_hook(request, cancelled, &mut || Ok(()))
}

/// [`publish`] with a hook that runs after the bundle file is durable and BEFORE the manifest is
/// written. Production passes a no-op; tests use it to observe (and to crash) that exact window.
pub fn publish_with_hook(
    request: &PublishRequest<'_>,
    cancelled: &AtomicBool,
    after_bundle: &mut dyn FnMut() -> Result<(), SyncError>,
) -> Result<PublishOutcome, SyncError> {
    let PublishRequest {
        folder_dir,
        role,
        environment,
        device_id,
        domain,
        bundle,
        rows,
        manifest,
    } = request;
    let (role, rows) = (*role, *rows);

    // Argument checks first: nothing below runs for a request the role or id rules refuse.
    require_device_id(device_id, "publication")?;
    role.require_domain(domain)?;
    match manifest.get("deviceId").and_then(Value::as_str) {
        Some(declared) if declared == *device_id => {}
        _ => {
            return Err(SyncError::new(
                code::DEVICE_ID_INVALID,
                "Le deviceId du manifest ne correspond pas a l'appareil qui publie.",
            ))
        }
    }
    if bundle.len() as u64 > MAX_BUNDLE_BYTES {
        return Err(SyncError::new(
            code::TOO_LARGE,
            "Le bundle depasse la taille maximale.",
        ));
    }

    // The root must exist and carry this role's marker. Nothing is created before this succeeds.
    let context = open_folder(folder_dir, role, environment)?;
    let device_dir = context.sync_dir.join(device_dir_name(device_id)?);

    let lock = publish_lock(&device_dir);
    let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    if cancelled.load(Ordering::SeqCst) {
        return Err(SyncError::new(
            code::TIMEOUT,
            "Publication abandonnee: l'appel a expire avant que le verrou ne soit libre.",
        ));
    }

    ensure_real_dir(&context.sync_dir)?;
    ensure_real_dir(&device_dir)?;

    let mut warnings = Vec::new();
    let mut domains = Map::new();
    // The generation the device's committed manifest names for this domain, if any.
    let mut committed_generation: Option<u64> = None;
    match load_manifest(&device_dir, device_id, role) {
        ManifestOutcome::Valid {
            manifest: previous, ..
        } => {
            if let Some(Value::Object(previous_domains)) = previous.get("domains") {
                for (name, value) in previous_domains {
                    if let Some(entry) = DomainEntry::from_value(name, value) {
                        if name == domain {
                            committed_generation = Some(entry.generation);
                        }
                        domains.insert(name.clone(), entry.to_value());
                    }
                }
            }
        }
        ManifestOutcome::Missing => {}
        // An existing manifest we could not READ must not be replaced: the replacement would hold
        // only this domain's entry and silently drop the other domains' committed entries from
        // discovery. Abort before either file is written; the caller retries.
        ManifestOutcome::Unreadable => {
            return Err(SyncError::new(
                code::IO,
                "Le manifest existant est illisible (erreur d'E/S): publication annulee pour ne \
                 pas ecraser les domaines deja publies. Reessayer.",
            ));
        }
        // Readable but malformed or not ours: recovered by replacing it (with a warning).
        ManifestOutcome::Ignored(reason) => {
            warnings.push(format!("previous_manifest_ignored: {reason}"));
        }
    }
    // A crashed publish can leave a bundle newer than the manifest says. Never reuse its name:
    // a peer may be reading it.
    let mut highest_generation = committed_generation.unwrap_or(0);
    let mut bundle_generations = Vec::new();
    for name in list_file_names(&device_dir)? {
        if let Some((found_domain, found_generation)) = parse_bundle_file_name(&name) {
            if found_domain == *domain {
                highest_generation = highest_generation.max(found_generation);
                bundle_generations.push(found_generation);
            }
        }
    }
    let generation = highest_generation
        .checked_add(1)
        .filter(|value| *value <= MAX_GENERATION);
    let Some(generation) = generation else {
        return Err(SyncError::new(
            code::IO,
            "Le compteur de generation a atteint sa limite.",
        ));
    };

    // Everything that can be refused is built and checked BEFORE the first byte is written, so a
    // refusal (an oversized manifest, say) never leaves an orphan bundle behind. The entry needs
    // only the bundle's bytes, which are already in hand.
    let entry = DomainEntry {
        generation,
        file: super::bundle_file_name(domain, generation),
        sha256: sha256_hex(bundle),
        bytes: bundle.len() as u64,
        rows,
    };
    domains.insert((*domain).to_string(), entry.to_value());
    let mut full = manifest.clone();
    full.insert("domains".to_string(), Value::Object(domains));
    let encoded = serde_json::to_vec_pretty(&Value::Object(full))
        .map_err(|error| SyncError::new(code::IO, format!("Manifest non serialisable: {error}")))?;
    if encoded.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(SyncError::new(
            code::TOO_LARGE,
            "Le manifest depasse la taille maximale.",
        ));
    }

    // 1. The bundle: partial, fsync, rename. Then flush the directory so the bundle's name is
    //    durable BEFORE the manifest that points at it can be.
    atomic_write(&device_dir, &entry.file, bundle)
        .map_err(|error| SyncError::io("Impossible d'ecrire le bundle", &error))?;
    warnings.extend(directory_sync_warning(&device_dir));
    after_bundle()?;

    // 2. The manifest, LAST: this rename is the commit point. The per-domain entry was merged into
    //    the device's existing manifest above, so publishing `finance` keeps an earlier `personal` entry.
    atomic_write(&device_dir, MANIFEST_FILE_NAME, &encoded)
        .map_err(|error| SyncError::io("Impossible d'ecrire le manifest", &error))?;
    warnings.extend(directory_sync_warning(&device_dir));

    // 3. Housekeeping, never fatal. Keep the new generation and the previously COMMITTED one (a
    //    reader mid-download of it must not lose it); when there was none (no manifest, or an
    //    unreadable one) keep the newest older bundle on disk. Orphans from crashed publishes and
    //    every older generation go, as do our own leftover partials.
    let previous_kept = committed_generation.or_else(|| {
        bundle_generations
            .iter()
            .copied()
            .filter(|found| *found < generation)
            .max()
    });
    warnings.extend(prune_generations(
        &device_dir,
        domain,
        generation,
        previous_kept,
    ));

    Ok(PublishOutcome { entry, warnings })
}

/// Names in `dir`, refusing a directory with more than [`MAX_SCANNED_ENTRIES`] entries: a truncated
/// listing could miss a bundle and let a publish reuse its generation.
fn list_file_names(dir: &Path) -> Result<Vec<String>, SyncError> {
    let entries = fs::read_dir(dir)
        .map_err(|error| SyncError::io("Impossible de lister le dossier de l'appareil", &error))?;
    let mut names = Vec::new();
    for entry in entries.flatten() {
        if names.len() >= MAX_SCANNED_ENTRIES {
            return Err(SyncError::new(
                code::IO,
                "Le dossier de l'appareil contient trop de fichiers.",
            ));
        }
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    Ok(names)
}

/// Deletes this domain's bundle files other than `generation` and `previous_kept` (so orphans of
/// crashed publishes and older generations go, the previously committed generation stays) and any
/// leftover `.partial` of ours. Returns warnings for what could not be deleted.
fn prune_generations(
    device_dir: &Path,
    domain: &str,
    generation: u64,
    previous_kept: Option<u64>,
) -> Vec<String> {
    let names = match list_file_names(device_dir) {
        Ok(names) => names,
        Err(error) => return vec![format!("prune_failed: {}", error.message)],
    };
    let mut warnings = Vec::new();
    for name in names {
        let is_stale_bundle = parse_bundle_file_name(&name).is_some_and(|(found_domain, found)| {
            found_domain == domain && found != generation && Some(found) != previous_kept
        });
        let is_partial = name.strip_suffix(".partial").is_some_and(|stem| {
            stem == MANIFEST_FILE_NAME || parse_bundle_file_name(stem).is_some()
        });
        if !(is_stale_bundle || is_partial) {
            continue;
        }
        if let Err(error) = fs::remove_file(device_dir.join(&name)) {
            warnings.push(format!("delete_failed: {name} ({error})"));
        }
    }
    warnings
}
