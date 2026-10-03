# Finance (household money tracking and budgeting)

See also: [changelog](logs/finance.md).

TrackDidia is building a household finance domain: CSV transaction import, a
learning categorization loop, multi-person/multi-account tracking, and (in later
phases) YNAB-style envelope budgeting and proactive runout forecasting. This page
documents **Phase 2 — Schema and repository parity** (the SQLite schema, the
`FinanceSqliteStore`/`FinanceMemoryStore` persistence layer, and the
`AppRepository` contract) and **Phase 3 — Accounts, import, and transaction
screens** (the first finance UI). There is still no classification pipeline and
no budget arithmetic — see [specs/todo/finance.md](../specs/todo/finance.md) for
the full phased plan.

The feature is **unshipped to end users by default**: `AppSettings.financeEnabled`
defaults to `false`. With it off, the sidebar has no "Finances" entry and
`/finances*` redirects to `/`. A household that turns it on in Settings gets
the four screens documented in "Screens" below; later phases (classification,
budget, reports, forecasting) are not built yet. This page describes what the
storage layer and the UI can do today so later phases (and reviewers) have a
canonical reference.

## Data model

All finance tables are prefixed `finance_`, created in one migration
(`37_add_finance_foundation`, purely additive — see
[storage-and-backups.md](storage-and-backups.md#finance-tables)). Ids are
client-generated TEXT primary keys via `createEntityId("finance-account")` etc.,
matching existing entity conventions. Dates are local `YYYY-MM-DD`; timestamps are
ISO strings from `nowIso()`.

- **`finance_people`** — household members. Accounts carry an optional
  `owner_person_id` and `ownership` (`individual` | `joint`); transactions carry an
  optional `person_id`.
- **`finance_accounts`** — `type` (`checking`, `savings`, `cash`, `credit_card`,
  `line_of_credit`, `loan`, `mortgage`, `investment`, `asset`, `other`), `currency`,
  `on_budget`, `closed`, `opening_balance_minor`, and a nullable unique
  `external_key` binding an imported file's account label to this account.
  Balances are always **derived** (`opening_balance_minor` + Σ transactions);
  `current_balance_minor` is a reconciliation check only.
- **`finance_categories`** — `kind` (`expense` | `income` | `transfer` | `internal`),
  `parent_id` (null = a category group), `is_system`. The three system categories —
  `fincat:non-categorise` (expense), `fincat:transfert` (transfer), `fincat:split`
  (internal) — are inserted by the migration itself because engine code
  hard-references their ids.
- **`finance_transactions`** — amount in minor units (never floats), `currency`,
  `category_source` (`user` | `rule` | `memory` | `seed` | `ai` | `default`),
  `is_transfer`/`transfer_group_id`, `excluded_from_budget`/`excluded_from_reports`,
  `has_splits`, `import_batch_id`, and `dedupe_hash`. `UNIQUE(account_id,
  dedupe_hash)` is what makes re-importing a file a no-op. **`category_source =
  'user'` is never touched by any automatic stage** — this is the invariant that
  makes the learning loop trustworthy.
- **`finance_transaction_splits`** — a transaction's amount split across
  categories; the parent's `category_id` becomes `fincat:split` and is never
  counted by reports. The engine (not a DB constraint) is responsible for keeping
  `Σ split.amount_minor == parent.amount_minor`.
- **`finance_rules`**, **`finance_merchant_memory`**, **`finance_category_suggestions`**
  — the classification pipeline's inputs and pending-review queue (classification
  itself ships in Phase 4). A partial unique index keeps at most one pending
  suggestion per transaction.
- **`finance_import_profiles`**, **`finance_import_batches`** — saved column-mapping
  profiles (unique by header signature) and one row per import run.
- **`finance_budget_entries`**, **`finance_budget_months`**,
  **`finance_recurring_series`**, **`finance_account_balance_snapshots`** — schema
  ships now for later phases (budget, recurring-bill detection, net worth); no
  arithmetic reads or writes them yet.

## Default category taxonomy

`src/lib/finance/default-categories.ts` holds a deterministic French taxonomy with
fixed ids (`fincat:alimentation`, `fincat:alimentation.epicerie`, …), distinct from
the three system categories above. `AppRepository.seedFinanceDefaultCategories()`
seeds it idempotently (`INSERT OR IGNORE`, so re-running is always a no-op) on both
repositories. No caller invokes it yet; a later phase gates the call on
`AppSettings.financeCategoriesSeededAt`, the same one-time-marker pattern as the GTD
normalizations in `app-context.tsx`.

## Settings

`AppSettings` carries the finance flags (all defaulted in `defaultAppSettings()`,
merged by `mergeAppSettingsWithDefaults` so existing settings rows pick them up
automatically — no migration needed):

| Field | Default | Purpose |
|---|---|---|
| `financeEnabled` | `false` | Master feature flag; later phases gate the nav entry and bootstrap work on this |
| `financeBaseCurrency` | `"CAD"` | Single base currency for cross-account rollups |
| `financeAiCategorizationEnabled` | `false` | Gates the AI classification stage (Phase 8) |
| `financeAiAutoApplyEnabled` | `false` | Whether an AI suggestion can auto-apply |
| `financeAiAutoApplyMinConfidence` | `0.9` | Confidence floor for AI auto-apply |
| `financeAlertsOnToday` | `true` | Shows the runout-forecast card on Today (Phase 7) |
| `financeCoachContextEnabled` | `false` | Adds a compact finance snapshot to the coach payload (Phase 7) |
| `financeNotifyRunout` | `true` | Desktop notification for a runout alert (Phase 7) |
| `financeSafetyBufferMinor` | `0` | Minor-unit floor for cash-runout forecasting (Phase 7) |
| `financeCategoriesSeededAt` | `""` | One-time marker for the default taxonomy seed |

## Repository contract

`FinanceSqliteStore` (`src/lib/storage/finance-sqlite-store.ts`) and
`FinanceMemoryStore` (`src/lib/storage/finance-memory-store.ts`) back
`TauriSqliteRepository` and `MemoryRepository` respectively, reached through thin
delegating methods (`getFinanceStore()`), mirroring the email triage pattern
(`getEmailTriageStore()`). Both stores implement the same methods and the same
business rules; `repository.contract.ts`'s `finance` block runs identical
assertions against both.

Covered in this phase: people, accounts, categories (including the default-taxonomy
seed and archive-with-reassign), rules, merchant memory, transactions (including
splits and transfers), import profiles/batches, transaction import with undo, and
the category-suggestion queue. **Not** covered yet (later phases): any `compute*`
report/forecast method, recurring-series detection/storage, budget state, balance
snapshots, or AI suggestion generation — these remain unimplemented on both
repositories until their respective phase.

### Learning entry point

`setFinanceTransactionCategory({ transactionId, categoryId, scope })` is the single
place that writes a user correction:

- Always sets `category_id`, `category_source = 'user'`, `categorized_at` on the
  target transaction.
- `scope: "all_matching"` also recategorizes every other transaction sharing the
  same `merchant_key` whose `category_source !== 'user'`, and reports how many rows
  changed. A `scope: "this"` or `"this_and_future"` call never touches other rows
  (`"this_and_future"`'s future-matching behavior is a later-phase classification
  concern; today both are equivalent to `"this"`).
- Upserts `finance_merchant_memory` for `(merchant_key, account_id, sign)` via the
  pure `applyMerchantMemoryCorrection` in `src/lib/finance/memory.ts`: on agreement
  with the existing entry, `hit_count += 1` and confidence nudges up (capped at
  `0.99`); on disagreement, the category is replaced, `correction_count += 1`, and
  confidence resets to `0.6` so one correction does not immediately become an
  auto-apply.

`decideFinanceCategorySuggestion` routes an `accepted`/`corrected` decision through
this same entry point, so accepting a suggestion reinforces memory exactly like a
manual edit.

### Import

`importFinanceTransactions(input)` takes already-mapped rows (CSV parsing and
column mapping are Phase 1/3 concerns; see `src/lib/finance/csv.ts` and
`import-profile.ts`) and, in **one** write:

1. Computes each row's `occurrenceIndex` (`assignOccurrenceIndices`) and 128-bit
   `dedupeHash` (`src/lib/finance/hash.ts`), then inserts in chunks of ≤ 200 rows
   per `INSERT … VALUES (…),(…) ON CONFLICT(account_id, dedupe_hash) DO NOTHING`,
   counting the difference between attempted and inserted rows as duplicates.
2. Runs the near-duplicate pass (`src/lib/finance/near-duplicates.ts`) between this
   batch's new rows and every other existing row in the same accounts — including
   manually entered rows, whose `import_batch_id` is `NULL` rather than some other
   batch's id — reporting matches in the summary without merging or dropping
   anything.
3. Runs transfer detection (`src/lib/finance/transfers.ts`) across the **entire**
   transaction history (not just the batch), applying matched-pair and
   probable-transfer outcomes and writing a pending suggestion wherever the pure
   engine says one is owed. **A transaction whose `category_source = 'user'` is
   excluded from the candidate set entirely** — it can be neither paired as a
   transfer leg nor relabeled by a keyword match, in both `FinanceSqliteStore` and
   `FinanceMemoryStore`. This is the same invariant as the learning entry point
   below, just enforced at the import step too.
4. Writes one `finance_import_batches` row and returns a `FinanceImportSummary`
   (`batchId`, counts, `transfersDetected`, `pendingSuggestions`, `warnings`,
   `nearDuplicates`).

On `TauriSqliteRepository`, the whole call is one `runExclusive` block issuing a
single `BEGIN IMMEDIATE`/`COMMIT` inside `FinanceSqliteStore.importTransactions` —
it never calls another queue-taking repository method, so it cannot deadlock
`DbSerialQueue`. A 5,000-row import completes inside this one block (see
`repository.contract.ts`'s "imports 5 000 rows" test).

New rows land as `category_id = 'fincat:non-categorise'`, `category_source =
'default'` before transfer detection runs; a `categoryHint` on the row (from, e.g.,
a Mint CSV's `Category` column) is accepted on the request shape but ignored by
this phase — the full classification pipeline (rules → transfer detection →
merchant memory → seed heuristics → AI → default) is Phase 4.

### Undo

`undoFinanceImportBatch(batchId)` is **restricted to the most recent batch for that
batch's account** — if a later batch for the same account exists, the call throws
rather than silently doing nothing, because that later batch may have deduped
against a row this undo would otherwise delete. It deletes a batch row's splits and
**all** of its category suggestions (pending or already decided — a deleted
transaction cannot leave an orphaned suggestion behind), repairs the transfer
group of a surviving partner (clearing
`is_transfer`/`transfer_group_id`, restoring a pending suggestion so the partner
does not silently fall out of the budget), and **refuses to delete any row whose
`category_source = 'user'`** — those rows are counted in `refusedUserCategorized`
and left exactly as they were, with their `import_batch_id` intact.

## Screens (Phase 3)

### Flag gating

`AppSettings.financeEnabled` gates everything in this section:

- `AppShell`'s nav list supports a per-entry `flag` naming an `AppSettings`
  boolean; the "Finances" entry (`/finances`) carries `flag: "financeEnabled"`
  and disappears from the sidebar when the flag is false.
- `/finances/*` is always registered in `App.tsx` — a `FinanceRoutes` element
  reads `settings.financeEnabled` from `useAppContext()` and renders
  `<Navigate to="/" replace />` instead of its child routes while the flag is
  off, so a stale bookmark or deep link lands on Today rather than 404ing.
- Turning the flag on (in `SettingsPage`'s new "Finances" section, or by any
  other writer of `AppSettings`) does not retroactively create accounts or
  transactions — it only seeds the default category taxonomy once (see
  "Enabling the flag seeds categories" below) and reveals the nav entry and
  routes.

Settings also exposes `financeBaseCurrency` next to the toggle. The AI,
alerts/coach, and notify-runout flags from the Phase 2 table are **not** shown
in Settings yet — they are no-ops until the phases that read them (4, 7, 8)
ship, and showing a checkbox with no effect would be misleading.

### Enabling the flag seeds categories

The default French category taxonomy (`seedFinanceDefaultCategories()`, see
"Default category taxonomy" above) is seeded exactly once, gated on
`AppSettings.financeCategoriesSeededAt` being empty, from two independent
call sites that race harmlessly because the seed is `INSERT OR IGNORE`:

- `SettingsPage`: saving the finance section with `financeEnabled` flipped
  false → true calls `repository.seedFinanceDefaultCategories()` before
  `saveSettings`, then persists the marker in the same save.
- `AppProvider`'s boot sequence: if `financeEnabled` is already true and the
  marker is still empty (e.g. a settings row written by another path, or a
  fresh desktop install with the flag pre-set), the boot sequence seeds and
  sets the marker as one more idempotent startup step. The call is wrapped in
  its own `try`/`catch` and logs only a row count — a seeding failure is
  swallowed rather than thrown, so it can never become a new way to trip the
  eight-second startup timeout.

### Routes and shared tab bar

| Route | Screen |
|---|---|
| `/finances` | `FinanceOverviewPage` — minimal account list with derived balances and links to the other screens; a fuller dashboard (net worth, cash flow, trends) is Phase 6 |
| `/finances/transactions` | `FinanceTransactionsPage` |
| `/finances/import` | `FinanceImportPage` |
| `/finances/accounts` | `FinanceAccountsPage` |

Every `/finances*` page renders `FinanceTabs`
(`src/components/finance/FinanceTabs.tsx`), a shared in-page nav bar. It only
lists tabs for screens that exist today (Overview, Transactions, Import,
Accounts); Budget, Reports, and Review have no tab until their phases ship —
adding a tab that 404s or redirects would be worse than omitting it.

### FinanceAccountsPage (`/finances/accounts`)

CRUD for both household members (`finance_people`: add, archive/unarchive —
there is no hard delete) and accounts (`finance_accounts`: name, institution,
type, currency, owner person, ownership, on-budget toggle, opening balance as
of a date, an optional manual balance for reconciliation, close/reopen).

Each account's derived balance (opening balance + Σ its transactions) is
computed by the pure `computeDerivedBalanceMinor` in
`src/domain/finance/account-balance.ts` (tested directly, no repository
involved) and shown next to every account. When the account also carries a
manual `currentBalanceMinor` (entered as a reconciliation check, typically for
an `asset`/`investment` account with no transaction feed), the sibling pure
function `computeReconciliationDiscrepancy` compares the two and the page
shows a discrepancy banner whenever they disagree.

### FinanceImportPage (`/finances/import`)

1. A "take a manual backup first" notice with a one-click manual backup button
   (desktop only) — undo only covers the most recent import batch per
   account, so an earlier mistake is not recoverable through the UI alone.
2. `<input type="file" accept=".csv,text/csv" multiple>`. Each selected file's
   bytes are read with `FileReader` (not `File.arrayBuffer()`/`File.text()`,
   which jsdom — this app's Testing Library environment — does not
   implement) and decoded by `decodeCsvBytes` in
   `src/lib/finance/import-request.ts`: UTF-8 first, and if that decode
   contains a replacement character (U+FFFD), a second pass re-decodes the
   same bytes as windows-1252 (lossless for any byte sequence) and the page
   shows a banner telling the user the file was re-read. `parseCsv` (Phase 1)
   then turns the decoded text into a header and rows.
3. Profile auto-detection: `buildHeaderSignature(header)` is compared against
   every saved `FinanceImportProfile` and against the bundled `MINT_PROFILE`;
   a match pre-fills the column map, date format, and amount mode. No match
   falls back to an empty column map, `single_signed` amount mode, and a
   best-effort date-format guess from `inferDateFormat` over the first 20
   rows (the mapping UI shows a banner when that guess is ambiguous).
4. A mapping form lets the user remap every column (date, description,
   original description, amount — as a single signed column, debit/credit
   columns, or amount + transaction-type column — account, category hint,
   notes, labels) and the date format, with a first-20-row raw preview table
   underneath.
5. Account binding: when the profile maps an account column, the page lists
   every distinct value seen in that column in the file and lets the user
   bind each one to an existing account or create a new one inline. A newly
   created account's `external_key` keeps only the last 4 characters when the
   bound label looks like an account number (6+ digits), e.g. `****1234`,
   matching the "mask like a dedupe hash, not a full account number" posture
   elsewhere in the app. When the profile has no account column, a single
   "this file is one account" dropdown is used instead.
6. The profile (with the user's final mapping) is saved via
   `saveFinanceImportProfile` before import, and the mapped rows are built by
   the pure `buildImportRequest`/`buildImportRows` in
   `src/lib/finance/import-request.ts` (tested directly): rows that fail to
   map (bad date/amount/description) or whose account cannot be resolved are
   collected as errors rather than thrown, and reported in the result panel
   instead of aborting the whole import.
7. `repository.importFinanceTransactions(request)` runs the Phase 2 pipeline;
   the result panel shows imported/duplicates/skipped/errors/new
   accounts/transfers-detected counts, the near-duplicate list (similarity and
   date-diff per match), and any parse warnings.
8. A batch history list (`listFinanceImportBatches`) shows every past import
   with its counts. Undo is offered only on the most recent batch **per
   account** (computed client-side from the newest-first batch list), matching
   the repository's own restriction; a refused-rows count from a partially
   refused undo (rows with `category_source = 'user'`) is surfaced as a
   banner.

### FinanceTransactionsPage (`/finances/transactions`)

A paged (25 per page), filtered (date range, account, category, person, free
text search, uncategorized-only) transaction list. Each row supports:

- Inline category edit via `setFinanceTransactionCategory`, with a
  per-row scope selector (`this` / `this_and_future` / `all_matching`) that
  is read at edit time — there is no separate "apply" step.
- A split editor (`FinanceTransactionSplit[]`) with client-side sum-invariant
  validation: saving is rejected unless every split amount parses and the
  splits sum to exactly the parent transaction's `amountMinor`, matching the
  invariant the repository documents but does not itself enforce.
- Mark/unmark transfer: unmarking calls `clearFinanceTransfer`. Marking a
  transaction as a transfer without a known paired partner is intentionally
  not offered from this toolbar — pairing both legs of a transfer is a future
  phase's dedicated transfer-matching UI; only clearing an existing pairing
  lives here today.
- Exclude/include from budget and from reports (`bulkUpdateFinanceTransactions`
  on a single id).

A bulk-selection toolbar appears once at least one row is checked: apply a
category, or exclude the selection from budget/reports, in one
`bulkUpdateFinanceTransactions` call.

## Related documentation

- [Storage and backups](storage-and-backups.md#finance-tables)
- [Conventions](conventions.md) (minor-units rule)
- [specs/todo/finance.md](../specs/todo/finance.md) — the full phased spec
