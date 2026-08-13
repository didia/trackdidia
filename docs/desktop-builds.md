# Desktop Development and Builds

TrackDidia has two useful development modes:

- Vite/browser preview for fast UI work;
- Tauri desktop for durable storage and native behavior.

## Prerequisites

- Node.js/npm compatible with the committed lockfile;
- Rust toolchain for Tauri development/builds;
- platform-specific Tauri build prerequisites;
- a local `Tasks.json` file when building the current source, because
  `AppProvider` and Settings import it statically.

`Tasks.json` is gitignored and can contain personal data. Do not replace it with
real data in a commit.

## Install

```bash
npm install
```

Dependencies are locked by `package-lock.json`.

## Browser preview

```bash
npm run dev
```

Vite listens on `0.0.0.0:1420` with a strict port. Browser preview uses
`MemoryRepository`.

Appropriate checks:

- layout and responsive styling;
- route navigation;
- deterministic domain/UI interactions;
- unit/integration tests.

Not validated by preview:

- persistence across reload;
- SQLite migrations;
- manual/automatic backups;
- Tauri storage paths;
- native notifications;
- release/debug database separation.

## Tauri development

```bash
npm run tauri dev
```

Tauri runs `npm run dev`, then opens `http://localhost:1420` in the main desktop
window. Debug builds use:

- `trackdidia.dev.db`;
- `backups-dev/`;
- debug logging enabled by `import.meta.env.DEV`.

The configured main window is 1440×960, resizable, with minimum 1100×760.

## Tests and production frontend

```bash
npm run test
npm run build
```

The frontend build runs TypeScript checking and writes Vite assets to `dist/`.
Because `Tasks.json` is a static JSON import, locally built JavaScript may embed
content from that file. Treat the output as potentially sensitive.

## Native production bundle

```bash
npm run tauri build
```

Tauri runs `npm run build`, consumes `dist/`, and targets all configured platform
bundle formats. Icons and metadata come from `src-tauri/tauri.conf.json`.

Release builds use:

- product name `TrackDidia`;
- version `0.1.0`;
- identifier `com.trackdidia.desktop`;
- production `trackdidia.db` and `backups/`.

The Rust crate version and Tauri configuration version should stay aligned when
preparing a release.

## Install the macOS app locally

After a native production bundle exists, copy it into `/Applications`:

```bash
npm run tauri build
npm run mac-install
```

`npm run mac-install` runs `scripts/mac-install.sh`. That script:

- locates `Trackdidia.app` in `src-tauri/target/release/bundle/macos/`, or in
  `$CARGO_TARGET_DIR` / an explicit path argument when those are set;
- quits a running Trackdidia process if present;
- replaces `/Applications/Trackdidia.app`;
- clears quarantine attributes with `xattr -cr`.

It does not build the app, delete user data, or touch the production SQLite
database. The installed app continues to use
`~/Library/Application Support/com.trackdidia.desktop/`.

## Native plugins and permissions

The Rust host registers:

- `tauri-plugin-sql`;
- `tauri-plugin-notification`;
- the custom `resolve_storage_paths` command.

The default main-window capability grants:

- `core:default`;
- `sql:default`;
- `sql:allow-execute`;
- `notification:default`.

New native APIs require both plugin initialization and capability review.

## Release safety checklist

Before distributing a build:

1. Run `npm run test`.
2. Run `npm run build`.
3. Run `cargo check --manifest-path src-tauri/Cargo.toml`.
4. Exercise the app through `npm run tauri dev` against the development database.
5. Verify a fresh database applies all migrations.
6. Verify an existing database upgrades without losing entries/tasks/settings.
7. Create and inspect a manual backup.
8. Check Pomodoro sound and notification permission behavior.
9. Confirm no real API key or personal `Tasks.json` content is in committed files.
10. Build the native bundle and smoke-test the installed artifact.

## Data continuity

Application updates should preserve the app-data directory as long as the identifier
remains stable and the installer does not remove user data. Release and development
databases are deliberately distinct, so testing cannot silently mutate production
data.

Before changing any of these, document and test migration behavior:

- Tauri identifier;
- product name/path behavior;
- SQLite filenames;
- backup directory names;
- schema migration IDs;
- application settings serialization.

There is currently no automated updater or documented signing/notarization pipeline
in the repository. Do not imply that a generated bundle is ready for public
distribution without completing the relevant platform release requirements.

## Related documentation

- [Architecture](architecture.md)
- [Storage and backups](storage-and-backups.md)
- [Conventions](conventions.md)
