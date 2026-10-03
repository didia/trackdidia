# Finance (household money tracking and budgeting)

See also: [changelog](logs/finance.md).

TrackDidia is building a household finance domain: CSV transaction import, a
learning categorization loop, multi-person/multi-account tracking, and (in later
phases) YNAB-style envelope budgeting and proactive runout forecasting. This page
documents **Phase 2 — Schema and repository parity** (the SQLite schema, the
`FinanceSqliteStore`/`FinanceMemoryStore` persistence layer, and the
`AppRepository` contract), **Phase 3 — Accounts, import, and transaction
screens** (the first finance UI), and **Phase 4 — Classification: rules,
memory, seeds, review queue** (the automatic categorization pipeline, the
`/finances/review` suggestion queue, and the `/finances/rules` rule manager).
There is still no budget arithmetic and no AI categorization stage — see
[specs/todo/finance.md](../specs/todo/finance.md) for the full phased plan.

The feature is **unshipped to end users by default**: `AppSettings.financeEnabled`
defaults to `false`. With it off, the sidebar has no "Finances" entry and
`/finances*` redirects to `/`. A household that turns it on in Settings gets
the six screens documented in "Screens" below; later phases (budget, reports,
forecasting, AI) are not built yet. This page describes what the storage layer
and the UI can do today so later phases (and reviewers) have a canonical
reference.

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
  — the classification pipeline's inputs and pending-review queue (see
  "Classification pipeline (Phase 4)" below). A partial unique index keeps at
  most one pending suggestion per transaction.
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
repositories. Settings calls it when finance is first enabled, and the call is gated on
`AppSettings.financeCategoriesSeededAt`, the same one-time-marker pattern as the GTD
normalizations in `app-context.tsx`. Phase 4 added `fincat:logement.telecommunications` (additively — existing ids are never
renumbered) so the bundled telecom seed heuristic has a category to point at.

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
splits and transfers), import profiles/batches (including their decimal/thousands
separators), transaction import with undo, and
the category-suggestion queue. Phase 4 added the classification pipeline itself
(below), `reclassifyFinancePending()`, and `revertFinanceCategoryBackfill()`. Every finance mutation goes through the repository
writer queue (`writeExclusive`), so a save can never be rolled back by a concurrent
import. `saveFinanceTransactionSplits` validates that a non-empty allocation sums
exactly to the parent amount before touching anything and replaces splits in one
transaction; clearing the last split restores `fincat:non-categorise`. An
`all_matching` category correction marks every changed row `category_source = 'user'`,
and archiving a category also reassigns split and merchant-memory references.
**Not** covered yet (later phases): any `compute*`
report/forecast method, recurring-series detection/storage, budget state, balance
snapshots, or AI suggestion generation — these remain unimplemented on both
repositories until their respective phase.

### Learning entry point

`setFinanceTransactionCategory({ transactionId, categoryId, scope })` is the single
place that writes a user correction:

- Always sets `category_id`, `category_source = 'user'`, `categorized_at` on the
  target transaction.
- Upserts `finance_merchant_memory` for `(merchant_key, account_id, sign)` via the
  pure `applyMerchantMemoryCorrection` in `src/lib/finance/memory.ts`: on agreement
  with the existing entry, `hit_count += 1` and confidence nudges up (capped at
  `0.99`); on disagreement, the category is replaced, `correction_count += 1`, and
  confidence resets to `0.6` so one correction does not immediately become an
  auto-apply. This write happens for every scope — it is what makes
  `"this_and_future"` meaningfully different from `"this"` in practice, even
  though both write only the target row: the next import or
  `reclassifyFinancePending()` call picks up the updated memory automatically,
  so there is no separate "apply to future" step to run.
- `scope: "this"` (default) and `scope: "this_and_future"` both write only the
  target transaction; the distinction is about *intent* (future transactions
  will benefit from the memory update either way), not a different write path.
- `scope: "all_matching"` additionally recategorizes every other transaction
  sharing the same `merchant_key` whose `category_source !== 'user'`, nulling
  `category_confidence` on each (their `category_source` itself is left
  unchanged — still `'default'`/`'rule'`/`'memory'`, whatever it was — so a
  later `reclassifyFinancePending()` can still revise them if a rule or
  stronger memory signal appears). Because a backfilled row's `category_id`
  can be a real category while its `category_source` stays `'default'`,
  `classifyTransaction`'s "keep the existing category" guard (see
  "Classification pipeline" below) keys off `category_id !==
  'fincat:non-categorise'`, not `category_source` — otherwise a
  `reclassifyFinancePending()` immediately after an `all_matching` edit would
  silently reset the backfilled rows back to Uncategorized the moment their
  `merchant_key` matches nothing better than a suggestion.
  The result's `backfill` array captures each backfilled row's prior `category_id`,
  `category_source`, `category_confidence`, `categorized_at`, and the
  `categoryId` the bulk edit applied (`appliedCategoryId`); passing that array
  to `revertFinanceCategoryBackfill()` is the single undo the UI offers right
  after an `all_matching` edit (`FinanceTransactionsPage`'s backfill banner),
  one `BEGIN IMMEDIATE`/`COMMIT` on the SQLite side. The target transaction's
  own `category_source = 'user'` write is **not** part of the undo — only the
  backfilled rows revert, and even then only a row whose `category_source` is
  still not `'user'` **and** whose `category_id` still equals
  `appliedCategoryId` — if the user manually re-categorized it, or a later
  automatic pass moved it again, the undo leaves that row alone rather than
  clobbering the newer edit.

`decideFinanceCategorySuggestion` routes an `accepted`/`corrected` decision through
this same entry point (`scope: "this"`), so accepting a suggestion reinforces
memory exactly like a manual edit. Dismissing a suggestion does **not** call
`setFinanceTransactionCategory` — the transaction's category is left alone, and
the suggestion row itself (now `status = 'dismissed'`) becomes the negative
signal `classifyTransaction` reads for the 90-day suppression window.

## Classification pipeline (Phase 4)

`src/lib/finance/classify.ts` exports the pure `classifyTransaction(txn, context)`,
the single place that decides a transaction's category. Order, highest authority
first — the first stage that produces a category wins:

1. **User-set** (`categorySource === "user"`) — passthrough, never touched.
2. **Enabled `finance_rules`**, ordered by `priority` then id. `matchesRuleMatcher`
   checks `descriptionContains` (against `merchant_key`, case-insensitive),
   `descriptionRegex` (also against `merchant_key`; an invalid pattern is caught
   and simply never matches — it never throws), `accountIds`, `personId`,
   `amountMinMinor`/`amountMaxMinor`, and `sign`. The first matching rule with an
   `actions.categoryId` decides the category (`category_source = 'rule'`,
   confidence `1`); every matching rule's other actions (`merchantDisplay`,
   `personId`, `markTransfer`, `excludeFromBudget`, `excludeFromReports`,
   `addLabels`) are merged and applied regardless of which rule won the category.
3. **Transfer detection's result**, when the caller already resolved this
   transaction via `src/lib/finance/transfers.ts` (import and
   `reclassifyFinancePending()` both skip already-`is_transfer` rows entirely
   rather than routing them back through this stage — transfer detection is the
   authority there). In practice this means a user rule can never override an
   already-detected transfer: both write paths run the whole-history transfer
   pass first and only call `classifyTransaction` for the rows that pass left
   untouched (`is_transfer = 0`), so a transfer-marked row never re-enters the
   pipeline at the rules stage, even though stage 2 is textually "higher
   authority" than stage 3 above.
4. **Learned merchant memory** (`finance_merchant_memory`). Lookup order: exact
   `(merchantKey, accountId, sign)` → `(merchantKey, "", sign)` →
   `(merchantKey, "", 0)`. Auto-applies (`category_source = 'memory'`) at
   `confidence >= 0.85` **and** `hitCount >= 2`; otherwise a pending suggestion
   (`origin: "memory"`) — unless the `(merchantKey, categoryId)` pair was
   dismissed in the last 90 days (`src/lib/finance/dismissed-suggestions.ts`,
   injectable "today" so tests never depend on the real clock), in which case no
   suggestion is written at all. Memory outranks seeds whenever *any* entry
   exists, even below the auto-apply threshold.
5. **Bundled seed heuristics** (`src/lib/finance/seed-heuristics.ts`) — only
   consulted when no memory entry exists at any lookup level. An ordered list of
   `{ pattern, categoryId, confidence }` for merchants unambiguous in the
   Canadian/French context (grocery chains, fuel, telecom, transit/rideshare,
   streaming, pharmacy), matched against `merchant_key`. Confidence is capped at
   `0.7` — a seed always produces a suggestion (`origin: "seed"`), never an
   auto-apply — and is subject to the same 90-day dismissal suppression as memory.
6. **AI** — not implemented. The function has a clearly marked, empty hook
   between seeds and the default stage for Phase 8 to fill in.
7. **`Uncategorized`**, `category_source = 'default'`.

Both `FinanceSqliteStore.importTransactions` and `FinanceMemoryStore.importTransactions`
run this pipeline over every row the batch actually inserted that transfer
detection left untouched, immediately after transfer detection, inside the same
write. `reclassifyFinancePending()` re-runs the same pipeline (rules, memory,
seeds — no AI, no transfer re-detection) over every existing `category_source !=
'user'`, non-transfer transaction; it is what powers the "Réappliquer les règles"
action on `/finances/rules` and `/finances/review` after a rule is created or
edited. Neither path ever touches a `category_source = 'user'` row.

A "default" `classifyTransaction` outcome means this pass found nothing better
than a suggestion — it is **not** itself a category decision. Both write paths
guard against overwriting an already-categorized row with that non-decision:
when the outcome's `categorySource` is `'default'` but the row's *current*
`category_id` is already a real category (not `fincat:non-categorise`), the
write keeps the row's existing `category_id`/`category_source`/
`category_confidence` and only records the suggestion. This is what makes an
`all_matching` backfill (above) safe from a later `reclassifyFinancePending()`
silently undoing it the moment the merchant stops matching anything stronger
than a suggestion.

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

On `TauriSqliteRepository`, the whole call is one `writeExclusive` block issuing a
single `BEGIN IMMEDIATE`/`COMMIT` inside `FinanceSqliteStore.importTransactions` —
it never calls another queue-taking repository method, so it cannot deadlock
`DbSerialQueue`. A 5,000-row import completes inside this one block (see
`repository.contract.ts`'s "imports 5 000 rows" test).

New rows land as `category_id = 'fincat:non-categorise'`, `category_source =
'default'`; transfer detection then runs, and finally the classification
pipeline (see "Classification pipeline (Phase 4)" above) runs over whatever
transfer detection left untouched. A `categoryHint` on the row (from, e.g., a
Mint CSV's `Category` column) is still accepted on the request shape but
ignored — nothing in the pipeline reads it yet.

### Undo

`undoFinanceImportBatch(batchId)` is **restricted to the most recent batch for that
batch's account, and for every account represented by its rows** — if a later batch for any of those accounts exists, the call throws
rather than silently doing nothing, because that later batch may have deduped
against a row this undo would otherwise delete. It deletes a batch row's splits and
**all** of its category suggestions (pending or already decided — a deleted
transaction cannot leave an orphaned suggestion behind), repairs the transfer
group of a surviving partner (a partner the user categorized keeps its category,
provenance, and exclusions and only loses the dead group link; otherwise clearing
`is_transfer`/`transfer_group_id`, restoring a pending suggestion so the partner
does not silently fall out of the budget), and **refuses to delete any row whose
`category_source = 'user'`** — those rows are counted in `refusedUserCategorized`
and left exactly as they were, with their `import_batch_id` intact.

## Screens (Phases 3–4)

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
| `/finances/review` | `FinanceReviewPage` (Phase 4) |
| `/finances/rules` | `FinanceRulesPage` (Phase 4) |

Every `/finances*` page renders `FinanceTabs`
(`src/components/finance/FinanceTabs.tsx`), a shared in-page nav bar. It only
lists tabs for screens that exist today (Overview, Transactions, Import,
Accounts, Review, Rules); Budget and Reports have no tab until their phases
ship — adding a tab that 404s or redirects would be worse than omitting it.

`FinanceOverviewPage`'s total only sums on-budget accounts whose `currency`
equals `AppSettings.financeBaseCurrency` — minor units from different
currencies are never added together. Any on-budget account in a different
currency still gets its own card (shown in its own currency) and is called
out by name in a banner next to the total rather than silently excluded.

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
   created account's `external_key` keeps only the last 4 digits of a
   contiguous 6+ digit run (`\b\d{6,}\b`) found in the bound label, e.g.
   `"Checking 1234567890"` → `"****7890"`; a label with no such run (e.g.
   `"Checking"`) is stored as-is. Matching also masks the file's raw label the
   same way before comparing it against a saved `external_key`, so a repeat
   import whose column happens to format the same real-world account
   differently (e.g. `"CHK 1234567890"` the next month) still auto-binds to
   the existing account instead of asking the user to re-bind. When the
   profile has no account column, a single "this file is one account"
   dropdown is used instead.
6. The profile (with the user's final mapping) is saved via
   `saveFinanceImportProfile` before import. Repeating the same file (or any
   file with the same header signature) reuses that matched profile's id
   rather than minting a new one — `finance_import_profiles.signature` is
   unique, so a fresh id on every import would collide with itself on the
   second import of the same export. The mapped rows are built by the pure
   `buildImportRequest`/`buildImportRows` in
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

- A category-source badge (`transactions.categorySource.*`, one of `user`,
  `rule`, `memory`, `seed`, `ai`, `default`) next to the date/account/amount
  line, so it is visible at a glance whether a row's category came from a
  manual edit or an automatic stage.
- Inline category edit via `setFinanceTransactionCategory`, with a
  per-row scope selector (`this` / `this_and_future` / `all_matching`) that
  is read at edit time — there is no separate "apply" step. The select always
  has a real category selected (falling back to the system
  `fincat:non-categorise` id rather than an empty `""` option), so every
  change sends a concrete, non-empty `categoryId`; both `FinanceSqliteStore`
  and `FinanceMemoryStore` also reject an empty `categoryId` defensively. When
  the scope is `all_matching` and other rows were backfilled, a banner reports
  the count and offers "Annuler la recatégorisation groupée", which calls
  `revertFinanceCategoryBackfill` with the result's `backfill` entries (see
  "Learning entry point" above) — the banner and its undo apply to only the
  most recent `all_matching` edit in the page's session.
- A split editor (`FinanceTransactionSplit[]`) with client-side sum-invariant
  validation matching the repositories' own `validateSplitTotal`: a non-empty
  allocation must parse and sum exactly to the parent's `amountMinor`; removing
  every row saves an empty list, which clears the splits and restores the
  uncategorized parent. Save stays disabled until that transaction's existing
  splits have loaded, and a superseded load is ignored.
- Accounts can be edited in place (id, external key, notes, closed state and order
  are preserved; the currency is locked once saved). Currencies are validated with
  `normalizeCurrencyCode` before persisting, in accounts and in Settings.
- Imports parse each row with its bound account's currency, mask the account column
  in the stored source row and in default account names, and pass CSV parser
  warnings and mapping errors to the repository as `FinanceImportRequest.rejected`
  so they land in the batch's skipped/error counts, `error_summary` and warnings.
- Unmark transfer (calls `clearFinanceTransfer`) is a per-row action. Marking
  a *pair* as a transfer is a bulk action instead: selecting exactly two rows
  enables "Marquer la paire comme virement" in the bulk toolbar, which calls
  `setFinanceTransfer({ transactionIdA, transactionIdB })`. Different
  accounts and mirrored amounts are not required, but the page shows a
  non-blocking warning when the two selected rows share an account or their
  amounts' magnitudes differ, since either is a sign the pair is not really
  a transfer.
- Exclude/include from budget and from reports (`bulkUpdateFinanceTransactions`
  on a single id).

A bulk-selection toolbar appears once at least one row is checked: apply a
category, exclude the selection from budget/reports, or (with exactly two
rows selected) mark the pair as a transfer.

### FinanceReviewPage (`/finances/review`, Phase 4)

The pending-suggestion queue (`listFinanceCategorySuggestions("pending")`),
grouped by `merchant_key`. Each suggestion shows the transaction's description,
the suggested category name, its confidence, and its `origin` (`memory` |
`seed` — `ai` is Phase 8). Three per-row actions, all routed through
`decideFinanceCategorySuggestion`:

- **Accepter** — `status: "accepted"`, which applies the suggested category via
  `setFinanceTransactionCategory({ scope: "this" })` and reinforces
  `finance_merchant_memory` exactly like a manual edit.
- **Corriger** — opens a category picker; choosing one sends
  `status: "corrected"` with that `categoryId`, which flips memory to the
  chosen category and resets its confidence to `0.6` (see
  `applyMerchantMemoryCorrection`).
- **Rejeter** — `status: "dismissed"`. The transaction's category is left
  untouched; the dismissed suggestion row itself becomes the negative signal
  `classifyTransaction` reads for the 90-day `(merchantKey, categoryId)`
  suppression window on the next import or reclassify.

"Accepter tout au-dessus de {{threshold}}%" bulk-accepts every pending
suggestion at or above an 80% confidence floor (a page constant, not a
setting). "Réappliquer les règles" calls `reclassifyFinancePending()` and
reports how many transactions changed and how many new suggestions were
created — useful right after creating or editing a rule on `/finances/rules`.
There is no "Classifier en attente" (AI) button yet — that ships with Phase 8.

### FinanceRulesPage (`/finances/rules`, Phase 4)

CRUD for `finance_rules`: name, priority, a single `descriptionContains`
matcher field (the full matcher shape — `descriptionRegex`, `accountIds`,
`personId`, amount bounds, `sign` — is supported by the engine and the
repository but not yet exposed in this form), and a category action. Each rule
card shows its applied count and enable/disable and delete actions
(`saveFinanceRule`/`deleteFinanceRule`). "Appliquer aux transactions
existantes" calls the same `reclassifyFinancePending()` as the review page's
"Réappliquer les règles" — the two buttons are the same action surfaced on two
screens, matching how a newly added rule should retroactively reach rows that
already exist.

## Related documentation

- [Storage and backups](storage-and-backups.md#finance-tables)
- [Conventions](conventions.md) (minor-units rule)
- [specs/todo/finance.md](../specs/todo/finance.md) — the full phased spec
