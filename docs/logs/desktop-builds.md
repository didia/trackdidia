# Desktop builds log

Back to [Documentation Log](../log.md). Canonical page:
[desktop-builds.md](../desktop-builds.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-09-08 | Email triage tray (`tray-icon`), autostart plugin, and `email_triage_set_desktop_prefs` command | `docs/desktop-builds.md`, `docs/email-triage.md` | `email_triage_desktop.rs`, `capabilities/default.json` |
| 2026-09-08 | Added `tauri-plugin-opener` plus Gmail OAuth loopback and provider HTTP Tauri commands | `docs/desktop-builds.md`, `docs/email-triage.md` | `oauth_loopback.rs`, `provider_http.rs`, `capabilities/default.json` |
| 2026-09-04 | `Tasks.json` is no longer a local build prerequisite | `docs/desktop-builds.md` | removed static imports |
| 2026-08-13 | Added `npm run mac-install` to copy the release `Trackdidia.app` into `/Applications` | `docs/desktop-builds.md` | `scripts/mac-install.sh`, `package.json` |

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
