# Email triage (Gmail + Microsoft Graph + Yahoo slices)

See also: [changelog](logs/email-triage.md).

TrackDidia ships a **disabled-by-default** local email triage subsystem. The foundation
slice persists accounts, conversations, classification metadata, reviews, desired effects,
and audit data. The **Gmail slice** adds live Gmail OAuth and synchronization on desktop.
The **Microsoft Graph slice** adds live Outlook / Microsoft 365 OAuth and inbox delta sync.
The **Yahoo slice** adds live Yahoo IMAP synchronization on desktop via app password.

## Shipped in this slice

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
- French UI: Connect / Reconnect / Disconnect Gmail, Microsoft, and Yahoo, Sync now, advanced OAuth
  client IDs, dedicated triage OpenRouter key vault form with explicit copy-from-coach-key
- OpenRouter classifier (temperature 0, no tools) when the triage vault key exists; otherwise
  the existing `missing_api_key` review path
- Coordinator wires live adapters when Tauri runtime + vault credentials exist (plus OAuth client
  IDs for Gmail/Microsoft)

## Still not shipped

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
  (HTTPS allowlist includes Google, Microsoft Graph/OAuth, and OpenRouter hosts),
  `yahoo_imap_discover`, `yahoo_imap_fetch_inbox`, `yahoo_imap_search_message_id`,
  `yahoo_imap_ensure_mailbox`, `yahoo_imap_move_uid`, `yahoo_imap_copy_uid`,
  `yahoo_imap_uid_expunge`; system URLs open via `tauri-plugin-opener`
- Coordinator starts only after `AppProvider` bootstrap finishes successfully. Browser
  preview and the eight-second in-memory storage fallback both skip polling, OAuth, IMAP,
  and vault writes. Vault availability is probed only when the feature is enabled.
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

## Rollout order

1. Persistence, evaluation corpus, vault, mocked adapters (foundation slice)
2. Gmail live adapter
3. Microsoft Graph live adapter
4. **Yahoo live adapter (this slice)**
5. Tray/autostart and automatic mutation after tests pass

See the full specification in [`specs/todo/email-triage.md`](../specs/todo/email-triage.md).
