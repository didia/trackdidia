# Finance (household money tracking and budgeting)

See also: [changelog](logs/finance.md).

TrackDidia is building a household finance domain: CSV transaction import, a
learning categorization loop, multi-person/multi-account tracking, and (in later
phases) YNAB-style envelope budgeting and proactive runout forecasting. This page
documents **Phase 2 — Schema and repository parity** only: the SQLite schema, the
`FinanceSqliteStore`/`FinanceMemoryStore` persistence layer, and the `AppRepository`
contract. There is no UI, no classification pipeline, and no budget arithmetic yet —
see [specs/todo/finance.md](../specs/todo/finance.md) for the full phased plan.

The feature is **unshipped to end users**: `AppSettings.financeEnabled` defaults to
`false`, there is no nav entry, and no startup code calls any finance method yet.
This page describes what the storage layer can do today so later phases (and
reviewers) have a canonical reference.

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
   batch's new rows and every other existing row in the same accounts, reporting
   matches in the summary without merging or dropping anything.
3. Runs transfer detection (`src/lib/finance/transfers.ts`) across the **entire**
   transaction history (not just the batch), applying matched-pair and
   probable-transfer outcomes and writing a pending suggestion wherever the pure
   engine says one is owed.
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
pending suggestions, repairs the transfer group of a surviving partner (clearing
`is_transfer`/`transfer_group_id`, restoring a pending suggestion so the partner
does not silently fall out of the budget), and **refuses to delete any row whose
`category_source = 'user'`** — those rows are counted in `refusedUserCategorized`
and left exactly as they were, with their `import_batch_id` intact.

## Related documentation

- [Storage and backups](storage-and-backups.md#finance-tables)
- [Conventions](conventions.md) (minor-units rule)
- [specs/todo/finance.md](../specs/todo/finance.md) — the full phased spec
