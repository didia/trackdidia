# Email triage (Gmail + Microsoft Graph slices)

See also: [changelog](logs/email-triage.md).

TrackDidia ships a **disabled-by-default** local email triage subsystem. The foundation
slice persists accounts, conversations, classification metadata, reviews, desired effects,
and audit data. The **Gmail slice** adds live Gmail OAuth and synchronization on desktop.
The **Microsoft Graph slice** adds live Outlook / Microsoft 365 OAuth and inbox delta sync.
Yahoo remains a mocked protocol adapter.

## Shipped in this slice

### Gmail (slice 2)

- Installed-app Google OAuth with `gmail.modify`, PKCE S256, system browser, and loopback
  callback handled in the Tauri host (`127.0.0.1` ephemeral port)
- Live Gmail adapter: baseline `historyId`, paginated `users.history.list`, inbox recheck,
  dedupe, label-only history ignored (including TrackDidia self-writes), expired-history
  recovery with inbox scan + replay, and message-level marker implementation

### Microsoft Graph (slice 3)

- Multitenant public-desktop OAuth with PKCE, system browser, loopback callback, and scopes
  `Mail.ReadWrite`, `MailboxSettings.ReadWrite`, `offline_access`, `openid`, `profile`, `email`
- Live Graph adapter: one-shot `$deltatoken=latest` baseline on first connect (`baselineAt` +
  `@odata.deltaLink`, no historical inbox walk), paginated full snapshot only after invalid-delta
  reseed (preserving the original `baselineAt`), post-baseline filtering, delta-link storage only
  after complete snapshot, immediate delta replay, invalid-delta reseed from any cursor state,
  message-level Outlook categories, and immutable IDs via `Prefer: IdType="ImmutableId"`
- Microsoft reconnect preserves sync cursor (`baselineAt`, `deltaLink`, `nextLink`,
  `snapshotComplete`, `trackedMessageIds`); stale tokens 410 into the lossless reseed path
- Azure AD refresh responses rotate the refresh token; TrackDidia persists the new value in the
  vault on every refresh
- `providerAccountId` is the Microsoft object ID (`/me.id`); display label uses
  `userPrincipalName` or `mail`
- Admin-consent-required tenant errors surface as a distinct French message (`AADSTS65001`)

### Shared

- Refresh tokens stored in the OS vault per account; access tokens cached in memory only
- French UI: Connect / Reconnect / Disconnect Gmail and Microsoft, Sync now, advanced OAuth
  client IDs, dedicated triage OpenRouter key vault form with explicit copy-from-coach-key
- OpenRouter classifier (temperature 0, no tools) when the triage vault key exists; otherwise
  the existing `missing_api_key` review path
- Coordinator wires live adapters when Tauri runtime + vault credentials + client ID exist

## Still not shipped

- Live Yahoo connection
- Automatic provider mutation (global and per-account `mutationEnabled` remain off; coordinator
  passes `mutationEnabled: false`)
- System tray hide-on-close, autostart, or launch-at-login
- Historical import, sending, attachment inspection

## Architecture

- Subsystem: [`src/lib/email-triage/`](../src/lib/email-triage/)
- Domain types: [`src/domain/email-triage.ts`](../src/domain/email-triage.ts)
- SQLite migrations `29_add_email_triage_foundation`, `30_add_email_triage_gmail_oauth_client_id`,
  and `31_add_email_triage_microsoft_oauth_client_id`
- Tauri commands: `oauth_loopback_start`, `oauth_loopback_wait`, `provider_http_request`
  (HTTPS allowlist includes Google, Microsoft Graph/OAuth, and OpenRouter hosts); system URLs
  open via `tauri-plugin-opener`
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

## OAuth client IDs

`EmailTriageGlobalSettings.gmailOAuthClientId` and `microsoftOAuthClientId` store optional
public client IDs (migrations 30–31). When empty, desktop falls back to `VITE_GMAIL_OAUTH_CLIENT_ID`
or `VITE_MICROSOFT_OAUTH_CLIENT_ID` at build time if present. Connect buttons stay disabled until
the matching client ID resolves. No client secret is stored or transmitted from TrackDidia.

## GTD linkage

- Task `source`: `email_triage`
- Nullable `sourceUrl` on tasks
- Unique external id: `email-triage:<accountId>:<conversationKey>`

## Rollout order

1. Persistence, evaluation corpus, vault, mocked adapters (foundation slice)
2. Gmail live adapter
3. **Microsoft Graph live adapter (this slice)**
4. Yahoo live adapter
5. Tray/autostart and automatic mutation after tests pass

See the full specification in [`specs/todo/email-triage.md`](../specs/todo/email-triage.md).
