# Email triage (foundation slice)

TrackDidia ships a **disabled-by-default** local email triage foundation. This slice
persists accounts, conversations, classification metadata, reviews, desired effects, and
audit data; stores provider credentials and a dedicated OpenRouter classifier key in the
OS credential vault; runs mocked Gmail, Microsoft Graph, and Yahoo protocol adapters in
tests; and exposes a French UI for settings, account cards, and the review queue.

## Not shipped in this slice

- Live OAuth / IMAP mailbox connections
- Automatic provider mutation (global and per-account flags default off)
- System tray hide-on-close, autostart, or launch-at-login
- Historical import, sending, attachment inspection

## Architecture

- Subsystem: [`src/lib/email-triage/`](../src/lib/email-triage/)
- Domain types: [`src/domain/email-triage.ts`](../src/domain/email-triage.ts)
- SQLite migration `29_add_email_triage_foundation`
- Coordinator starts after normal `AppProvider` bootstrap, outside the eight-second storage
  fallback; browser preview disables vault access and polling
- Classifier body text is transient; raw MIME and bodies are never persisted

## GTD linkage

- Task `source`: `email_triage`
- Nullable `sourceUrl` on tasks
- Unique external id: `email-triage:<accountId>:<conversationKey>`

## Rollout order

1. Persistence, evaluation corpus, vault, mocked adapters (this slice)
2. Gmail, then Microsoft Graph, then Yahoo live adapters
3. Tray/autostart and automatic mutation after tests pass

See the full specification in [`specs/todo/email-triage.md`](../specs/todo/email-triage.md).
