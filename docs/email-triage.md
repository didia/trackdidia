# Email triage (Gmail + Microsoft Graph + Yahoo)

See also: [changelog](logs/email-triage.md).

TrackDidia ships a **disabled-by-default** local email triage subsystem. The foundation
slice persists accounts, conversations, classification metadata, reviews, desired effects,
and audit data. Live Gmail, Microsoft Graph, and Yahoo adapters sync on desktop. **Slice 5**
adds system-tray hide-on-close, launch-at-login, and gated automatic provider mutation.

Email persistence is exposed through `AppRepository.emailTriage`, whose
`EmailTriageStore` contract is implemented by the SQLite and in-memory stores.
The browser store remains non-persistent across reloads.

Review creation, resolution, dismissal, and GTD task changes use shared pure
planners. Every SQLite email mutation joins the repository writer queue and runs
in one transaction; composed operations reuse that transaction. Resolving a review
commits its decision, audit record, conversation version, message routing, GTD task,
and lifecycle events together. A failed write leaves the review pending and permits
a retry. The memory store restores its email and GTD maps on failure.

Message batches also commit messages and classification attempts together. Each
message requires one identity lookup before its upsert. Concurrent review decisions
still enforce the expected conversation version and compare-and-set errors.

## Shipped in this slice

### Screen layout

The triage screen shows notices as banners, then a settings panel grouped into Activation,
Application de bureau (desktop only), Classification, and Connexions et clés, followed by the
account cards (state badge plus provider/address/recovery metadata) and the review queue.
Styles are scoped under `.triage-page` in `src/styles.css`.

### Tray and launch-at-login (slice 5)

- Optional **run in tray**: when enabled, closing the main window hides it instead of
  quitting; **Quitter** in the tray menu exits the process
- Optional **launch at login** via `tauri-plugin-autostart` (macOS LaunchAgent)
- Settings persist in SQLite migration `32_add_email_triage_desktop_prefs` (`runInTray`,
  `launchAtLogin`)
- Browser preview: no tray, no autostart, no live provider mutation

### Gated automatic mutation (slice 5)

- Provider mutation remains **off by default** at global and per-account levels
- **Automatisation** and **Mutation fournisseur** are separate gates: a passing evaluation unlocks
  automation (`canEnableAutomation`) but does not turn it on; the user enables automation and
  mutation independently once evaluation matches persisted model/prompt/schema/thresholds
- Automatic markers run only when `canMutateProvider` passes: global `mutationEnabled` and
  `automationEnabled`, per-account `mutationEnabled`, account active/unpaused (not
  `gap_review_required`), and a **passed** evaluation matching the current model, prompt/schema
  version, corpus version, and thresholds
- The coordinator reloads the account (preserving the latest cursor) and recomputes
  `mutationEnabled` on each sync page and before every provider-marker effect
- Reconciliation drains a bounded batch of pending effects per run, honors effect
  dependencies, and verifies account generation plus conversation decision version
  immediately before and after `applyMarkers` (stale effects are superseded; a
  kill-switch leaves markers pending)
- Changing model, prompt/schema version, or thresholds clears `automationEnabled` until
  reevaluation; a failing evaluation also clears `automationEnabled`
- **Lancer l'évaluation** evaluates **persisted** settings only; the button is disabled while the
  settings draft differs from the last saved classifier/threshold values. Completing an
  evaluation refreshes evaluation state without discarding unrelated unsaved settings.
- Per-account mutation checkbox on account cards; review queue supports **Retirer de la file**
  (permanent dismiss: all pending reviews for that conversation, `routingState: dismissed`,
  no provider mutation)
- Tray and autostart preference apply failures surface independently and do not abort settings save

### Shared OAuth lifecycle

Gmail and Microsoft descriptors in `src/lib/email-triage/oauth/providers.ts`
supply authorization URLs, client-ID selection, profile identity, initial sync
state and error policies to one `connectOAuthAccount` path. It validates PKCE
state and reconnect identity/generation before credential persistence, then
schedules the account. Temporary bootstrap access tokens are cleared even when
a profile request fails.

`oauth/shared.ts` owns form-encoded token exchange/refresh, guarded JSON decoding,
credential serialization and address masking. Session and adapter orchestration
lives in `provider-session.ts`; the old Gmail session module remains a compatibility
export. Access tokens stay in memory, refresh credentials stay in the OS vault,
and Microsoft rotation preserves the stored scope. Provider-specific reconnect
and consent behavior is retained. These modules do not log credentials, codes,
verifiers or token responses.

### Multiple accounts per provider

Any number of accounts can be connected for each provider (for example several Gmail and
several Microsoft mailboxes). Accounts are identified by `(provider, providerAccountId)`; each has
its own vault credentials, sync cursor, generation, pause/mutation gates, and schedule. The
**Ajouter un compte …** buttons always start a new authorization:

- Gmail sends `prompt=select_account consent` and Microsoft `prompt=select_account`, so the provider
  shows its account chooser even when the browser is already signed in to another account
- Reconnecting an existing account passes its address as `login_hint` so the right account is
  preselected; a different account still fails with `reconnect_account_mismatch`
- Authorizing an address that is already connected refreshes that account in place (no duplicate) and
  the UI shows an `alreadyConnected` notice asking the user to pick another account

### Gmail (slice 2)

- Installed-app Google OAuth with `gmail.modify`, PKCE S256, system browser, and loopback
  callback handled in the Tauri host (`127.0.0.1` ephemeral port)
- Live Gmail adapter: baseline `historyId`, paginated `users.history.list`, inbox recheck,
  dedupe, label-only history ignored (including TrackDidia self-writes), expired-history
  recovery with inbox scan + replay, and message-level marker implementation

### Microsoft Graph (slice 3)

- Multitenant public-desktop OAuth with PKCE, system browser, loopback callback, and scopes
  `User.Read`, `Mail.ReadWrite`, `MailboxSettings.ReadWrite`, `offline_access`, `openid`, `profile`,
  `email`
- Live Graph adapter: first connect and invalid-delta reseed use inbox delta with
  `$filter=receivedDateTime ge {baselineAt}` (metadata-only `$select`, no `body`), paginated via
  `@odata.nextLink` until a real `@odata.deltaLink` arrives, per-message body fetch for
  classification, oversized message quarantine (tracked id, cursor still advances), immediate delta
  replay after snapshot, message-level Outlook categories, immutable IDs via
  `Prefer: IdType="ImmutableId"`, and `Prefer: odata.maxpagesize=25` on delta pages
- Microsoft reconnect preserves sync cursor (`baselineAt`, `deltaLink`, `nextLink`,
  `snapshotComplete`, `trackedMessageIds`) and ignores late OAuth completion when the account was
  disconnected during the loopback window (generation guard); stale tokens 410 into the filtered
  reseed path with the original `baselineAt`
- Azure AD refresh responses rotate the refresh token; TrackDidia persists the new value in the
  vault on every refresh
- `providerAccountId` is the Microsoft object ID (`/me.id`); display label uses
  `userPrincipalName` or `mail`
- Admin-consent-required tenant errors surface as a distinct French message (`AADSTS65001`), including
  loopback `error_description` values classified from authorization callbacks (never shown raw in UI)

### Yahoo (slice 4)

- IMAP over TLS to `imap.mail.yahoo.com:993` with a dedicated Yahoo **app password** stored in
  the OS vault (`kind: yahoo_app_password`); never the normal account password
- Tauri IMAP commands (`yahoo_imap_*`): discover, inbox fetch (`BODY.PEEK`), Message-ID search,
  mailbox ensure, MOVE / COPY + UID EXPUNGE (never mailbox-wide EXPUNGE)
- Baseline records durable `(UIDVALIDITY, highest UID)` without fetching existing mail; sync fetches
  UIDs `> cursorUid` in pages of 10 and reads UIDVALIDITY from each SELECT (no per-page discover);
  `providerMessageId` = `{uidvalidity}:{uid}`. Messages over the 2 MiB IMAP cap are quarantined
  (tracked id, no body sent to the classifier) so the cursor still advances.
- Conversation grouping via normalized RFC Message-ID aliases persisted in `email_triage_aliases`;
  Message-ID-less messages use stable `orphan:{uidvalidity}:{uid}` keys
- UIDVALIDITY change enters `gap_review_required` / `recoveryState: uidvalidity_changed` because
  UIDs in the new epoch are not an ordered continuation of the previous mailbox
- `sourceUrl` is null; review UI opens Yahoo Mail with copyable sender, subject, and receipt time
- IMAP LOGIN failure sets `reconnect_required` for that account only; Yahoo reconnect preserves
  sync cursor and uses the same generation guard as Gmail/Graph; verified COPY without UID EXPUNGE
  fails with `uidplus_unavailable` rather than leaving an Inbox duplicate
- Inline MIME body extraction prefers `text/plain` then HTML and skips `Content-Disposition:
  attachment` parts (and their descendants)

### Shared

- Refresh tokens stored in the OS vault per account; access tokens cached in memory only
- French UI: Connect / Reconnect / Disconnect, Sync now, advanced OAuth client IDs, triage key
  vault form, evaluation, tray/autostart, global/per-account mutation toggles
- OpenRouter classifier (temperature 0, no tools) when the triage vault key exists; otherwise
  the existing `missing_api_key` review path
- Coordinator wires live adapters when Tauri runtime + vault credentials exist (plus OAuth client
  IDs for Gmail/Microsoft)

## Product boundaries (not shipped)

- Cloud sync or multi-device conflict resolution
- Historical import, sending, attachment inspection
- Background execution after the desktop process exits (unless launch-at-login + tray keep it running)
- Restore-from-backup UI

## Architecture

- Subsystem: [`src/lib/email-triage/`](../src/lib/email-triage/)
- Domain types: [`src/domain/email-triage.ts`](../src/domain/email-triage.ts)
- Mutation gate: [`src/lib/email-triage/mutation-gate.ts`](../src/lib/email-triage/mutation-gate.ts)
- SQLite migrations `29_add_email_triage_foundation`, `30_add_email_triage_gmail_oauth_client_id`,
  `31_add_email_triage_microsoft_oauth_client_id`, and `32_add_email_triage_desktop_prefs`
- Tauri commands: `oauth_loopback_start`, `oauth_loopback_wait`, `provider_http_request`
  (HTTPS allowlist includes Google, Microsoft Graph/OAuth, and OpenRouter hosts),
  `yahoo_imap_discover`, `yahoo_imap_fetch_inbox`, `yahoo_imap_search_message_id`,
  `yahoo_imap_ensure_mailbox`, `yahoo_imap_move_uid`, `yahoo_imap_copy_uid`,
  `yahoo_imap_uid_expunge`, `email_triage_set_desktop_prefs`; plugins: opener, autostart,
  tray icon; system URLs open via `tauri-plugin-opener`
- Coordinator starts only after `AppProvider` bootstrap finishes successfully. Browser
  preview and the eight-second in-memory storage fallback both skip polling, OAuth, IMAP,
  vault writes, tray, autostart, and live mutation. Vault availability is probed only when
  the feature is enabled.
- Classifier body text is transient; raw MIME and bodies are never persisted.
  Reviews store subject/sender/received-at/source URL only. Body preview is not
  durable in this slice.
- Enabling triage or pausing/resuming an account from the page reconfigures the
  coordinator without restarting the app. Disable, pause, and disconnect also
  invalidate the in-flight account generation so later messages on an already
  fetched page are not classified or committed. Empty provider pages also skip
  cursor writes when sync is cancelled mid-page. Pagination reloads the saved
  cursor after each completed page, with a per-run page cap. A revoked provider
  grant (`invalid_grant`) moves that account to `reconnect_required`. Oversized
  Gmail, Graph, and Yahoo payloads stay under the native 2 MiB cap by quarantining
  the message id so the cursor can still advance. Connect and reconnect vault
  writes are rolled back if the account row fails to persist.

## OAuth client IDs

`EmailTriageGlobalSettings.gmailOAuthClientId` and `microsoftOAuthClientId` store optional
public client IDs (migrations 30–31). When empty, desktop falls back to `VITE_GMAIL_OAUTH_CLIENT_ID`
or `VITE_MICROSOFT_OAUTH_CLIENT_ID` at build time if present. Connect buttons stay disabled until
the matching client ID resolves. No client secret is stored or transmitted from TrackDidia.

## GTD linkage

- Task `source`: `email_triage`
- Nullable `sourceUrl` on tasks
- Unique external id: `email-triage:<accountId>:<conversationKey>`

See the implemented specification in [`specs/done/email-triage.md`](../specs/done/email-triage.md).
