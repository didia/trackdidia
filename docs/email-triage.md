# Email triage (Gmail slice)

See also: [changelog](logs/email-triage.md).

TrackDidia ships a **disabled-by-default** local email triage subsystem. The foundation
slice persists accounts, conversations, classification metadata, reviews, desired effects,
and audit data. This **Gmail slice** adds live Gmail OAuth and synchronization on desktop;
Microsoft Graph and Yahoo remain mocked protocol adapters.

## Shipped in this slice

- Installed-app Google OAuth with `gmail.modify`, PKCE S256, system browser, and loopback
  callback handled in the Tauri host (`127.0.0.1` ephemeral port)
- Live Gmail adapter: baseline `historyId`, paginated `users.history.list`, inbox recheck,
  dedupe, label-only history ignored (including TrackDidia self-writes), expired-history
  recovery with inbox scan + replay, and message-level marker implementation
- Refresh tokens stored in the OS vault per account; access tokens cached in memory only
- French UI: Connect / Reconnect / Disconnect Gmail, Sync now, advanced Gmail OAuth client ID,
  dedicated triage OpenRouter key vault form with explicit copy-from-coach-key
- OpenRouter classifier (temperature 0, no tools) when the triage vault key exists; otherwise
  the existing `missing_api_key` review path
- Coordinator wires the live Gmail adapter when Tauri runtime + vault credentials exist

## Still not shipped

- Live Microsoft Graph or Yahoo connections
- Automatic provider mutation (global and per-account `mutationEnabled` remain off; coordinator
  passes `mutationEnabled: false`)
- System tray hide-on-close, autostart, or launch-at-login
- Historical import, sending, attachment inspection

## Architecture

- Subsystem: [`src/lib/email-triage/`](../src/lib/email-triage/)
- Domain types: [`src/domain/email-triage.ts`](../src/domain/email-triage.ts)
- SQLite migrations `29_add_email_triage_foundation` and
  `30_add_email_triage_gmail_oauth_client_id`
- Tauri commands: `oauth_loopback_start`, `oauth_loopback_wait`, `provider_http_request`; system
  URLs open via `tauri-plugin-opener`
- Coordinator starts only after `AppProvider` bootstrap finishes successfully. Browser
  preview and the eight-second in-memory storage fallback both skip polling, OAuth, and
  vault writes. Vault availability is probed only when the feature is enabled.
- Classifier body text is transient; raw MIME and bodies are never persisted.
  Reviews store subject/sender/received-at/source URL only. Body preview is not
  durable in this slice.
- Enabling triage or pausing/resuming an account from the page reconfigures the
  coordinator without restarting the app. Disable, pause, and disconnect also
  invalidate the in-flight account generation so later messages on an already
  fetched page are not classified or committed. Pagination reloads the saved
  cursor after each completed page, with a per-run page cap. A revoked Google
  grant (`invalid_grant`) moves that account to `reconnect_required`. Oversized
  Gmail payloads stay under the native 2 MiB HTTP cap by falling back to
  metadata and quarantining the message id so the cursor can still advance.
  Connect and reconnect vault writes are rolled back if the account row fails
  to persist.

## Gmail OAuth client ID

`EmailTriageGlobalSettings.gmailOAuthClientId` stores an optional installed-app client ID
(migration 30). When empty, desktop falls back to `VITE_GMAIL_OAUTH_CLIENT_ID` at build time
if present. Connect Gmail stays disabled until a client ID resolves. No client secret is stored
or transmitted from TrackDidia.

## GTD linkage

- Task `source`: `email_triage`
- Nullable `sourceUrl` on tasks
- Unique external id: `email-triage:<accountId>:<conversationKey>`

## Rollout order

1. Persistence, evaluation corpus, vault, mocked adapters (foundation slice)
2. **Gmail live adapter (this slice)**
3. Microsoft Graph, then Yahoo live adapters
4. Tray/autostart and automatic mutation after tests pass

See the full specification in [`specs/todo/email-triage.md`](../specs/todo/email-triage.md).
