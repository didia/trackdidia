# Email triage log

- 2026-09-10: Review follow-up — revoked Google grants map `invalid_grant` to
  reconnect, disable/pause/disconnect cancel remaining in-page classifier work,
  coordinator failures outside page retries are recorded and rescheduled,
  oversized Gmail messages are quarantined so history can advance, obsolete
  coordinator startups cannot clear the live instance, and vault credentials are
  rolled back when account persistence fails.
- 2026-09-09: Graph review follow-up — `$deltatoken=latest` first-connect baseline, invalid-delta
  reseed keeps `baselineAt`, rotated Microsoft refresh tokens persisted, reconnect preserves sync
  cursor, 410 reseed during snapshot/`nextLink`, Microsoft hosts on the Tauri HTTP allowlist.
- 2026-09-09: Review follow-up — pagination carries the updated cursor, replay
  repairs missing GTD/effects after a persist crash, reviews no longer store
  body excerpts, resolving a review commits the message/conversation decision,
  and enable/resume reconfigures the coordinator.
- 2026-09-08: Microsoft Graph slice — live multitenant OAuth (PKCE, loopback,
  `Mail.ReadWrite` + `MailboxSettings.ReadWrite`), Graph inbox delta baseline/replay/invalid-delta
  reseed, message-level Outlook categories, French Connect/Reconnect Microsoft, migration 31 for
  `microsoftOAuthClientId`. Yahoo remains mocked; automatic mutation still off.
- 2026-09-08: Gmail slice — live installed-app OAuth (PKCE, loopback, `gmail.modify`), Tauri
  HTTP + opener plugin, live Gmail adapter with history sync/recovery/markers, vault-backed
  refresh tokens, triage OpenRouter key UI, French Connect/Reconnect/Disconnect/Sync now,
  migration 30 for `gmailOAuthClientId`. Graph/Yahoo remain mocked; automatic mutation still
  off.
- 2026-09-08: Review follow-up — idempotent reviews and message upserts on page
  replay, inverted evaluation automation gate, review resolve error handling,
  matching managed-notes hashes, Graph gap reseed, account-scoped effect
  reconciliation, vault probe only when enabled, coordinator start/stop, and
  docs that no longer claim secrets are stored.
- 2026-09-08: Shipped disabled-by-default foundation — SQLite migration 29, vault commands,
  mocked provider protocol adapters, classifier/evaluation/GTD ownership engines, French UI,
  and coordinator wired after bootstrap. Live mutation and tray/autostart remain out of scope.
