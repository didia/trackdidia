use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde_json::{json, Map, Value};
use tempfile::TempDir;

use super::folder::{open_folder, prepare_folder, prepare_folder_cancellable};
use super::peers::{list_peers, load_manifest, read_bundle, ManifestOutcome, ReadBundleResult};
use super::publish::{
    parse_caller_manifest, publish, publish_with_hook, PublishOutcome, PublishRequest,
};
use super::*;

const A: &str = "dev:3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a";
const B: &str = "dev:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6a";
const C: &str = "dev:9d2a1f2e-6a3f-4b8e-9d2a-1f2e3d4c5b6a";
const PROD: &str = "production";
const DEV: &str = "development";

fn text(path: &Path) -> &str {
    path.to_str().unwrap()
}

struct Fixture {
    _tmp: TempDir,
    root: PathBuf,
}

impl Fixture {
    /// An empty, existing folder that has NOT been prepared.
    fn bare() -> Fixture {
        let tmp = tempfile::tempdir().expect("temp dir");
        let root = tmp.path().join("folder");
        fs::create_dir(&root).unwrap();
        Fixture { _tmp: tmp, root }
    }

    /// A folder prepared for `role` in production.
    fn prepared(role: Role) -> Fixture {
        let fixture = Fixture::bare();
        prepare_folder(text(&fixture.root), None, role, PROD).expect("prepare");
        fixture
    }

    fn dir(&self) -> &str {
        text(&self.root)
    }

    fn canonical(&self) -> PathBuf {
        self.root.canonicalize().unwrap()
    }

    fn sync_dir(&self) -> PathBuf {
        self.canonical().join("sync")
    }

    fn device_dir(&self, id: &str) -> PathBuf {
        self.sync_dir().join(dn(id))
    }
}

/// The directory name of a device id (`dev:<uuid>` -> `dev-<uuid>`).
fn dn(id: &str) -> String {
    device_dir_name(id).unwrap()
}

fn manifest_for(id: &str) -> Map<String, Value> {
    json!({
        "formatVersion": 1,
        "deviceId": id,
        "deviceName": "Test laptop",
        "appVersion": "0.0.0",
        "schemaVersion": 42,
        "writtenAt": "2026-10-14T13:02:11.482Z",
        "hlcHigh": "0000",
        "profile": "personal",
        "calendarSyncEnabled": false
    })
    .as_object()
    .unwrap()
    .clone()
}

fn request<'a>(
    folder_dir: &'a str,
    role: Role,
    environment: &'a str,
    device_id: &'a str,
    domain: &'a str,
    bundle: &'a [u8],
) -> PublishRequest<'a> {
    PublishRequest {
        folder_dir,
        role,
        environment,
        device_id,
        domain,
        bundle,
        rows: 3,
        manifest: manifest_for(device_id),
    }
}

fn put(
    fixture: &Fixture,
    role: Role,
    id: &str,
    domain: &str,
    bundle: &[u8],
) -> Result<PublishOutcome, SyncError> {
    publish(
        &request(fixture.dir(), role, PROD, id, domain, bundle),
        &AtomicBool::new(false),
    )
}

fn read_ok(result: ReadBundleResult) -> Vec<u8> {
    match result {
        ReadBundleResult::Ok { bytes_base64, .. } => {
            base64::Engine::decode(&BASE64, bytes_base64).unwrap()
        }
        ReadBundleResult::NotReady { reason } => panic!("not ready: {reason}"),
    }
}

fn read_reason(result: ReadBundleResult) -> String {
    match result {
        ReadBundleResult::NotReady { reason } => reason,
        ReadBundleResult::Ok { .. } => panic!("expected notReady"),
    }
}

fn read_peer(
    fixture: &Fixture,
    role: Role,
    own: &str,
    peer: &str,
    domain: &str,
) -> ReadBundleResult {
    read_bundle(fixture.dir(), role, PROD, own, peer, domain).expect("read")
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn manifest_json(fixture: &Fixture, id: &str) -> Value {
    serde_json::from_slice(&fs::read(fixture.device_dir(id).join("manifest.json")).unwrap())
        .unwrap()
}

fn write_manifest(fixture: &Fixture, id: &str, value: &Value) {
    let dir = fixture.device_dir(id);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec(value).unwrap(),
    )
    .unwrap();
}

// ---------------------------------------------------------------------------------------------
// Helpers: names, entries, errors
// ---------------------------------------------------------------------------------------------

#[test]
fn bundle_file_names_round_trip_and_reject_lookalikes() {
    assert_eq!(bundle_file_name("gtd", 17), "gtd-17.bundle");
    assert_eq!(parse_bundle_file_name("gtd-17.bundle"), Some(("gtd", 17)));
    assert_eq!(
        parse_bundle_file_name("finance-3.bundle"),
        Some(("finance", 3))
    );
    for bad in [
        "gtd-017.bundle",
        "gtd-.bundle",
        "-3.bundle",
        "gtd-3.bundle.partial",
        "gtd-3.BUNDLE",
        "GTD-3.bundle",
        "../gtd-3.bundle",
        "gtd-3-4.bundle",
        "gtd-x.bundle",
    ] {
        assert_eq!(parse_bundle_file_name(bad), None, "{bad}");
    }
}

#[test]
fn a_domain_entry_must_name_exactly_its_own_bundle_file() {
    let sha = "a".repeat(64);
    let good =
        json!({"generation": 4, "file": "gtd-4.bundle", "sha256": sha, "bytes": 9, "rows": 2});
    assert!(DomainEntry::from_value("gtd", &good).is_some());
    for (field, bad) in [
        ("file", json!("../../etc/passwd")),
        ("file", json!("gtd-5.bundle")),
        ("file", json!("personal-4.bundle")),
        ("file", json!("/etc/passwd")),
        ("sha256", json!("A".repeat(64))),
        ("sha256", json!("abc")),
        ("generation", json!(-1)),
        ("generation", json!(1.5)),
        ("bytes", json!("9")),
        ("rows", Value::Null),
    ] {
        let mut value = good.clone();
        value[field] = bad.clone();
        assert!(
            DomainEntry::from_value("gtd", &value).is_none(),
            "{field}={bad}"
        );
    }
}

#[test]
fn errors_and_results_serialize_to_the_shapes_the_wrapper_reads() {
    let error = SyncError::new(code::FOLDER_NOT_FOUND, "no");
    assert_eq!(
        serde_json::to_value(&error).unwrap(),
        json!({"code": "folder_not_found", "message": "no"})
    );
    let ok = serde_json::to_value(ReadBundleResult::Ok {
        bytes_base64: "AA==".into(),
        generation: 2,
        sha256: "ab".into(),
        bytes: 1,
        rows: 5,
    })
    .unwrap();
    assert_eq!(
        ok,
        json!({"status": "ok", "bytesBase64": "AA==", "generation": 2, "sha256": "ab", "bytes": 1, "rows": 5})
    );
    let pending = serde_json::to_value(ReadBundleResult::NotReady {
        reason: "hash_mismatch".into(),
    })
    .unwrap();
    assert_eq!(
        pending,
        json!({"status": "notReady", "reason": "hash_mismatch"})
    );
}

// ---------------------------------------------------------------------------------------------
// Roots and markers
// ---------------------------------------------------------------------------------------------

#[test]
fn prepare_writes_the_marker_and_creates_the_environment_sync_directory() {
    let production = Fixture::bare();
    let context = prepare_folder(production.dir(), None, Role::Gtd, PROD).unwrap();
    assert_eq!(context.sync_dir, production.canonical().join("sync"));
    assert!(context.sync_dir.is_dir());
    let marker: Value =
        serde_json::from_slice(&fs::read(production.root.join(MARKER_FILE_NAME)).unwrap()).unwrap();
    assert_eq!(marker, json!({"role": "gtd", "formatVersion": 1}));

    let development = Fixture::bare();
    let context = prepare_folder(development.dir(), None, Role::Personal, DEV).unwrap();
    assert_eq!(context.sync_dir, development.canonical().join("sync-dev"));
    assert!(!development.root.join("sync").exists());
    assert_eq!(
        names_in(&development.root),
        vec![MARKER_FILE_NAME.to_string(), "sync-dev".to_string()]
    );
}

#[test]
fn prepare_is_idempotent_and_never_rewrites_a_matching_marker() {
    let fixture = Fixture::prepared(Role::Personal);
    let before = fs::read(fixture.root.join(MARKER_FILE_NAME)).unwrap();
    prepare_folder(fixture.dir(), None, Role::Personal, PROD).unwrap();
    prepare_folder(fixture.dir(), None, Role::Personal, DEV).unwrap();
    assert_eq!(
        fs::read(fixture.root.join(MARKER_FILE_NAME)).unwrap(),
        before
    );
    // Production and development share the marker and differ only by the sync directory.
    assert!(fixture.root.join("sync").is_dir());
    assert!(fixture.root.join("sync-dev").is_dir());
    assert!(names_in(&fixture.root)
        .iter()
        .all(|name| !name.ends_with(".partial")));
}

#[test]
fn an_unknown_environment_is_refused() {
    let fixture = Fixture::bare();
    let error = prepare_folder(fixture.dir(), None, Role::Gtd, "staging").unwrap_err();
    assert_eq!(error.code, code::INVALID_ARGUMENT);
    assert!(names_in(&fixture.root).is_empty());
    assert_eq!(
        Role::parse("work").unwrap_err().code,
        code::INVALID_ARGUMENT
    );
}

#[test]
fn a_missing_root_is_an_error_and_nothing_is_created_by_any_command() {
    let tmp = tempfile::tempdir().unwrap();
    let missing = tmp
        .path()
        .join("CloudStorage")
        .join("GoogleDrive-me")
        .join("TrackDidia");
    let dir = text(&missing);

    assert_eq!(
        prepare_folder(dir, None, Role::Gtd, PROD).unwrap_err().code,
        code::FOLDER_NOT_FOUND
    );
    assert_eq!(
        open_folder(dir, Role::Gtd, PROD).unwrap_err().code,
        code::FOLDER_NOT_FOUND
    );
    assert_eq!(
        put_at(dir, Role::Gtd, A, "gtd", b"x").unwrap_err().code,
        code::FOLDER_NOT_FOUND
    );
    assert_eq!(
        list_peers(dir, Role::Gtd, PROD, A).unwrap_err().code,
        code::FOLDER_NOT_FOUND
    );
    assert_eq!(
        read_bundle(dir, Role::Gtd, PROD, A, B, "gtd")
            .unwrap_err()
            .code,
        code::FOLDER_NOT_FOUND
    );
    assert!(!missing.exists());
    assert!(!tmp.path().join("CloudStorage").exists());
    assert!(names_in(tmp.path()).is_empty());
}

fn put_at(
    dir: &str,
    role: Role,
    id: &str,
    domain: &str,
    bundle: &[u8],
) -> Result<PublishOutcome, SyncError> {
    publish(
        &request(dir, role, PROD, id, domain, bundle),
        &AtomicBool::new(false),
    )
}

#[test]
fn a_root_that_is_a_file_or_blank_is_folder_not_found() {
    let fixture = Fixture::bare();
    let file = fixture.root.join("not-a-dir");
    fs::write(&file, b"x").unwrap();
    for dir in [text(&file), "", "   "] {
        assert_eq!(
            prepare_folder(dir, None, Role::Gtd, PROD).unwrap_err().code,
            code::FOLDER_NOT_FOUND,
            "{dir:?}"
        );
    }
}

#[test]
fn a_folder_with_the_other_roles_marker_is_refused_everywhere() {
    let personal = Fixture::prepared(Role::Personal);
    let before = names_in(&personal.root);

    assert_eq!(
        prepare_folder(personal.dir(), None, Role::Gtd, PROD)
            .unwrap_err()
            .code,
        code::ROLE_MISMATCH
    );
    assert_eq!(
        open_folder(personal.dir(), Role::Gtd, PROD)
            .unwrap_err()
            .code,
        code::ROLE_MISMATCH
    );
    assert_eq!(
        put(&personal, Role::Gtd, A, "gtd", b"x").unwrap_err().code,
        code::ROLE_MISMATCH
    );
    assert_eq!(
        list_peers(personal.dir(), Role::Gtd, PROD, A)
            .unwrap_err()
            .code,
        code::ROLE_MISMATCH
    );
    assert_eq!(
        read_bundle(personal.dir(), Role::Gtd, PROD, A, B, "gtd")
            .unwrap_err()
            .code,
        code::ROLE_MISMATCH
    );
    assert_eq!(names_in(&personal.root), before);

    let gtd = Fixture::prepared(Role::Gtd);
    assert_eq!(
        prepare_folder(gtd.dir(), None, Role::Personal, PROD)
            .unwrap_err()
            .code,
        code::ROLE_MISMATCH
    );
}

#[test]
fn a_gtd_folder_that_holds_backups_is_refused_and_left_untouched() {
    for name in ["backups", "backups-dev"] {
        let fixture = Fixture::bare();
        fs::create_dir(fixture.root.join(name)).unwrap();
        fs::write(
            fixture.root.join(name).join("trackdidia-auto-backup-x.db"),
            b"db",
        )
        .unwrap();
        let error = prepare_folder(fixture.dir(), None, Role::Gtd, PROD).unwrap_err();
        assert_eq!(error.code, code::ROLE_MISMATCH, "{name}");
        assert_eq!(names_in(&fixture.root), vec![name.to_string()], "{name}");

        // The same folder is the right place for the personal role.
        prepare_folder(fixture.dir(), None, Role::Personal, PROD).unwrap();
    }
}

#[test]
fn a_gtd_folder_that_later_gains_backups_stops_working() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, A, "gtd", b"bundle").unwrap();
    fs::create_dir(fixture.root.join("backups")).unwrap();
    assert_eq!(
        put(&fixture, Role::Gtd, A, "gtd", b"again")
            .unwrap_err()
            .code,
        code::ROLE_MISMATCH
    );
    assert_eq!(
        list_peers(fixture.dir(), Role::Gtd, PROD, B)
            .unwrap_err()
            .code,
        code::ROLE_MISMATCH
    );
}

#[test]
fn a_folder_that_was_never_prepared_is_refused_by_the_other_commands() {
    let fixture = Fixture::bare();
    assert_eq!(
        put(&fixture, Role::Gtd, A, "gtd", b"x").unwrap_err().code,
        code::FOLDER_NOT_PREPARED
    );
    assert_eq!(
        list_peers(fixture.dir(), Role::Gtd, PROD, A)
            .unwrap_err()
            .code,
        code::FOLDER_NOT_PREPARED
    );
    assert_eq!(
        read_bundle(fixture.dir(), Role::Gtd, PROD, A, B, "gtd")
            .unwrap_err()
            .code,
        code::FOLDER_NOT_PREPARED
    );
    assert!(names_in(&fixture.root).is_empty());
}

#[test]
fn an_unreadable_marker_is_refused_and_never_overwritten() {
    for content in [&b"not json"[..], b"{\"role\":\"work\"}", b"{}", b"[]", b""] {
        let fixture = Fixture::bare();
        fs::write(fixture.root.join(MARKER_FILE_NAME), content).unwrap();
        let error = prepare_folder(fixture.dir(), None, Role::Gtd, PROD).unwrap_err();
        assert_eq!(error.code, code::ROLE_MISMATCH, "{content:?}");
        assert_eq!(
            fs::read(fixture.root.join(MARKER_FILE_NAME)).unwrap(),
            content
        );
        assert_eq!(names_in(&fixture.root), vec![MARKER_FILE_NAME.to_string()]);
    }
    let fixture = Fixture::bare();
    fs::write(fixture.root.join(MARKER_FILE_NAME), vec![b' '; 5000]).unwrap();
    assert_eq!(
        prepare_folder(fixture.dir(), None, Role::Gtd, PROD)
            .unwrap_err()
            .code,
        code::ROLE_MISMATCH
    );
}

#[test]
fn nested_folders_are_refused_by_marker_in_either_direction() {
    // GTD folder inside the personal folder.
    let personal = Fixture::prepared(Role::Personal);
    let inside = personal.root.join("shared").join("gtd");
    fs::create_dir_all(&inside).unwrap();
    let error = prepare_folder(text(&inside), None, Role::Gtd, PROD).unwrap_err();
    assert_eq!(error.code, code::NESTED_FOLDER);
    assert!(names_in(&inside).is_empty());

    // Personal folder inside a GTD folder.
    let gtd = Fixture::prepared(Role::Gtd);
    let inside = gtd.root.join("mine");
    fs::create_dir(&inside).unwrap();
    assert_eq!(
        prepare_folder(text(&inside), None, Role::Personal, PROD)
            .unwrap_err()
            .code,
        code::NESTED_FOLDER
    );
    assert!(names_in(&inside).is_empty());

    // A GTD folder that CONTAINS a prepared personal folder (one level down).
    let outer = Fixture::bare();
    let child = outer.root.join("personal");
    fs::create_dir(&child).unwrap();
    prepare_folder(text(&child), None, Role::Personal, PROD).unwrap();
    assert_eq!(
        prepare_folder(outer.dir(), None, Role::Gtd, PROD)
            .unwrap_err()
            .code,
        code::NESTED_FOLDER
    );
    assert_eq!(names_in(&outer.root), vec!["personal".to_string()]);
}

#[test]
fn nesting_is_also_detected_from_the_other_configured_folder_path() {
    let tmp = tempfile::tempdir().unwrap();
    let outer = tmp.path().join("outer");
    let inner = outer.join("inner");
    let unrelated = tmp.path().join("unrelated");
    fs::create_dir_all(&inner).unwrap();
    fs::create_dir(&unrelated).unwrap();

    for (folder, other) in [(&inner, &outer), (&outer, &inner), (&outer, &outer)] {
        let error = prepare_folder(text(folder), Some(text(other)), Role::Gtd, PROD).unwrap_err();
        assert_eq!(error.code, code::NESTED_FOLDER);
        assert!(!folder.join(MARKER_FILE_NAME).exists());
        assert!(!folder.join("sync").exists());
    }
    // A sibling is fine, and so is an other folder that does not exist right now (unmounted).
    prepare_folder(text(&inner), Some(text(&unrelated)), Role::Gtd, PROD).unwrap();
    let gone = tmp.path().join("gone").join("Drive");
    prepare_folder(text(&unrelated), Some(text(&gone)), Role::Personal, PROD).unwrap();
    assert!(!tmp.path().join("gone").exists());
    // ...but an unmounted other folder that lexically contains this one is still caught.
    let lexical_inner = tmp.path().join("sibling");
    fs::create_dir(&lexical_inner).unwrap();
    let error = prepare_folder(
        text(&lexical_inner),
        Some(text(tmp.path())),
        Role::Gtd,
        PROD,
    )
    .unwrap_err();
    assert_eq!(error.code, code::NESTED_FOLDER);
}

#[test]
fn a_symlinked_root_is_followed_once_and_everything_lands_in_the_real_folder() {
    #[cfg(unix)]
    {
        let fixture = Fixture::bare();
        let link = fixture._tmp.path().join("Google Drive");
        std::os::unix::fs::symlink(&fixture.root, &link).unwrap();
        prepare_folder(text(&link), None, Role::Gtd, PROD).unwrap();
        put_at(text(&link), Role::Gtd, A, "gtd", b"bundle").unwrap();
        assert!(fixture.device_dir(A).join("gtd-1.bundle").is_file());
    }
}

// ---------------------------------------------------------------------------------------------
// Device id and path discipline
// ---------------------------------------------------------------------------------------------

#[test]
fn device_ids_that_could_traverse_are_refused_and_nothing_is_written() {
    let fixture = Fixture::prepared(Role::Gtd);
    let before = names_in(&fixture.root);
    let outside = fixture._tmp.path().to_path_buf();
    let outside_before = names_in(&outside);

    for bad in [
        "../x",
        "..",
        "/etc",
        "dev:../../x",
        "dev:3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a/..",
        "dev:3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a/x",
        "dev:3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a\\x",
        "DEV:3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a",
        "dev:3F1C0B9C-6A3F-4B8E-9D2A-1F2E3D4C5B6A",
        "dev:3f1c0b9c-6a3f-1b8e-9d2a-1f2e3d4c5b6a",
        " dev:3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a",
        "",
    ] {
        let error = put(&fixture, Role::Gtd, bad, "gtd", b"x").unwrap_err();
        assert_eq!(error.code, code::DEVICE_ID_INVALID, "publish {bad:?}");
        assert_eq!(
            list_peers(fixture.dir(), Role::Gtd, PROD, bad)
                .unwrap_err()
                .code,
            code::DEVICE_ID_INVALID,
            "list {bad:?}"
        );
        assert_eq!(
            read_bundle(fixture.dir(), Role::Gtd, PROD, A, bad, "gtd")
                .unwrap_err()
                .code,
            code::DEVICE_ID_INVALID,
            "read {bad:?}"
        );
        assert_eq!(
            read_bundle(fixture.dir(), Role::Gtd, PROD, bad, B, "gtd")
                .unwrap_err()
                .code,
            code::DEVICE_ID_INVALID,
            "read own {bad:?}"
        );
    }
    assert_eq!(names_in(&fixture.root), before);
    assert_eq!(names_in(&outside), outside_before);
    assert!(names_in(&fixture.sync_dir()).is_empty());
}

#[test]
fn a_device_never_reads_its_own_bundle_through_the_peer_path() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, A, "gtd", b"mine").unwrap();
    assert_eq!(
        read_bundle(fixture.dir(), Role::Gtd, PROD, A, A, "gtd")
            .unwrap_err()
            .code,
        code::DEVICE_ID_INVALID
    );
}

#[test]
fn development_and_production_use_separate_directories() {
    let fixture = Fixture::bare();
    prepare_folder(fixture.dir(), None, Role::Gtd, PROD).unwrap();
    prepare_folder(fixture.dir(), None, Role::Gtd, DEV).unwrap();

    publish(
        &request(fixture.dir(), Role::Gtd, DEV, A, "gtd", b"dev-bundle"),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(fixture
        .canonical()
        .join("sync-dev")
        .join(dn(A))
        .join("gtd-1.bundle")
        .is_file());
    assert!(!fixture.canonical().join("sync").join(dn(A)).exists());

    publish(
        &request(fixture.dir(), Role::Gtd, PROD, B, "gtd", b"prod-bundle"),
        &AtomicBool::new(false),
    )
    .unwrap();
    // A production reader never sees the development writer, and vice versa.
    assert!(
        list_peers(fixture.dir(), Role::Gtd, PROD, C)
            .unwrap()
            .peers
            .len()
            == 1
    );
    let prod_peers = list_peers(fixture.dir(), Role::Gtd, PROD, C).unwrap();
    assert_eq!(prod_peers.peers[0]["deviceId"], B);
    let dev_peers = list_peers(fixture.dir(), Role::Gtd, DEV, C).unwrap();
    assert_eq!(dev_peers.peers.len(), 1);
    assert_eq!(dev_peers.peers[0]["deviceId"], A);
}

#[cfg(unix)]
#[test]
fn a_symlinked_peer_directory_is_not_followed() {
    let fixture = Fixture::prepared(Role::Gtd);
    let elsewhere = fixture._tmp.path().join("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    let sha = sha256_hex(b"secret");
    fs::write(elsewhere.join("gtd-1.bundle"), b"secret").unwrap();
    fs::write(
        elsewhere.join("manifest.json"),
        serde_json::to_vec(&json!({
            "deviceId": B,
            "domains": {"gtd": {"generation": 1, "file": "gtd-1.bundle", "sha256": sha, "bytes": 6, "rows": 1}}
        }))
        .unwrap(),
    )
    .unwrap();
    fs::create_dir_all(fixture.sync_dir()).unwrap();
    std::os::unix::fs::symlink(&elsewhere, fixture.device_dir(B)).unwrap();

    let listing = list_peers(fixture.dir(), Role::Gtd, PROD, A).unwrap();
    assert!(listing.peers.is_empty());
    assert!(listing
        .ignored
        .iter()
        .any(|entry| entry.path == dn(B) && entry.reason == "not_a_directory"));
    assert_eq!(
        read_reason(read_peer(&fixture, Role::Gtd, A, B, "gtd")),
        "peer_directory_missing"
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_bundle_or_manifest_inside_a_peer_directory_is_not_followed() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, B, "gtd", b"real bundle").unwrap();
    let outside = fixture._tmp.path().join("outside.bin");
    fs::write(&outside, b"real bundle").unwrap();
    let bundle = fixture.device_dir(B).join("gtd-1.bundle");
    fs::remove_file(&bundle).unwrap();
    std::os::unix::fs::symlink(&outside, &bundle).unwrap();
    assert_eq!(
        read_reason(read_peer(&fixture, Role::Gtd, A, B, "gtd")),
        "file_not_regular"
    );

    let manifest = fixture.device_dir(B).join("manifest.json");
    let saved = fs::read(&manifest).unwrap();
    fs::remove_file(&manifest).unwrap();
    let target = fixture._tmp.path().join("manifest-elsewhere.json");
    fs::write(&target, saved).unwrap();
    std::os::unix::fs::symlink(&target, &manifest).unwrap();
    let listing = list_peers(fixture.dir(), Role::Gtd, PROD, A).unwrap();
    assert!(listing.peers.is_empty());
    assert!(listing
        .ignored
        .iter()
        .any(|entry| entry.reason == "not_regular_file"));
}

#[cfg(unix)]
#[test]
fn publishing_into_a_symlinked_device_directory_is_refused_and_writes_nothing_there() {
    let fixture = Fixture::prepared(Role::Gtd);
    let elsewhere = fixture._tmp.path().join("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    fs::create_dir_all(fixture.sync_dir()).unwrap();
    std::os::unix::fs::symlink(&elsewhere, fixture.device_dir(A)).unwrap();
    let error = put(&fixture, Role::Gtd, A, "gtd", b"x").unwrap_err();
    assert_eq!(error.code, code::IO);
    assert!(names_in(&elsewhere).is_empty());
}

#[cfg(unix)]
#[test]
fn a_planted_partial_symlink_is_replaced_not_followed() {
    let dir = tempfile::tempdir().unwrap();
    let victim = dir.path().join("victim.txt");
    fs::write(&victim, b"precious").unwrap();
    std::os::unix::fs::symlink(&victim, dir.path().join("gtd-1.bundle.partial")).unwrap();
    atomic_write(dir.path(), "gtd-1.bundle", b"new").unwrap();
    assert_eq!(fs::read(&victim).unwrap(), b"precious");
    assert_eq!(fs::read(dir.path().join("gtd-1.bundle")).unwrap(), b"new");
    assert!(!dir.path().join("gtd-1.bundle.partial").exists());
}

/// Runs `work` on its own thread and fails the test (instead of hanging it) if it does not finish.
/// A regression that opens a FIFO blocks forever; the leaked thread dies with the test process.
fn finishes_within<T: Send + 'static>(
    seconds: u64,
    work: impl FnOnce() -> T + Send + 'static,
) -> T {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(work());
    });
    receiver
        .recv_timeout(Duration::from_secs(seconds))
        .unwrap_or_else(|_| panic!("blocked for more than {seconds}s (a FIFO was opened?)"))
}

#[cfg(unix)]
fn make_fifo(path: &Path) -> bool {
    matches!(
        std::process::Command::new("mkfifo").arg(path).status(),
        Ok(status) if status.success()
    )
}

#[cfg(unix)]
#[test]
fn a_fifo_in_place_of_a_bundle_cannot_hang_a_reader() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, B, "gtd", b"bundle").unwrap();
    let bundle = fixture.device_dir(B).join("gtd-1.bundle");
    fs::remove_file(&bundle).unwrap();
    if !make_fifo(&bundle) {
        return; // no mkfifo on this machine
    }
    let dir = fixture.dir().to_string();
    let result = finishes_within(5, move || {
        read_bundle(&dir, Role::Gtd, PROD, A, B, "gtd").unwrap()
    });
    assert_eq!(read_reason(result), "file_not_regular");
}

#[cfg(unix)]
#[test]
fn a_fifo_in_place_of_a_manifest_cannot_hang_list_or_read() {
    let fixture = Fixture::prepared(Role::Gtd);
    let dir = fixture.device_dir(B);
    fs::create_dir(&dir).unwrap();
    if !make_fifo(&dir.join("manifest.json")) {
        return;
    }
    let folder = fixture.dir().to_string();
    let listing = finishes_within(5, move || list_peers(&folder, Role::Gtd, PROD, A).unwrap());
    assert!(listing.peers.is_empty());
    assert!(listing
        .ignored
        .iter()
        .any(|entry| entry.reason == "not_regular_file"));
    let folder = fixture.dir().to_string();
    let result = finishes_within(5, move || {
        read_bundle(&folder, Role::Gtd, PROD, A, B, "gtd").unwrap()
    });
    assert_eq!(read_reason(result), "not_regular_file");
}

// ---------------------------------------------------------------------------------------------
// Roles and domains
// ---------------------------------------------------------------------------------------------

#[test]
fn the_role_domain_matrix_is_enforced_before_anything_is_written() {
    let cases = [
        (Role::Gtd, "gtd", true),
        (Role::Gtd, "personal", false),
        (Role::Gtd, "finance", false),
        (Role::Personal, "gtd", false),
        (Role::Personal, "personal", true),
        (Role::Personal, "finance", true),
    ];
    for (role, domain, allowed) in cases {
        let fixture = Fixture::prepared(role);
        let result = put(&fixture, role, A, domain, b"bundle");
        if allowed {
            let outcome = result.unwrap_or_else(|error| panic!("{role:?}/{domain}: {error}"));
            assert_eq!(outcome.entry.file, format!("{domain}-1.bundle"));
        } else {
            assert_eq!(
                result.unwrap_err().code,
                code::DOMAIN_NOT_ALLOWED,
                "{role:?}/{domain}"
            );
            assert!(
                names_in(&fixture.sync_dir()).is_empty(),
                "{role:?}/{domain}"
            );
            assert_eq!(
                read_bundle(fixture.dir(), role, PROD, A, B, domain)
                    .unwrap_err()
                    .code,
                code::DOMAIN_NOT_ALLOWED
            );
        }
    }
    for bad in ["", "GTD", "../gtd", "gtd/..", "calendar", "gtd "] {
        let fixture = Fixture::prepared(Role::Gtd);
        assert_eq!(
            put(&fixture, Role::Gtd, A, bad, b"x").unwrap_err().code,
            code::DOMAIN_NOT_ALLOWED,
            "{bad:?}"
        );
        assert!(names_in(&fixture.sync_dir()).is_empty());
    }
}

#[test]
fn a_personal_bundle_cannot_reach_the_gtd_folder_by_passing_the_wrong_role_or_path() {
    let personal = Fixture::prepared(Role::Personal);
    let gtd = Fixture::prepared(Role::Gtd);
    // Wrong role for a personal domain.
    assert_eq!(
        put(&gtd, Role::Gtd, A, "personal", b"secret")
            .unwrap_err()
            .code,
        code::DOMAIN_NOT_ALLOWED
    );
    // Right role, wrong folder: the gtd folder's marker says gtd.
    assert_eq!(
        put(&gtd, Role::Personal, A, "personal", b"secret")
            .unwrap_err()
            .code,
        code::ROLE_MISMATCH
    );
    assert!(names_in(&gtd.sync_dir()).is_empty());
    put(&personal, Role::Personal, A, "personal", b"secret").unwrap();
}

#[test]
fn a_manifest_that_lists_domains_the_role_forbids_is_returned_without_them() {
    let fixture = Fixture::prepared(Role::Gtd);
    let sha = sha256_hex(b"g");
    write_manifest(
        &fixture,
        B,
        &json!({
            "deviceId": B,
            "domains": {
                "gtd": {"generation": 1, "file": "gtd-1.bundle", "sha256": sha, "bytes": 1, "rows": 1},
                "personal": {"generation": 1, "file": "personal-1.bundle", "sha256": sha, "bytes": 1, "rows": 1},
                "finance": {"generation": 1, "file": "finance-1.bundle", "sha256": sha, "bytes": 1, "rows": 1}
            }
        }),
    );
    let listing = list_peers(fixture.dir(), Role::Gtd, PROD, A).unwrap();
    assert_eq!(listing.peers.len(), 1);
    let domains = listing.peers[0]["domains"].as_object().unwrap();
    assert_eq!(domains.keys().collect::<Vec<_>>(), vec!["gtd"]);
    let mut reported: Vec<_> = listing
        .ignored
        .iter()
        .map(|entry| (entry.path.clone(), entry.reason.clone()))
        .collect();
    reported.sort();
    assert_eq!(
        reported,
        vec![
            (
                format!("{}/manifest.json#domains.finance", dn(B)),
                "domain_not_allowed".to_string()
            ),
            (
                format!("{}/manifest.json#domains.personal", dn(B)),
                "domain_not_allowed".to_string()
            ),
        ]
    );
}

#[test]
fn malformed_domain_entries_are_removed_and_reported() {
    let fixture = Fixture::prepared(Role::Gtd);
    write_manifest(
        &fixture,
        B,
        &json!({
            "deviceId": B,
            "domains": {"gtd": {"generation": 1, "file": "../../etc/passwd", "sha256": "x", "bytes": 1, "rows": 1}}
        }),
    );
    let listing = list_peers(fixture.dir(), Role::Gtd, PROD, A).unwrap();
    assert_eq!(listing.peers[0]["domains"], json!({}));
    assert!(listing
        .ignored
        .iter()
        .any(|entry| entry.reason == "invalid_domain_entry"));
    assert_eq!(
        read_reason(read_peer(&fixture, Role::Gtd, A, B, "gtd")),
        "domain_missing"
    );
}

// ---------------------------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------------------------

#[test]
fn publish_writes_the_bundle_then_the_manifest_and_leaves_no_partial() {
    let fixture = Fixture::prepared(Role::Gtd);
    let outcome = put(&fixture, Role::Gtd, A, "gtd", b"hello bundle").unwrap();
    assert_eq!(outcome.entry.generation, 1);
    assert_eq!(outcome.entry.file, "gtd-1.bundle");
    assert_eq!(outcome.entry.bytes, 12);
    assert_eq!(outcome.entry.rows, 3);
    assert_eq!(outcome.entry.sha256, sha256_hex(b"hello bundle"));
    assert!(outcome.warnings.is_empty(), "{:?}", outcome.warnings);

    assert_eq!(
        names_in(&fixture.device_dir(A)),
        vec!["gtd-1.bundle".to_string(), "manifest.json".to_string()]
    );
    let manifest = manifest_json(&fixture, A);
    assert_eq!(manifest["deviceId"], A);
    assert_eq!(manifest["deviceName"], "Test laptop");
    assert_eq!(manifest["domains"]["gtd"]["file"], "gtd-1.bundle");
    assert_eq!(
        manifest["domains"]["gtd"]["sha256"],
        sha256_hex(b"hello bundle")
    );
    assert_eq!(manifest["domains"]["gtd"]["bytes"], 12);
    assert_eq!(manifest["domains"]["gtd"]["rows"], 3);
    assert_eq!(
        fs::read(fixture.device_dir(A).join("gtd-1.bundle")).unwrap(),
        b"hello bundle"
    );
}

#[test]
fn only_the_device_directory_is_ever_written() {
    let fixture = Fixture::prepared(Role::Gtd);
    let before = names_in(&fixture.canonical());
    put(&fixture, Role::Gtd, A, "gtd", b"x").unwrap();
    put(&fixture, Role::Gtd, A, "gtd", b"y").unwrap();
    assert_eq!(names_in(&fixture.canonical()), before);
    assert_eq!(names_in(&fixture.sync_dir()), vec![dn(A)]);
}

#[test]
fn the_manifest_is_the_commit_point_a_crash_after_the_bundle_keeps_the_previous_manifest() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, A, "gtd", b"generation one").unwrap();
    let committed = fs::read(fixture.device_dir(A).join("manifest.json")).unwrap();

    // The hook runs in the window between "bundle durable" and "manifest written".
    let device_dir = fixture.device_dir(A);
    let mut seen_in_window = None;
    let mut crash = || {
        seen_in_window = Some((
            device_dir.join("gtd-2.bundle").is_file(),
            fs::read(device_dir.join("manifest.json")).unwrap(),
        ));
        Err(SyncError::new(code::IO, "simulated crash"))
    };
    let error = publish_with_hook(
        &request(fixture.dir(), Role::Gtd, PROD, A, "gtd", b"generation two"),
        &AtomicBool::new(false),
        &mut crash,
    )
    .unwrap_err();
    assert_eq!(error.message, "simulated crash");

    let (bundle_visible, manifest_in_window) = seen_in_window.unwrap();
    assert!(
        bundle_visible,
        "the new bundle must exist before the manifest is touched"
    );
    assert_eq!(
        manifest_in_window, committed,
        "the manifest must still be the previous one"
    );

    // After the crash the previous manifest is intact and its bundle still verifies for a peer.
    assert_eq!(
        fs::read(device_dir.join("manifest.json")).unwrap(),
        committed
    );
    assert_eq!(
        read_ok(read_peer(&fixture, Role::Gtd, B, A, "gtd")),
        b"generation one"
    );
    let listing = list_peers(fixture.dir(), Role::Gtd, PROD, B).unwrap();
    assert_eq!(listing.peers[0]["domains"]["gtd"]["generation"], 1);

    // The orphan bundle's name is never reused: the next publish moves past it.
    let next = put(&fixture, Role::Gtd, A, "gtd", b"generation three").unwrap();
    assert_eq!(next.entry.generation, 3);
    assert_eq!(
        read_ok(read_peer(&fixture, Role::Gtd, B, A, "gtd")),
        b"generation three"
    );
}

#[test]
fn partial_leftovers_are_ignored_by_readers_and_cleaned_by_the_next_publish() {
    let fixture = Fixture::prepared(Role::Gtd);
    // A peer that crashed during its first publish: only partials exist.
    let peer_dir = fixture.device_dir(B);
    fs::create_dir_all(&peer_dir).unwrap();
    fs::write(peer_dir.join("gtd-1.bundle.partial"), b"half").unwrap();
    fs::write(peer_dir.join("manifest.json.partial"), b"{\"half\"").unwrap();
    let listing = list_peers(fixture.dir(), Role::Gtd, PROD, A).unwrap();
    assert!(listing.peers.is_empty());
    assert!(listing.ignored.is_empty(), "{:?}", listing.ignored);
    assert_eq!(
        read_reason(read_peer(&fixture, Role::Gtd, A, B, "gtd")),
        "manifest_missing"
    );

    // And a peer with a good manifest plus a stale partial keeps working.
    put(&fixture, Role::Gtd, B, "gtd", b"good").unwrap();
    fs::write(peer_dir.join("gtd-2.bundle.partial"), b"half").unwrap();
    assert_eq!(
        read_ok(read_peer(&fixture, Role::Gtd, A, B, "gtd")),
        b"good"
    );

    // Our own leftovers are removed by the next publish; it is not blocked by them.
    let own_dir = fixture.device_dir(A);
    fs::create_dir_all(&own_dir).unwrap();
    fs::write(own_dir.join("gtd-1.bundle.partial"), b"half").unwrap();
    fs::write(own_dir.join("manifest.json.partial"), b"half").unwrap();
    put(&fixture, Role::Gtd, A, "gtd", b"mine").unwrap();
    assert_eq!(
        names_in(&own_dir),
        vec!["gtd-1.bundle".to_string(), "manifest.json".to_string()]
    );
}

#[test]
fn publishing_one_domain_keeps_the_entries_of_the_others() {
    let fixture = Fixture::prepared(Role::Personal);
    put(&fixture, Role::Personal, A, "personal", b"p1").unwrap();
    put(&fixture, Role::Personal, A, "finance", b"f1").unwrap();
    let second = put(&fixture, Role::Personal, A, "personal", b"p2").unwrap();
    assert_eq!(second.entry.generation, 2);

    let manifest = manifest_json(&fixture, A);
    let domains = manifest["domains"].as_object().unwrap();
    assert_eq!(domains.len(), 2);
    assert_eq!(domains["personal"]["generation"], 2);
    assert_eq!(domains["personal"]["sha256"], sha256_hex(b"p2"));
    assert_eq!(domains["finance"]["generation"], 1);
    assert_eq!(domains["finance"]["sha256"], sha256_hex(b"f1"));
    assert_eq!(
        read_ok(read_peer(&fixture, Role::Personal, B, A, "finance")),
        b"f1"
    );
    assert_eq!(
        read_ok(read_peer(&fixture, Role::Personal, B, A, "personal")),
        b"p2"
    );
}

#[test]
fn the_callers_manifest_fields_are_stored_but_domains_is_always_owned_by_rust() {
    let fixture = Fixture::prepared(Role::Gtd);
    let mut manifest = manifest_for(A);
    manifest.insert(
        "domains".into(),
        json!({"personal": {"generation": 99, "file": "x", "sha256": "x", "bytes": 1, "rows": 1}}),
    );
    manifest.insert("extra".into(), json!({"kept": true}));
    publish(
        &PublishRequest {
            manifest,
            ..request(fixture.dir(), Role::Gtd, PROD, A, "gtd", b"x")
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    let stored = manifest_json(&fixture, A);
    assert_eq!(stored["extra"], json!({"kept": true}));
    assert_eq!(
        stored["domains"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        vec!["gtd"]
    );

    // The same through the string entry point, which drops `domains` before the request exists.
    let parsed = parse_caller_manifest(r#"{"deviceId":"x","domains":{"gtd":1}}"#).unwrap();
    assert!(!parsed.contains_key("domains"));
}

#[test]
fn a_manifest_for_another_device_is_refused() {
    let fixture = Fixture::prepared(Role::Gtd);
    let wrong = manifest_for(B);
    for manifest in [wrong, Map::new()] {
        let error = publish(
            &PublishRequest {
                manifest,
                ..request(fixture.dir(), Role::Gtd, PROD, A, "gtd", b"x")
            },
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(error.code, code::DEVICE_ID_INVALID);
    }
    assert!(names_in(&fixture.sync_dir()).is_empty());
    assert_eq!(
        parse_caller_manifest("[1,2]").unwrap_err().code,
        code::INVALID_ARGUMENT
    );
    assert_eq!(
        parse_caller_manifest("nope").unwrap_err().code,
        code::INVALID_ARGUMENT
    );
}

#[test]
fn publishing_keeps_two_generations_and_deletes_older_ones_per_domain() {
    let fixture = Fixture::prepared(Role::Personal);
    put(&fixture, Role::Personal, A, "finance", b"f1").unwrap();
    for generation in 1..=5u8 {
        put(&fixture, Role::Personal, A, "personal", &[generation]).unwrap();
    }
    let names = names_in(&fixture.device_dir(A));
    assert_eq!(
        names,
        vec![
            "finance-1.bundle".to_string(),
            "manifest.json".to_string(),
            "personal-4.bundle".to_string(),
            "personal-5.bundle".to_string(),
        ]
    );
    // The previous generation is still readable by a reader mid-download of it.
    assert_eq!(
        fs::read(fixture.device_dir(A).join("personal-4.bundle")).unwrap(),
        vec![4]
    );
}

#[cfg(unix)]
#[test]
fn a_failed_deletion_is_a_warning_not_a_failed_publish() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, A, "gtd", b"1").unwrap();
    put(&fixture, Role::Gtd, A, "gtd", b"2").unwrap();
    // Stand a directory under the old bundle name so remove_file fails without touching modes.
    let old = fixture.device_dir(A).join("gtd-1.bundle");
    fs::remove_file(&old).unwrap();
    fs::create_dir(&old).unwrap();
    fs::write(old.join("keep"), b"x").unwrap();
    let outcome = put(&fixture, Role::Gtd, A, "gtd", b"3").unwrap();
    assert_eq!(outcome.entry.generation, 3);
    assert!(
        outcome
            .warnings
            .iter()
            .any(|warning| warning.starts_with("delete_failed: gtd-1.bundle")),
        "{:?}",
        outcome.warnings
    );
    assert_eq!(read_ok(read_peer(&fixture, Role::Gtd, B, A, "gtd")), b"3");
}

#[test]
fn a_corrupt_own_manifest_is_replaced_and_generations_never_go_backwards() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, A, "gtd", b"one").unwrap();
    put(&fixture, Role::Gtd, A, "gtd", b"two").unwrap();
    fs::write(fixture.device_dir(A).join("manifest.json"), b"{ broken").unwrap();
    let outcome = put(&fixture, Role::Gtd, A, "gtd", b"three").unwrap();
    assert_eq!(outcome.entry.generation, 3);
    assert!(outcome
        .warnings
        .iter()
        .any(|warning| warning.starts_with("previous_manifest_ignored")));
    assert_eq!(
        manifest_json(&fixture, A)["domains"]["gtd"]["generation"],
        3
    );
}

#[test]
fn oversized_input_is_refused_before_any_write() {
    let fixture = Fixture::prepared(Role::Gtd);
    let big = vec![0u8; (MAX_BUNDLE_BYTES + 1) as usize];
    assert_eq!(
        put(&fixture, Role::Gtd, A, "gtd", &big).unwrap_err().code,
        code::TOO_LARGE
    );
    assert!(names_in(&fixture.sync_dir()).is_empty());
    let huge_manifest = format!(
        "{{\"deviceId\":\"{}\"}}",
        "x".repeat(MAX_MANIFEST_BYTES as usize)
    );
    assert_eq!(
        parse_caller_manifest(&huge_manifest).unwrap_err().code,
        code::TOO_LARGE
    );
    assert!(base64_len_cap(MAX_BUNDLE_BYTES) > MAX_BUNDLE_BYTES);
}

#[test]
fn concurrent_publishes_from_one_device_are_serialized() {
    let fixture = Fixture::prepared(Role::Gtd);
    let dir = fixture.dir().to_string();
    let payloads: Vec<Vec<u8>> = (0..8u8).map(|n| vec![n; 4096 + n as usize]).collect();
    let outcomes: Vec<PublishOutcome> = thread::scope(|scope| {
        let handles: Vec<_> = payloads
            .iter()
            .map(|payload| {
                let dir = dir.clone();
                scope.spawn(move || {
                    publish(
                        &request(&dir, Role::Gtd, PROD, A, "gtd", payload),
                        &AtomicBool::new(false),
                    )
                    .expect("publish")
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect()
    });

    let mut generations: Vec<u64> = outcomes
        .iter()
        .map(|outcome| outcome.entry.generation)
        .collect();
    generations.sort();
    assert_eq!(generations, (1..=8).collect::<Vec<u64>>());
    let manifest = manifest_json(&fixture, A);
    assert_eq!(manifest["domains"]["gtd"]["generation"], 8);
    // The committed manifest describes exactly the bundle it names.
    let final_outcome = outcomes
        .iter()
        .find(|outcome| outcome.entry.generation == 8)
        .unwrap();
    assert_eq!(
        manifest["domains"]["gtd"]["sha256"],
        final_outcome.entry.sha256
    );
    assert_eq!(
        sha256_hex(&read_ok(read_peer(&fixture, Role::Gtd, B, A, "gtd"))),
        final_outcome.entry.sha256
    );
    assert_eq!(
        names_in(&fixture.device_dir(A)),
        vec![
            "gtd-7.bundle".to_string(),
            "gtd-8.bundle".to_string(),
            "manifest.json".to_string()
        ]
    );
}

#[test]
fn different_devices_do_not_block_each_other() {
    let fixture = Fixture::prepared(Role::Gtd);
    let (reached_tx, reached_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let dir = fixture.dir().to_string();
    thread::scope(|scope| {
        let first_dir = dir.clone();
        let first = scope.spawn(move || {
            let mut hook = || {
                reached_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            };
            publish_with_hook(
                &request(&first_dir, Role::Gtd, PROD, A, "gtd", b"a"),
                &AtomicBool::new(false),
                &mut hook,
            )
        });
        reached_rx.recv().unwrap();
        // Device A holds its lock; device B publishes to completion meanwhile.
        put(&fixture, Role::Gtd, B, "gtd", b"b").unwrap();
        release_tx.send(()).unwrap();
        first.join().unwrap().unwrap();
    });
}

#[test]
fn a_publish_that_times_out_while_queued_behind_the_lock_never_runs() {
    let fixture = Fixture::prepared(Role::Gtd);
    let (reached_tx, reached_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let dir = fixture.dir().to_string();
    thread::scope(|scope| {
        let first_dir = dir.clone();
        let first = scope.spawn(move || {
            let mut hook = || {
                reached_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            };
            publish_with_hook(
                &request(&first_dir, Role::Gtd, PROD, A, "gtd", b"first"),
                &AtomicBool::new(false),
                &mut hook,
            )
        });
        reached_rx.recv().unwrap();

        // The caller of this second publish has already given up (the flag a timeout sets).
        let abandoned = AtomicBool::new(true);
        let second_dir = dir.clone();
        let second = scope.spawn(move || {
            publish(
                &request(&second_dir, Role::Gtd, PROD, A, "gtd", b"second"),
                &abandoned,
            )
        });
        thread::sleep(Duration::from_millis(150));
        release_tx.send(()).unwrap();
        first.join().unwrap().unwrap();
        assert_eq!(second.join().unwrap().unwrap_err().code, code::TIMEOUT);
    });
    assert_eq!(
        manifest_json(&fixture, A)["domains"]["gtd"]["generation"],
        1
    );
    assert!(!fixture.device_dir(A).join("gtd-2.bundle").exists());
}

// ---------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------

#[test]
fn listing_a_folder_nobody_has_published_to_is_empty_not_an_error() {
    let fixture = Fixture::prepared(Role::Gtd);
    fs::remove_dir(fixture.sync_dir()).unwrap();
    let listing = list_peers(fixture.dir(), Role::Gtd, PROD, A).unwrap();
    assert!(listing.peers.is_empty() && listing.own.is_none() && listing.ignored.is_empty());
    // Listing never creates the directory.
    assert!(!fixture.sync_dir().exists());
}

#[test]
fn listing_returns_peers_sorted_and_own_separately() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, C, "gtd", b"c").unwrap();
    put(&fixture, Role::Gtd, A, "gtd", b"a").unwrap();
    put(&fixture, Role::Gtd, B, "gtd", b"b").unwrap();
    let listing = list_peers(fixture.dir(), Role::Gtd, PROD, A).unwrap();
    let ids: Vec<&str> = listing
        .peers
        .iter()
        .map(|peer| peer["deviceId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![B, C]);
    assert_eq!(listing.own.as_ref().unwrap()["deviceId"], A);
    assert_eq!(
        listing.own.as_ref().unwrap()["domains"]["gtd"]["generation"],
        1
    );
    assert!(listing.ignored.is_empty());
}

#[test]
fn conflict_copies_strays_and_mismatched_manifests_are_ignored_and_reported() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, B, "gtd", b"good").unwrap();
    let b_dir = fixture.device_dir(B);

    // Drive's "(1)" copy of the manifest inside a valid directory.
    fs::copy(b_dir.join("manifest.json"), b_dir.join("manifest (1).json")).unwrap();
    // A directory that is a Drive copy of a device directory, and stray files.
    fs::create_dir(fixture.sync_dir().join(format!("{} (1)", dn(B)))).unwrap();
    fs::write(fixture.sync_dir().join("notes.txt"), b"x").unwrap();
    fs::write(fixture.sync_dir().join(".DS_Store"), b"x").unwrap();
    fs::create_dir(fixture.sync_dir().join("not-a-device")).unwrap();
    // C's directory holds a manifest claiming to be B.
    fs::create_dir(fixture.device_dir(C)).unwrap();
    fs::copy(
        b_dir.join("manifest.json"),
        fixture.device_dir(C).join("manifest.json"),
    )
    .unwrap();

    let listing = list_peers(fixture.dir(), Role::Gtd, PROD, A).unwrap();
    assert_eq!(listing.peers.len(), 1);
    assert_eq!(listing.peers[0]["deviceId"], B);
    let mut reported: Vec<_> = listing
        .ignored
        .iter()
        .map(|entry| (entry.path.clone(), entry.reason.clone()))
        .collect();
    reported.sort();
    let mut expected = vec![
        (
            format!("{}/manifest (1).json", dn(B)),
            "conflict_copy".to_string(),
        ),
        (
            format!("{} (1)", dn(B)),
            "invalid_device_directory".to_string(),
        ),
        (
            "not-a-device".to_string(),
            "invalid_device_directory".to_string(),
        ),
        (
            "notes.txt".to_string(),
            "invalid_device_directory".to_string(),
        ),
        (
            format!("{}/manifest.json", dn(C)),
            "device_id_mismatch".to_string(),
        ),
    ];
    expected.sort();
    assert_eq!(reported, expected);
}

#[test]
fn a_manifest_in_the_own_directory_claiming_another_device_is_not_trusted() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, B, "gtd", b"b").unwrap();
    fs::create_dir(fixture.device_dir(A)).unwrap();
    fs::copy(
        fixture.device_dir(B).join("manifest.json"),
        fixture.device_dir(A).join("manifest.json"),
    )
    .unwrap();
    let listing = list_peers(fixture.dir(), Role::Gtd, PROD, A).unwrap();
    assert!(listing.own.is_none());
    assert_eq!(listing.peers.len(), 1);
    assert!(listing
        .ignored
        .iter()
        .any(|entry| entry.reason == "device_id_mismatch"));
}

#[test]
fn unparseable_manifests_are_skipped_and_reported_never_an_error() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, C, "gtd", b"c").unwrap();
    fs::create_dir_all(fixture.device_dir(B)).unwrap();
    fs::write(fixture.device_dir(B).join("manifest.json"), b"{ not json").unwrap();
    let listing = list_peers(fixture.dir(), Role::Gtd, PROD, A).unwrap();
    assert_eq!(listing.peers.len(), 1);
    assert!(listing
        .ignored
        .iter()
        .any(|entry| entry.reason == "manifest_invalid_json"));
    for (content, reason) in [
        (json!([1, 2]), "manifest_not_object"),
        (json!({"deviceId": B}), "domains_invalid"),
        (json!({"deviceId": B, "domains": []}), "domains_invalid"),
        (json!({"deviceId": 7, "domains": {}}), "device_id_mismatch"),
    ] {
        write_manifest(&fixture, B, &content);
        let listing = list_peers(fixture.dir(), Role::Gtd, PROD, A).unwrap();
        assert_eq!(listing.peers.len(), 1, "{reason}");
        assert!(
            listing.ignored.iter().any(|entry| entry.reason == reason),
            "{reason}"
        );
    }
}

#[test]
fn an_oversized_manifest_is_ignored_without_being_read_into_memory() {
    let fixture = Fixture::prepared(Role::Gtd);
    let dir = fixture.device_dir(B);
    fs::create_dir(&dir).unwrap();
    let mut content = format!("{{\"deviceId\":\"{B}\",\"domains\":{{}},\"pad\":\"").into_bytes();
    content.extend(std::iter::repeat_n(b'a', MAX_MANIFEST_BYTES as usize));
    content.extend_from_slice(b"\"}");
    fs::write(dir.join("manifest.json"), content).unwrap();
    let listing = list_peers(fixture.dir(), Role::Gtd, PROD, A).unwrap();
    assert!(listing.peers.is_empty());
    assert!(listing
        .ignored
        .iter()
        .any(|entry| entry.reason == "manifest_too_large"));
    assert!(matches!(
        load_manifest(&dir, B, Role::Gtd),
        ManifestOutcome::Ignored("manifest_too_large")
    ));
}

#[test]
fn the_ignored_report_is_bounded() {
    let fixture = Fixture::prepared(Role::Gtd);
    for index in 0..300 {
        fs::write(fixture.sync_dir().join(format!("junk-{index}.txt")), b"x").unwrap();
    }
    let listing = list_peers(fixture.dir(), Role::Gtd, PROD, A).unwrap();
    assert_eq!(listing.ignored.len(), 100);
}

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

#[test]
fn read_returns_verified_bytes_with_the_manifest_facts() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, B, "gtd", b"peer bundle").unwrap();
    match read_peer(&fixture, Role::Gtd, A, B, "gtd") {
        ReadBundleResult::Ok {
            bytes_base64,
            generation,
            sha256,
            bytes,
            rows,
        } => {
            assert_eq!(BASE64.decode(bytes_base64).unwrap(), b"peer bundle");
            assert_eq!((generation, bytes, rows), (1, 11, 3));
            assert_eq!(sha256, sha256_hex(b"peer bundle"));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_hash_mismatch_a_short_file_or_a_missing_file_is_not_ready() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, B, "gtd", b"0123456789").unwrap();
    let bundle = fixture.device_dir(B).join("gtd-1.bundle");

    // Same size, different content: Drive served another version.
    fs::write(&bundle, b"0123456780").unwrap();
    assert_eq!(
        read_reason(read_peer(&fixture, Role::Gtd, A, B, "gtd")),
        "hash_mismatch"
    );
    // Truncated: the upload has not finished propagating.
    fs::write(&bundle, b"01234").unwrap();
    assert_eq!(
        read_reason(read_peer(&fixture, Role::Gtd, A, B, "gtd")),
        "size_mismatch"
    );
    // Longer than the manifest says.
    fs::write(&bundle, b"0123456789AB").unwrap();
    assert_eq!(
        read_reason(read_peer(&fixture, Role::Gtd, A, B, "gtd")),
        "size_mismatch"
    );
    // Not there yet.
    fs::remove_file(&bundle).unwrap();
    assert_eq!(
        read_reason(read_peer(&fixture, Role::Gtd, A, B, "gtd")),
        "file_missing"
    );
    // And once it is complete the same read succeeds.
    fs::write(&bundle, b"0123456789").unwrap();
    assert_eq!(
        read_ok(read_peer(&fixture, Role::Gtd, A, B, "gtd")),
        b"0123456789"
    );
}

#[test]
fn reading_a_peer_that_has_no_directory_manifest_or_domain_is_not_ready() {
    let fixture = Fixture::prepared(Role::Personal);
    assert_eq!(
        read_reason(read_peer(&fixture, Role::Personal, A, B, "personal")),
        "peer_directory_missing"
    );
    put(&fixture, Role::Personal, B, "personal", b"p").unwrap();
    assert_eq!(
        read_reason(read_peer(&fixture, Role::Personal, A, B, "finance")),
        "domain_missing"
    );
    fs::remove_file(fixture.device_dir(B).join("manifest.json")).unwrap();
    assert_eq!(
        read_reason(read_peer(&fixture, Role::Personal, A, B, "personal")),
        "manifest_missing"
    );
}

#[test]
fn the_file_read_comes_from_the_manifest_never_from_the_caller() {
    // There is no file-name parameter at all; and a manifest naming a different file is invalid.
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, B, "gtd", b"real").unwrap();
    fs::write(fixture.device_dir(B).join("other.bundle"), b"decoy").unwrap();
    let mut manifest = manifest_json(&fixture, B);
    manifest["domains"]["gtd"]["file"] = json!("other.bundle");
    write_manifest(&fixture, B, &manifest);
    assert_eq!(
        read_reason(read_peer(&fixture, Role::Gtd, A, B, "gtd")),
        "domain_missing"
    );
    manifest["domains"]["gtd"]["file"] = json!("../gtd-1.bundle");
    write_manifest(&fixture, B, &manifest);
    assert_eq!(
        read_reason(read_peer(&fixture, Role::Gtd, A, B, "gtd")),
        "domain_missing"
    );
}

#[test]
fn a_manifest_that_claims_an_oversized_bundle_is_too_large() {
    let fixture = Fixture::prepared(Role::Gtd);
    write_manifest(
        &fixture,
        B,
        &json!({
            "deviceId": B,
            "domains": {"gtd": {
                "generation": 1, "file": "gtd-1.bundle",
                "sha256": sha256_hex(b"x"), "bytes": MAX_BUNDLE_BYTES + 1, "rows": 1
            }}
        }),
    );
    assert_eq!(
        read_bundle(fixture.dir(), Role::Gtd, PROD, A, B, "gtd")
            .unwrap_err()
            .code,
        code::TOO_LARGE
    );
}

#[test]
fn a_manifest_in_the_wrong_directory_is_not_ready_for_reads_too() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, B, "gtd", b"b").unwrap();
    fs::create_dir(fixture.device_dir(C)).unwrap();
    fs::copy(
        fixture.device_dir(B).join("manifest.json"),
        fixture.device_dir(C).join("manifest.json"),
    )
    .unwrap();
    fs::copy(
        fixture.device_dir(B).join("gtd-1.bundle"),
        fixture.device_dir(C).join("gtd-1.bundle"),
    )
    .unwrap();
    assert_eq!(
        read_reason(read_peer(&fixture, Role::Gtd, A, C, "gtd")),
        "device_id_mismatch"
    );
}

// ---------------------------------------------------------------------------------------------
// Device directory names, prune of orphans, manifest sized before the bundle, queued prepare
// ---------------------------------------------------------------------------------------------

#[test]
fn device_directory_names_are_filename_safe_and_strict() {
    assert_eq!(dn(A), "dev-3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a");
    assert!(!dn(A).contains(':'));
    assert_eq!(device_id_from_dir_name(&dn(A)).as_deref(), Some(A));
    for id in [A, B, C] {
        assert_eq!(device_id_from_dir_name(&dn(id)).as_deref(), Some(id));
    }
    // Only the exact `dev-` + lowercase uuid v4 spelling maps back to an id.
    for bad in [
        A, // the id spelling `dev:<uuid>` is not a directory name
        "dev-3F1C0B9C-6A3F-4B8E-9D2A-1F2E3D4C5B6A",
        "DEV-3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a",
        "dev_3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a",
        "dev-3f1c0b9c-6a3f-1b8e-9d2a-1f2e3d4c5b6a",
        "dev-3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a ",
        "dev-3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a (1)",
        "dev-3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a/",
        "dev-dev:3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a",
        "dev--",
        "dev-",
        "",
        "../dev-3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a",
    ] {
        assert_eq!(device_id_from_dir_name(bad), None, "{bad:?}");
    }
    for bad in ["../x", "dev-3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a", ""] {
        assert_eq!(
            device_dir_name(bad).unwrap_err().code,
            code::DEVICE_ID_INVALID
        );
    }
}

#[test]
fn publish_writes_dev_dash_directories_and_the_manifest_keeps_the_colon_id() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, A, "gtd", b"x").unwrap();
    assert_eq!(names_in(&fixture.sync_dir()), vec![dn(A)]);
    assert!(!fixture.sync_dir().join(A).exists());
    assert_eq!(manifest_json(&fixture, A)["deviceId"], A);

    // A peer sees it under the same id, and reads it by that id.
    let listing = list_peers(fixture.dir(), Role::Gtd, PROD, B).unwrap();
    assert_eq!(listing.peers[0]["deviceId"], A);
    assert_eq!(read_ok(read_peer(&fixture, Role::Gtd, B, A, "gtd")), b"x");
    // The own directory is recognised through the same mapping.
    let own = list_peers(fixture.dir(), Role::Gtd, PROD, A).unwrap();
    assert!(own.peers.is_empty());
    assert_eq!(own.own.unwrap()["deviceId"], A);
}

#[test]
fn a_directory_still_named_with_a_colon_is_an_invalid_entry() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, B, "gtd", b"b").unwrap();
    // A full, valid-looking device directory under the old `dev:<uuid>` spelling.
    let legacy = fixture.sync_dir().join(C);
    fs::create_dir(&legacy).unwrap();
    fs::copy(
        fixture.device_dir(B).join("manifest.json"),
        legacy.join("manifest.json"),
    )
    .unwrap();
    let listing = list_peers(fixture.dir(), Role::Gtd, PROD, A).unwrap();
    assert_eq!(listing.peers.len(), 1);
    assert_eq!(listing.peers[0]["deviceId"], B);
    assert!(listing
        .ignored
        .iter()
        .any(|entry| entry.path == C && entry.reason == "invalid_device_directory"));
    // And it cannot be read as a peer either.
    assert_eq!(
        read_reason(read_peer(&fixture, Role::Gtd, A, C, "gtd")),
        "peer_directory_missing"
    );
}

#[test]
fn a_manifest_must_name_the_id_its_directory_name_maps_to() {
    let fixture = Fixture::prepared(Role::Gtd);
    put(&fixture, Role::Gtd, B, "gtd", b"b").unwrap();
    // C's `dev-` directory holds B's manifest.
    fs::create_dir(fixture.device_dir(C)).unwrap();
    fs::copy(
        fixture.device_dir(B).join("manifest.json"),
        fixture.device_dir(C).join("manifest.json"),
    )
    .unwrap();
    let listing = list_peers(fixture.dir(), Role::Gtd, PROD, A).unwrap();
    assert_eq!(listing.peers.len(), 1);
    assert!(listing.ignored.iter().any(|entry| {
        entry.path == format!("{}/manifest.json", dn(C)) && entry.reason == "device_id_mismatch"
    }));
}

#[test]
fn pruning_drops_orphans_and_keeps_the_previously_committed_generation() {
    let fixture = Fixture::prepared(Role::Gtd);
    for payload in [b"one", b"two", b"333"] {
        put(&fixture, Role::Gtd, A, "gtd", payload).unwrap();
    }
    assert_eq!(
        manifest_json(&fixture, A)["domains"]["gtd"]["generation"],
        3
    );

    // A publish crashes after its bundle: generation 4 is an orphan; the manifest still says 3.
    let mut crash = || Err(SyncError::new(code::IO, "simulated crash"));
    publish_with_hook(
        &request(fixture.dir(), Role::Gtd, PROD, A, "gtd", b"orphan"),
        &AtomicBool::new(false),
        &mut crash,
    )
    .unwrap_err();
    assert!(fixture.device_dir(A).join("gtd-4.bundle").is_file());

    let next = put(&fixture, Role::Gtd, A, "gtd", b"five").unwrap();
    assert_eq!(next.entry.generation, 5);
    // The committed generation 3 survives (a reader mid-download of it is not cut off); the
    // orphan 4 and the older 2 are gone.
    assert_eq!(
        names_in(&fixture.device_dir(A)),
        vec![
            "gtd-3.bundle".to_string(),
            "gtd-5.bundle".to_string(),
            "manifest.json".to_string()
        ]
    );
    assert_eq!(
        fs::read(fixture.device_dir(A).join("gtd-3.bundle")).unwrap(),
        b"333"
    );
}

#[test]
fn an_oversized_manifest_leaves_no_bundle_behind_across_retries() {
    let fixture = Fixture::prepared(Role::Gtd);
    // ~900 KB of caller fields: under the 1 MiB input cap, but the stored manifest is pretty
    // printed (one extra line per array element), which pushes it past 1 MiB.
    let items: Vec<Value> = (0..150_000).map(|_| json!(1)).collect();
    let mut manifest = manifest_for(A);
    manifest.insert("padding".into(), Value::Array(items));
    let compact = serde_json::to_string(&manifest).unwrap();
    assert!(
        compact.len() < MAX_MANIFEST_BYTES as usize && compact.len() > 300_000,
        "{}",
        compact.len()
    );
    assert!(parse_caller_manifest(&compact).is_ok());

    for _ in 0..3 {
        let error = publish(
            &PublishRequest {
                manifest: manifest.clone(),
                ..request(fixture.dir(), Role::Gtd, PROD, A, "gtd", b"bundle")
            },
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(error.code, code::TOO_LARGE);
        let dir = fixture.device_dir(A);
        let left: Vec<String> = if dir.exists() {
            names_in(&dir)
        } else {
            Vec::new()
        };
        assert!(left.is_empty(), "orphans left behind: {left:?}");
    }
    // A normal publish afterwards still starts at generation 1.
    assert_eq!(
        put(&fixture, Role::Gtd, A, "gtd", b"ok")
            .unwrap()
            .entry
            .generation,
        1
    );
}

#[test]
fn a_device_directory_with_too_many_files_refuses_a_publish_instead_of_guessing_generations() {
    let fixture = Fixture::prepared(Role::Gtd);
    let dir = fixture.device_dir(A);
    fs::create_dir_all(&dir).unwrap();
    for index in 0..=MAX_SCANNED_ENTRIES {
        fs::write(dir.join(format!("junk-{index}.tmp")), b"").unwrap();
    }
    let error = put(&fixture, Role::Gtd, A, "gtd", b"x").unwrap_err();
    assert_eq!(error.code, code::IO);
    assert!(!dir.join("gtd-1.bundle").exists());
    assert!(!dir.join("manifest.json").exists());
}

#[test]
fn a_prepare_that_timed_out_while_queued_writes_nothing() {
    let fixture = Fixture::bare();
    let abandoned = AtomicBool::new(true);
    let error =
        prepare_folder_cancellable(fixture.dir(), None, Role::Gtd, PROD, &abandoned).unwrap_err();
    assert_eq!(error.code, code::TIMEOUT);
    assert!(names_in(&fixture.root).is_empty(), "no marker, no sync/");

    // Genuinely queued: hold the prepare lock from another thread, queue an abandoned prepare
    // behind it, then release.
    let (held_tx, held_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let dir = fixture.dir().to_string();
    thread::scope(|scope| {
        let first = scope.spawn(move || {
            // Occupy the very lock `prepare_folder` takes.
            let _guard = super::folder::lock_prepare_for_test();
            held_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });
        held_rx.recv().unwrap();
        let queued_dir = dir.clone();
        let queued = scope.spawn(move || {
            let flag = AtomicBool::new(false);
            // The flag flips while the call waits for the lock, like a timeout would.
            thread::scope(|inner| {
                let handle = inner.spawn(|| {
                    prepare_folder_cancellable(&queued_dir, None, Role::Gtd, PROD, &flag)
                });
                thread::sleep(Duration::from_millis(100));
                flag.store(true, Ordering::SeqCst);
                release_tx.send(()).unwrap();
                handle.join().unwrap()
            })
        });
        first.join().unwrap();
        assert_eq!(queued.join().unwrap().unwrap_err().code, code::TIMEOUT);
    });
    assert!(names_in(&fixture.root).is_empty(), "no marker, no sync/");
    // A live prepare still works afterwards.
    prepare_folder(fixture.dir(), None, Role::Gtd, PROD).unwrap();
}

// ---------------------------------------------------------------------------------------------
// Durability helper, blocking runner
// ---------------------------------------------------------------------------------------------

#[cfg(unix)]
#[test]
fn a_directory_flush_failure_is_reported_as_a_warning() {
    let dir = tempfile::tempdir().unwrap();
    assert!(directory_sync_warning(dir.path()).is_none());
    let warning = directory_sync_warning(&dir.path().join("gone")).expect("warning");
    assert!(warning.starts_with("directory_sync_failed"), "{warning}");
}

#[tokio::test]
async fn a_blocked_call_returns_timeout_and_flags_the_work_as_abandoned() {
    let (observed_tx, observed_rx) = mpsc::channel();
    let started = std::time::Instant::now();
    let result: Result<(), SyncError> = run_blocking(Duration::from_millis(60), move |cancelled| {
        // Stands in for a read blocked on an online-only Drive file.
        thread::sleep(Duration::from_millis(400));
        observed_tx.send(cancelled.load(Ordering::SeqCst)).unwrap();
        Ok(())
    })
    .await;
    assert_eq!(result.unwrap_err().code, code::TIMEOUT);
    assert!(
        started.elapsed() < Duration::from_millis(350),
        "did not wait for the blocked work"
    );
    assert!(observed_rx.recv_timeout(Duration::from_secs(5)).unwrap());
}

#[tokio::test]
async fn a_fast_call_returns_its_result_and_a_panic_is_an_io_error() {
    let value = run_blocking(Duration::from_secs(5), |cancelled| {
        assert!(!cancelled.load(Ordering::SeqCst));
        Ok(7)
    })
    .await;
    assert_eq!(value.unwrap(), 7);

    let error = run_blocking::<(), _>(Duration::from_secs(5), |_| panic!("boom"))
        .await
        .unwrap_err();
    assert_eq!(error.code, code::IO);
    let failure = run_blocking::<(), _>(Duration::from_secs(5), |_| {
        Err(SyncError::new(code::FOLDER_NOT_FOUND, "x"))
    })
    .await
    .unwrap_err();
    assert_eq!(failure.code, code::FOLDER_NOT_FOUND);
}
