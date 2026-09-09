# Multi-account email triage

**Status:** Implemented

This specification describes the shipped email triage feature. For canonical
runtime documentation see [`docs/email-triage.md`](../../docs/email-triage.md).

## Goal

Let a local TrackDidia desktop app collect new mail from selected Gmail, Microsoft
365/Outlook, and Yahoo accounts; classify each message with the user's AI
assistant; and make the decision visible and reversible:

- Relevant mail creates or updates one GTD task in TrackDidia's Inbox and is
  marked `Trackdidia-Inbox` in the mail provider.
- Uninteresting mail receives the base `Trackdidia-Triage-Ignore` marker plus a
  reason marker.
- Uncertain, unsafe, failed, or consequential decisions enter a review queue and
  make no mailbox or GTD change until the user decides.

Initial supported accounts are Microsoft 365 School and Advanceo, Gmail Personal
and didia.me, and Yahoo Personal. The system is local-first and best-effort: it
polls while TrackDidia is running or hidden in the system tray, and stops when the
app explicitly quits, the computer shuts down, or the user logs out.

## Product boundaries

- No cloud backend, historical import, sending, deleting, attachment inspection,
  remote-content fetching, or background execution after the desktop process exits.
- Each connected account starts with a server-side baseline. Only mail arriving
  after that baseline is eligible; existing mail is never classified or mutated.
- Poll every five minutes by default, configurable from five to sixty minutes.
- Classifier body text is transient. Do not persist raw MIME, body text, inline
  images, remote content, or attachments. Derived metadata, summaries, rationale,
  task text, and audit data may be stored locally and appear in backups.
- Store provider credentials and the dedicated triage API key in the operating
  system credential vault only. Access tokens stay in memory. If the vault is not
  available, email integration is disabled rather than falling back to SQLite.

## Classification and safety

Use a dedicated OpenRouter classifier with a separate vault-backed key, model,
prompt/schema version, timeout, and temperature `0`. Do not migrate or clear the
existing coach key in settings; offer an explicit copy into the triage vault entry.

The classifier receives bounded, sanitized, explicitly delimited untrusted email
data and has no tools or URL access. It must return strict JSON with only:

```json
{
  "decision": "relevant | ignore | review",
  "relevance": "action_required | information_to_retain | null",
  "ignoreReason": "newsletter | promotion | automated_notification | receipt_or_confirmation | social_update | spam_or_suspicious | low_value_fyi | other | null",
  "confidence": 0,
  "summary": "string",
  "rationale": "string",
  "suggestedTaskTitle": "string"
}
```

Reject unexpected fields, conflicting cross-fields, invalid enums, malformed JSON,
and excessive output. Enforce 500-character subject, 180-character task title,
500-character summary/rationale, 50 normalized recipient addresses, 12,000 cleaned
body characters, and a 16 KiB complete classifier payload. Prompt-injection text is
a review signal.

Automatic routing thresholds are 0.80 for Relevant and 0.90 for Ignore. Confidence
is a heuristic, not a measured probability. Would-be Ignore decisions involving
financial, legal, medical, security, credentials, account access, urgency, or other
consequential ambiguity must go to review. High-confidence relevant mail may enter
Inbox automatically.

Before automatic mutation is enabled for a model/prompt pair, run a packaged,
mutation-free regression corpus. It requires 100% valid schema output, no relevant
or safety case marked Ignore, and at least 90% exact expected routing. Persist model,
prompt/schema version, corpus version, thresholds, date, and result. Changing any
material component disables automation until reevaluation.

## Provider-specific behavior

### Gmail

Use installed-app OAuth with `gmail.modify`, a system browser, loopback callback,
and PKCE. Baseline by durably recording the current Gmail `historyId`, then activate
without listing or classifying existing mail. Fully paginate `users.history.list`,
consider genuine `messagesAdded` only, recheck current Inbox eligibility, deduplicate
by Gmail message ID, and ignore label-only history including TrackDidia's own writes.
Persist each page before advancing the cursor.

On an expired history cursor, record a recovery-start history ID, fully scan eligible
Inbox mail after the last confirmed watermark, persist progress, replay history from
that point, and require continuous coverage before returning active. Otherwise use
the visible `gap_review_required` state.

Apply markers only to tracked post-baseline message IDs, never whole threads:

- Relevant: `Trackdidia-Inbox`
- Ignore base: `Trackdidia-Triage-Ignore`
- Ignore reason: `Trackdidia-Triage-Ignore/<reason>`

Preserve unrelated labels and remove only obsolete TrackDidia labels. Use an
account-aware thread URL when safe, otherwise an account-aware Gmail search fallback.

### Microsoft Graph / Outlook

Use delegated public-desktop authorization-code OAuth with PKCE, system browser,
loopback callback, immutable message IDs, and `Mail.ReadWrite`,
`MailboxSettings.ReadWrite`, `offline_access`, `openid`, `profile`, and `email`.
`MailboxSettings.ReadWrite` permits creation of Outlook master categories.

Synchronize the Inbox with Graph delta. During baseline, record `baselineAt`, consume
all `@odata.nextLink` pages, discard snapshot mail on or before the baseline while
retaining later arrivals, persist each page, store the final delta link only after the
complete snapshot, then replay it immediately until caught up. An invalid delta token
uses the same complete reseed-and-replay approach; never replace a cursor from a
bounded subset. Unprovable coverage becomes gap review.

Apply message-level categories while preserving unrelated categories and retrying
after a current-value refetch when there is a concurrency conflict:

- Relevant: `Trackdidia-Inbox`
- Ignore base: `Trackdidia-Triage-Ignore`
- Ignore reason: `Trackdidia-Triage-Ignore:<reason>`

Use Graph's stored `webLink` as the primary message link.

#### Microsoft registration, consent, and end-user flow

TrackDidia is registered once by its developer/distributor as a **multitenant public
desktop application** and ships that public client ID. An ordinary user does not need
Entra admin access, does not visit the Entra admin center, and does not register an
app for each school, employer, or mailbox. They select **Connect Microsoft**, sign in
to the desired mailbox, and grant delegated access limited to that signed-in mailbox.

`Mail.ReadWrite` and `MailboxSettings.ReadWrite` normally permit user consent for
delegated access. A tenant can block user consent or require administrator approval;
when Microsoft displays a need-admin-approval result, an administrator must approve
the app and there is no legitimate bypass. Failure to connect one organization must
not disable Gmail, Yahoo, or another Microsoft account.

Offer an advanced **bring your own public client ID** configuration only for
development or self-hosting. It is not part of ordinary setup. Public desktop clients
use no client secret.

### Yahoo

Use IMAP over TLS on port 993 with a dedicated Yahoo app password, never the normal
account password. Discover namespace, delimiter, Inbox identity, MOVE, UIDPLUS, and
UID-targeted-expunge support. Baseline using a durable `(UIDVALIDITY, highest UID)`;
do not present a local timestamp as a coverage guarantee.

Create `Trackdidia-Inbox`, `Trackdidia-Triage-Ignore`, and
`Trackdidia-Triage-Ignore<delimiter><reason>`. Mutation requires either MOVE with
recoverable destination identity, or verified COPY with persisted destination identity
followed by UID-targeted source expunge. Never issue mailbox-wide EXPUNGE. Reconcile
ambiguous crashes through Message-ID and destination evidence before retrying.

Use normalized RFC Message-ID aliases and known `References`/`In-Reply-To` links for
conversations. Missing or ambiguous links create a separate conversation or a review;
never group by subject, participants, or time alone. On UIDVALIDITY change, fully
recover from the last confirmed watermark and require continuous coverage, otherwise
enter gap review. Yahoo has no dependable universal message URL: open Yahoo Mail with
copyable sender, subject, and receipt-time search details.

## Data, synchronization, and effects

Add a focused `src/lib/email-triage/` subsystem and append-only SQLite migrations for
accounts, sync/recovery state, conversations, aliases, messages, classification
attempts, reviews, evaluations, desired effects, and audit events. Add `email_triage`
task provenance, a nullable `sourceUrl`, and a unique
`email-triage:<accountId>:<conversationKey>` external ID to prevent duplicate tasks.

Every account has a local UUID and unique `(provider, providerAccountId)`. Every
conversation has increasing `decisionVersion`; messages are unique by account and
provider message ID. A desired effect includes account generation, conversation ID,
decision version, target message IDs, dependencies, and a deterministic deduplication
key.

For each provider page: fetch without mutation; deduplicate and determine eligibility;
sanitize and classify transiently; atomically persist messages, attempts, conversation
version changes, review/effect records, and page progress; then reconcile effects
outside the transaction. Cursor progress may advance once each event has durable review
or desired-effect state, not only once external mutation succeeds.

Serialize effects per conversation. Verify account generation, enabled state, and the
current decision version before and after external requests; supersede older effects.
If a stale request completed, audit it and reconcile immediately toward current state.
Review resolution uses compare-and-set on the expected version. Disable/disconnect
blocks new requests and follow-up effects, but completed in-flight work remains auditable.
Review itself never mutates a provider or task.

For Relevant, first atomically create/link/update the GTD task and normal lifecycle
events; then permit the provider marker. Reuse lifecycle event builders, avoid nested
SQLite transactions, and never perform provider network requests in a SQLite
transaction. Implement all repository contract changes in both SQLite and
MemoryRepository; browser preview must clearly disable real connection and polling.

## GTD ownership rules

- One account/provider conversation owns one TrackDidia task.
- First relevant mail creates an Inbox task; later replies update it.
- A later automatic Ignore cannot downgrade a relevant conversation; it enters review.
- A later relevant reply can upgrade an ignored conversation.
- Preserve active user-selected bucket, project, contexts, schedule, and deadline.
- A completed task reopens as the same Inbox task on later relevant mail without a
  duplicate creation event; audit the reopen.
- A cancelled task and missing/corrupt linkage enter review rather than reopening or
  duplicating.
- Update a generated title only if it still equals the last generated title. Maintain a
  hash/revision-delimited managed note section; if users alter/remove it, preserve all
  notes and expose new summaries through metadata or review. Always update `sourceUrl`.
- Manual Ignore requires a reason. If it has an active generated task, require
  confirmation and cancel the task; never delete task history.

## Runtime and user experience

Start an independent coordinator after normal application bootstrap, outside the
existing eight-second storage fallback. It has per-account mutexes, failure isolation,
exponential backoff with jitter, provider retry-hint support, resume/network-recovery
catch-up, and stale-effect recovery at startup. Backup and email locks remain separate.

Provide a French UI with account cards (provider, label, masked address, state, last
success, recovery state, error, pause/reconnect/disconnect/Sync now); settings for
polling, thresholds, model/evaluation, global/per-account enablement, tray, and
launch-at-login; a redacted audit; and a review queue. The review queue supports an
on-demand discarded sanitized-body preview, safe link/search action, Relevant, Ignore
with required reason, and Leave for later. Distinguish pending task/provider work,
retryable/permanent failure, reconnect-required, and cursor-gap states.

Use supported Tauri system-tray, autostart, and opener capabilities. Closing hides
only when run-in-tray is enabled; explicit Quit terminates the process.

## Delivery, testing, and rollout

Roll out disabled by default in this order: persistence/evaluation/vault/mocked
adapters; Gmail; Microsoft Graph; Yahoo; then tray/autostart and automatic mutation.
Keep provider mutation disabled until baseline/recovery, version races, GTD ownership,
and desired-effect tests pass. Include global and per-account pause controls.

Test schema and thresholds; hostile/oversized sanitization; non-persistence of bodies;
repository/migration parity; complete pagination, crashes, and cursor invalidation for
each provider; Gmail self-label history; Graph category concurrency; Yahoo MOVE/COPY
recovery and UIDVALIDITY; conversation/task races; user edits/completion/cancellation;
stale review/effect races; disable while in flight; lifecycle atomicity; secret/body
redaction; French UI/accessibility; and tray close/hide/Quit/autostart. Manual
acceptance must cover all five accounts, pre-baseline exclusion, relevant/ignore/review
examples, failure/revocation scenarios, restart during pagination, and inspection of
SQLite/backups/logs for forbidden body or secret persistence.

When implementation ships, update the appropriate canonical architecture, storage,
GTD, AI/privacy, and desktop-build documentation and their domain logs. Do not claim
these behaviors in `docs/` before then.

## Manual setup

### Developer/release setup

1. Register one multitenant public desktop application in a developer-controlled
   Microsoft Entra tenant; configure loopback/system-browser OAuth and delegated
   Microsoft Graph permissions. Ship its public client ID; never ship a client secret.
2. Create a Google Cloud project, enable Gmail API, configure consent, create a Desktop
   OAuth client, request `gmail.modify`, and complete any Google verification needed
   for intended distribution.
3. Package the evaluation corpus, secure-vault integration, and provider configuration
   defaults. Provide a privacy disclosure covering transient email classification and
   locally stored derived data.

### End-user setup

1. Select Connect Microsoft, sign in to each desired School or Advanceo mailbox, and
   approve delegated access if tenant policy allows it. If admin approval is required,
   request it from that organization; no Entra portal action by the end user can bypass
   the policy.
2. Connect Gmail Personal and didia.me separately and verify the chosen Google account
   each time. External apps in Google testing may require reconnection as Google tokens
   can expire under its testing policy.
3. Enable Yahoo IMAP as needed, create a dedicated app password, connect on IMAP TLS
   port 993, and verify TrackDidia can safely create its target folders.
4. Add/copy a dedicated OpenRouter triage key to the vault, choose a structured-output
   model and spending controls, run the evaluation corpus, review thresholds, choose a
   poll interval, and optionally enable tray/autostart.
5. Confirm all accounts finish baselining without processing existing mail. Send manual
   acceptance messages before enabling automatic Ignore. Test credential revocation:
   only the affected account should become reconnect-required. Treat every cursor-gap
   warning as requiring audit/review.
