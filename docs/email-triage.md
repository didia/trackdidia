# Email triage (foundation slice)

See also: [changelog](logs/email-triage.md).

TrackDidia ships a **disabled-by-default** local email triage foundation. This slice
persists accounts, conversations, classification metadata, reviews, desired effects, and
audit data; exposes OS-vault *commands* for a dedicated OpenRouter classifier key (nothing
writes a secret in this slice, so classification currently takes the `missing_api_key`
review path); runs mocked Gmail, Microsoft Graph, and Yahoo protocol adapters in tests;
and exposes a French UI for settings, account cards, and the review queue.

## Not shipped in this slice

- Live OAuth / IMAP mailbox connections
- Storing provider credentials or the triage API key from the UI (vault load/store
  commands exist, but have no settings form yet)
- Automatic provider mutation (global and per-account flags default off)
- System tray hide-on-close, autostart, or launch-at-login
- Historical import, sending, attachment inspection

## Architecture

- Subsystem: [`src/lib/email-triage/`](../src/lib/email-triage/)
- Domain types: [`src/domain/email-triage.ts`](../src/domain/email-triage.ts)
- SQLite migration `29_add_email_triage_foundation`
- Coordinator starts only after `AppProvider` bootstrap finishes successfully. Browser
  preview and the eight-second in-memory storage fallback both skip polling. Vault
  availability is probed only when the feature is enabled, using a read-only keychain
  check.
- Classifier body text is transient; raw MIME and bodies are never persisted.
  Reviews store subject/sender/received-at/source URL only. Body preview is not
  durable in this slice.
- Enabling triage or pausing/resuming an account from the page reconfigures the
  coordinator without restarting the app. Pagination reloads the saved cursor
  after each page, with a per-run page cap.

## GTD linkage

- Task `source`: `email_triage`
- Nullable `sourceUrl` on tasks
- Unique external id: `email-triage:<accountId>:<conversationKey>`

## Rollout order

1. Persistence, evaluation corpus, vault, mocked adapters (this slice)
2. Gmail, then Microsoft Graph, then Yahoo live adapters
3. Tray/autostart and automatic mutation after tests pass

See the full specification in [`specs/todo/email-triage.md`](../specs/todo/email-triage.md).
