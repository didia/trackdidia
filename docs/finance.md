# Finance (household money tracking and budgeting)

See also: [changelog](logs/finance.md).

TrackDidia is building a household finance domain: CSV transaction import, a
learning categorization loop, multi-person/multi-account tracking, and
YNAB-style envelope budgeting, and proactive runout forecasting. This page
documents **Phase 2 — Schema and repository parity** (the SQLite schema, the
`FinanceSqliteStore`/`FinanceMemoryStore` persistence layer, and the
`AppRepository` contract), **Phase 3 — Accounts, import, and transaction
screens** (the first finance UI), **Phase 4 — Classification: rules, memory,
seeds, review queue** (the automatic categorization pipeline, the
`/finances/review` suggestion queue, and the `/finances/rules` rule manager),
**Phase 5 — Budget** (the zero-based envelope model in
`src/domain/finance/budget.ts`, `setFinanceBudgetAssignment`/
`computeFinanceBudgetState`, and the `/finances/budget` screen), and
**Phase 6 — Tracking, reports, recurring, net worth** (net worth, cash flow,
category/merchant/person reports with drill-down, recurring-bill detection,
daily balance snapshots, and the `/finances` dashboard and `/finances/reports`
screens — see "Tracking, reports, recurring, net worth" below), and
**Phase 7 — Forecasting and proactive alerts** (per-envelope runout
forecasting, the household cash-flow runout date, ranked alerts, the
`FinanceAlertsCard` on Today, the full alerts list on `/finances`, and a
rate-limited desktop notification — see "Forecasting and proactive alerts
(Phase 7)" below), and **Phase 8 — AI categorization** (the `finance_categorization`
AI surface, `FinanceCategorizationService`, the sanitized merchant snapshot,
auto-apply above a confidence threshold, and the "Classer les en attente"
button on `/finances/review` — see "AI categorization (Phase 8)" below). All
phases from [specs/done/finance.md](../specs/done/finance.md) have shipped;
that spec has moved to `specs/done/finance.md`.
Finance coach-context in the daily pulse payload (`financeCoachContextEnabled`)
remains unimplemented; the setting exists and defaults off, but nothing reads
it yet (see "Forecasting and proactive alerts (Phase 7)" for why it was
deferred rather than shipped here).

The feature is **unshipped to end users by default**: `AppSettings.financeEnabled`
defaults to `false`. With it off, the sidebar has no "Finances" entry and
`/finances*` redirects to `/`. A household that turns it on in Settings gets
the eight screens documented in "Screens" below plus the Phase 7 alerts; AI
categorization is a further, separately-gated opt-in (see "AI categorization
(Phase 8)" below) — with it off, every classification stage except AI still
works exactly as before. This page describes what the storage layer and the
UI can do today so reviewers have a canonical reference.

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
  **`finance_recurring_series`**, **`finance_account_balance_snapshots`** — read
  by the budget (Phase 5), recurring-detection and net-worth (Phase 6), and
  forecasting (Phase 7) engines described below.
- **`finance_alert_notifications`** (migration `39_create_finance_alert_notifications`,
  additive, touches no other table) — `(alert_key, notified_on_date)` primary
  key plus `notified_at`. The once-per-day-per-alert-key rate-limit ledger for
  the Phase 7 desktop notification; see "Forecasting and proactive alerts
  (Phase 7)" below.

## Default category taxonomy

`src/lib/finance/default-categories.ts` holds a deterministic French taxonomy with
fixed ids (`fincat:alimentation`, `fincat:alimentation.epicerie`, …), distinct from
the three system categories above. `AppRepository.seedFinanceDefaultCategories()`
seeds it idempotently (`INSERT OR IGNORE`, so re-running is always a no-op) on both
repositories. Settings calls it when finance is first enabled, and startup calls it on
every launch while finance is enabled, so taxonomy entries added by later releases reach
installations that were seeded earlier (`AppSettings.financeCategoriesSeededAt` is only
set once, as a record of the first seed). Phase 4 added `fincat:logement.telecommunications` (additively — existing ids are never
renumbered) so the bundled telecom seed heuristic has a category to point at.

## Settings

`AppSettings` carries the finance flags (all defaulted in `defaultAppSettings()`,
merged by `mergeAppSettingsWithDefaults` so existing settings rows pick them up
automatically — no migration needed):

| Field | Default | Purpose |
|---|---|---|
| `financeEnabled` | `false` | Master feature flag; later phases gate the nav entry and bootstrap work on this |
| `financeBaseCurrency` | `"CAD"` | Single base currency for cross-account rollups |
| `financeAiCategorizationEnabled` | `false` | Gates the AI classification stage (Phase 8, implemented) |
| `financeAiAutoApplyEnabled` | `false` | Whether an AI suggestion can auto-apply |
| `financeAiAutoApplyMinConfidence` | `0.9` | Confidence floor for AI auto-apply |
| `financeAlertsOnToday` | `true` | Shows `FinanceAlertsCard` on Today (Phase 7, implemented) |
| `financeCoachContextEnabled` | `false` | Reserved for a compact finance snapshot in the coach payload; **not implemented** — see "Forecasting and proactive alerts (Phase 7)" |
| `financeNotifyRunout` | `true` | Gates the rate-limited desktop notification for `will_run_out`/`exhausted` envelopes and a cash runout inside 14 days (Phase 7, implemented) |
| `financeSafetyBufferMinor` | `0` | Minor-unit floor for the household cash-runout forecast (Phase 7, implemented) |
| `financeCategoriesSeededAt` | `""` | Records the first default taxonomy seed (startup re-seeds additively regardless) |

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
(below), `reclassifyFinancePending()`, and `revertFinanceCategoryBackfill()`.
Phase 5 added the budget methods — `getFinanceBudgetMonth`,
`setFinanceBudgetAssignment`, `setFinanceCategoryOverspendPolicy`,
`computeFinanceBudgetState`, `setFinanceBudgetMonthClosed`, and
`setFinanceBudgetReadyToAssignNote` — covered below under "Budget (Phase 5)".
Every finance mutation goes through the repository
writer queue (`writeExclusive`), so a save can never be rolled back by a concurrent
import. `saveFinanceTransactionSplits` validates that a non-empty allocation sums
exactly to the parent amount before touching anything and replaces splits in one
transaction; clearing the last split restores `fincat:non-categorise`. An
`all_matching` category correction marks every changed row `category_source = 'user'`,
and archiving a category also reassigns split and merchant-memory references.
Phase 6 added `computeFinanceNetWorth`, `listFinanceNetWorthHistory`,
`computeFinanceCashFlow`, `computeFinanceCategorySpend`,
`listFinanceCategorySpendDrilldown`, `computeFinanceMerchantSpend`,
`computeFinancePersonSpend`, `computeFinanceTrend`,
`computeFinanceMonthOverMonth`, `listFinanceRecurringSeries`,
`saveFinanceRecurringSeries`, `detectFinanceRecurringSeries`,
`snapshotFinanceAccountBalances`, and `listFinanceAccountBalanceSnapshots` —
covered below under "Tracking, reports, recurring, net worth (Phase 6)".
Phase 7 added `buildFinanceSnapshot`, `computeFinanceForecast`,
`listNotifiedFinanceAlertKeys`, and `recordFinanceAlertNotifications` —
covered below under "Forecasting and proactive alerts (Phase 7)". Phase 8
added `listFinanceUnknownMerchants` and
`applyFinanceCategorizationResults` — covered below under "AI categorization
(Phase 8)".

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
  sharing the same `merchant_key` whose `category_source !== 'user'`, marking each
  `category_source = 'user'` and nulling `category_confidence`: the user explicitly
  applied the correction, so later imports, `reclassifyFinancePending()` and transfer
  detection never overwrite it (and undoing an import cannot delete it).
  The result's `backfill` array captures each backfilled row's prior `category_id`,
  `category_source`, `category_confidence`, `categorized_at`, and the
  `categoryId` and `categorized_at` stamp the bulk edit applied (`appliedCategoryId`,
  `appliedAt`); passing that array
  to `revertFinanceCategoryBackfill()` is the single undo the UI offers right
  after an `all_matching` edit (`FinanceTransactionsPage`'s backfill banner),
  one `BEGIN IMMEDIATE`/`COMMIT` on the SQLite side. The target transaction's
  own `category_source = 'user'` write is **not** part of the undo — only the
  backfilled rows revert, and even then only a row whose `category_id` still equals
  `appliedCategoryId` **and** whose `categorized_at` is still `appliedAt` — if the
  user manually re-categorized it afterwards, the undo leaves that row alone rather
  than clobbering the newer edit.

`decideFinanceCategorySuggestion` routes an `accepted`/`corrected` decision through
this same entry point (`scope: "this"`), so accepting a suggestion reinforces
memory exactly like a manual edit. Dismissing a suggestion does **not** call
`setFinanceTransactionCategory` — the transaction's category is left alone, and
the suggestion row itself (now `status = 'dismissed'`) becomes the negative
signal `classifyTransaction` reads for the 90-day suppression window.

## Classification pipeline (Phase 4, extended by Phase 8)

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
6. **AI** — deliberately *not* a step of the pure `classifyTransaction` function
   (it is async and network-bound, and must never run inside a
   `DbSerialQueue`/`BEGIN IMMEDIATE` slot). A transaction that falls through
   stages 1-5 here (category `Uncategorized`, no suggestion written) becomes a
   candidate for `AppRepository.listFinanceUnknownMerchants`, which
   `FinanceCategorizationService` reads, classifies via the configured AI
   provider, and applies back through
   `AppRepository.applyFinanceCategorizationResults` — see "AI categorization
   (Phase 8)" below for the full flow.
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

## Budget (Phase 5)

`src/domain/finance/budget.ts` is a pure, no-I/O envelope-budget engine —
every number the budget page renders comes from this file, matching the
`computeWeeklyReviewSummary` centralization pattern. Both
`FinanceSqliteStore.computeBudgetState` and
`FinanceMemoryStore.computeBudgetState` take an explicit `baseCurrency` and load the **same input shape**
(via a private `buildBudgetComputationInput`, shared with
`computeCoverOverspending` below) — **two** separate transaction arrays
through the end of the requested month (see "the two transaction arrays"
below), every `finance_budget_entries` row (any month, past or future), and
every category — and hand it to the same `computeFinanceBudgetState`.
**Rollover is never stored**: `carryIn` is recomputed from scratch on every
call, so correcting a transaction six months back automatically fixes every
later month with no migration and no stale cached balance.

Core formulas (all minor units):

```
activity(cat, month)   = Σ amount_minor of that category's transactions (splits expanded) in month
available(cat, month)  = carryIn(cat, month) + assigned(cat, month) + activity(cat, month)
carryIn(cat, month)    = 0 for the first budgeted month; otherwise the previous month's
                          available if it is >= 0, or (per that previous month's
                          overspend_policy) either the negative available itself
                          (carry_negative) or 0 (reduce_next_ready_to_assign, the default)
readyToAssign(M)       = onBudgetBalance(end of M)
                       − Σ available(cat, M) over kind = 'expense' categories (incl. Uncategorized)
                       − Σ assigned(cat, m) for all m > M
                       − deferredIncome(M)
```

There is **no** `+ deferredIncome(M − 1)` release term: `onBudgetBalance` is
a stock (an account balance at a point in time), not a flow, so money held
back from the previous month is still sitting in that same balance at the
end of this one with no further adjustment needed — adding a release term
back in would double-count it. `deferredIncome(M)` is the positive activity
of `kind = 'income'` categories with `defers_to_next_month = 1`; assigning
money to an income-kind category throws (`assertFinanceCategoryAssignable`),
since such a row would be counted by neither side of the balance invariant
(`budget.test.ts` asserts that invariant directly — independently
recomputing the expected balance from the test's own raw account/transaction
fixtures rather than by calling `computeFinanceOnBudgetBalance` itself —
under both overspend policies, on the spec's worked example, and across
consecutive deferred-income months).

**The two transaction arrays.** `FinanceBudgetComputationInput` carries
`transactions` (on-budget accounts in that base currency only, `excluded_from_budget = 0`, splits expanded —
drives `activity`/`available`) and a *separate* `balanceTransactions`
(**every** on-budget transaction, regardless of `excluded_from_budget`).
`onBudgetBalance(M) = opening_balance_minor + Σ balanceTransactions up to end
of M`, across on-budget accounts in the selected base currency — deliberately including excluded rows,
since a transfer (or any other excluded transaction) still moves real money
in and out of the account; `activity` must still exclude it. One
`excluded_from_budget` flag cannot serve both purposes, so the two pure
functions read two different arrays built from the same underlying
`finance_transactions` table.

**Quick-action amounts live on the category state, not in the UI.**
`computeFinanceBudgetState` computes `lastMonthAssignedMinor`,
`average3MonthsAssignedMinor`, and `assignAllReadyToAssignMinor` on every
`FinanceBudgetCategoryState` it returns (each delegates to the matching pure
helper — `computeAssignLastMonthAmount`, `computeAssignAverageLast3MonthsAmount`,
and the in-place `assignedMinor + max(0, readyToAssignMinor)` computation),
so `FinanceBudgetPage`'s "Mois dernier"/"Moy. 3 mois"/"Assigner tout le prêt
à assigner" buttons just read a field off the state it already holds and
write it straight through `setFinanceBudgetAssignment` — **no arithmetic in
the page**. "Cover overspending from another category" is the one quick
action that needs two categories' data at once, so it stays a dedicated
repository method, `computeFinanceCoverOverspending(monthKey, baseCurrency,
fromCategoryId, toCategoryId)`, implemented identically on both stores via the same private
`buildBudgetComputationInput` used by `computeBudgetState`, delegating to the
pure `computeCoverOverspending`; the page calls
`applyFinanceCoverOverspending(monthKey, baseCurrency, fromCategoryId, toCategoryId)`, which
writes both categories' new assignments in one writer-queue transaction.
`selectUnbudgetedCategories` picks out the "Non budgété" band (no assignment,
negative activity, and `availableMinor < 0` — spending already covered by
carry-in, and refunds, are never listed) and `computeUnbudgetedAssignAmountMinor`
is the one-click "Assigner" amount (the uncovered deficit, `max(0, -available)`);
`computeEnvelopePace`/
`computeEnvelopePaceFromState` give a simple spent-vs-elapsed-days fraction
per envelope (no forecasting yet — that is `src/domain/finance/forecast.ts`,
a later phase).

Repository methods: `getFinanceBudgetMonth` reads the advisory
`finance_budget_months` row (`ready_to_assign_note`, `closed_at`), defaulting
to an unsaved empty row rather than throwing when the month has never been
touched. `setFinanceBudgetAssignment(monthKey, categoryId, assignedMinor)` is
an idempotent upsert into `finance_budget_entries`; assigning `0` deletes the
row unless it holds a non-default overspend policy or a note (then the row is kept at
`0`, so an untouched `0.00` field blurring cannot reset the policy).
`setFinanceCategoryOverspendPolicy(monthKey, categoryId, policy)` writes
the policy onto the `(monthKey, categoryId)` entry — creating it with
`assigned_minor = 0` if it does not exist yet, purely so the policy has
somewhere to live — and onto every **already-existing** later entry for that
category; it never creates a future entry just to carry the policy forward.
`computeFinanceCoverOverspending` (above). `setFinanceBudgetMonthClosed`/
`setFinanceBudgetReadyToAssignNote` write the advisory `finance_budget_months`
row; closing a month is a UI-level freeze and changes no arithmetic.

## Screens (Phases 3–5)

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

Settings also exposes `financeBaseCurrency` next to the toggle, the
alerts/notify-runout flags (Phase 7), and the three AI categorization flags
(Phase 8) — `financeAiCategorizationEnabled`, `financeAiAutoApplyEnabled`,
`financeAiAutoApplyMinConfidence` — rendered disabled (not hidden) while
`settings.aiEnabled` is false, with a helper line explaining the dependency.
`financeCoachContextEnabled` alone is still **not** shown: it remains a no-op
until the coach-payload integration ships (see "Forecasting and proactive
alerts (Phase 7)"), and showing a checkbox with no effect would be misleading.

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
| `/finances` | `FinanceOverviewPage` — net worth, this month's cash flow, account list with derived balances, a 6-month spending trend, top categories, and upcoming recurring bills (Phase 6) |
| `/finances/transactions` | `FinanceTransactionsPage` |
| `/finances/budget` | `FinanceBudgetPage` (Phase 5) |
| `/finances/reports` | `FinanceReportsPage` — category/merchant/person spend with drill-down, income-vs-expense trend, month-over-month comparison (Phase 6) |
| `/finances/import` | `FinanceImportPage` |
| `/finances/accounts` | `FinanceAccountsPage` |
| `/finances/review` | `FinanceReviewPage` (Phase 4) |
| `/finances/rules` | `FinanceRulesPage` (Phase 4) |

Every `/finances*` page renders `FinanceTabs`
(`src/components/finance/FinanceTabs.tsx`), a shared in-page nav bar. It only
lists tabs for screens that exist today (Overview, Transactions, Budget,
Reports, Import, Accounts, Review, Rules) — adding a tab that 404s or
redirects would be worse than omitting it.

`FinanceOverviewPage`'s net worth and cash-flow totals only sum accounts/
transactions whose `currency` equals `AppSettings.financeBaseCurrency` —
minor units from different currencies are never added together. Any account
in a different currency still gets its own card (shown in its own currency)
and is called out by name in a banner (`excludedCurrencies`) rather than
silently excluded. Net worth itself counts **every** account regardless of
`onBudget`/`excludedFromBudget` — those are budget-only exclusions and never
remove money from net worth (see AGENTS.md "Repository parity").

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

### FinanceBudgetPage (`/finances/budget`, Phase 5)

A month selector (previous/next, via `addMonthsToMonthKey`), a "Prêt à
assigner" header (amount plus an editable note persisted through
`setFinanceBudgetReadyToAssignNote`), and an envelope grid grouped by
category group (`parent_id === null`), with Assigned (inline-editable —
rendered via `minorToInputString(assignedMinor, currencyExponent(baseCurrency))`,
never `amountMinor / 100`, and parsed on blur via `parseAmountToMinor({
exponent: currencyExponent(baseCurrency) })` before writing through
`setFinanceBudgetAssignment`), Activity, and Available columns per leaf
category. Per-row controls, **all reading an already-computed field off
`computeFinanceBudgetState`'s result rather than recomputing anything in the
page**: an overspend-policy select (`setFinanceCategoryOverspendPolicy`),
"Mois dernier" (writes `category.lastMonthAssignedMinor`), "Moy. 3 mois"
(writes `category.average3MonthsAssignedMinor`), "Assigner tout le prêt à
assigner" (writes `category.assignAllReadyToAssignMinor`), and — only while
a category's `availableMinor` is negative — a source-category picker plus
"Couvrir" that calls `repository.applyFinanceCoverOverspending` (one atomic
write of both totals). Parent categories that hold spending or an assignment get
their own row above their leaves. Writes run through one in-page queue and
quick actions re-read `computeFinanceBudgetState` inside the queued task, so
overlapping clicks cannot reuse a stale Ready to Assign; a stale month load is
discarded and write/load failures render an alert. A queued write remains tied
to its original month after navigation, but it cannot refresh or overwrite the
newly selected month. Draft assignments and notes retain newer local edits while
an older save or refresh is in flight. The budget totals exclude on-budget
accounts in other currencies and show the same currency-exclusion notice as the
Overview; credit-card balances remain visible in each card's own currency.
Closed on-budget accounts are included when determining that currency-exclusion
notice because their balances still participate in budget arithmetic. While a
selected month is loading, every budget mutation, including close/reopen, is
disabled; once loaded, close/reopen derives its action from that month's stored
`closed_at` value.
Blurring an unchanged
assignment is a no-op. A "Non budgété" band (from
`selectUnbudgetedCategories`) lists categories with uncovered spending, each
with a one-click "Assigner" that adds `computeUnbudgetedAssignAmountMinor(category)`. A plain "solde
des cartes de crédit" line lists each on-budget credit-card account's
derived balance (`computeDerivedBalanceMinor`) — the v1 simplification from
the spec's "Credit-card payment categories" decision, not a payment
envelope. "Clôturer le mois"/"Rouvrir le mois" toggle
`finance_budget_months.closed_at` and disable every input while closed; this
is advisory only and never changes arithmetic.

### FinanceReviewPage (`/finances/review`, Phase 4, extended by Phase 8)

The pending-suggestion queue (`listFinanceCategorySuggestions("pending")`),
grouped by `merchant_key`. Each suggestion shows the transaction's description,
the suggested category name, its confidence, and its `origin` (`memory` |
`seed` | `ai`). Three per-row actions, all routed through
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

"Classer les en attente (IA)" calls `FinanceCategorizationService.classifyPending`
(see "AI categorization (Phase 8)" below) and is disabled — not hidden — unless
all three flags are on (`settings.aiEnabled`, a non-empty
`settings.aiApiKey`, and `settings.financeAiCategorizationEnabled`; the
service itself only checks `financeAiCategorizationEnabled` and
`aiPayloadScope !== "metrics"` and records a `skipped` run when AI is
unconfigured), with a helper line explaining the dependency and a `title`
tooltip stating the action has a cost. The click is serialized with the other
review actions (`exclusive`/`busyRef`, so a double-click cannot start two
runs and "Réappliquer les règles" cannot run mid-call), and it passes
`bypassCache: true` because it is an explicit re-run. The result message
reports how many merchants were actually sent to the provider (a cached answer
says none were sent), how many suggestions were created and auto-applied, and
how many were skipped because they were recently dismissed; when a later chunk
fails, the counts from the chunks that succeeded are kept next to the warning.
After an import, a non-throwing AI failure (`result.warning`) is logged and
shown as a non-blocking line on the import page; the import itself still
succeeds.

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

## Tracking, reports, recurring, net worth (Phase 6)

Pure engines, loaded the same way in both repositories and handed to the same
function (never a SQL `GROUP BY` in one and a JS reduce in the other):

- `src/domain/finance/net-worth.ts` — `computeFinanceNetWorth(asOfDate)`
  splits every account by type into asset/liability
  (`classifyFinanceAccountKind`: `credit_card`/`line_of_credit`/`loan`/
  `mortgage` are liabilities, everything else is an asset), sums balances
  (opening + every transaction through `asOfDate`, **regardless of**
  `excludedFromBudget`/`excludedFromReports`/`onBudget`) in `baseCurrency`
  only, and returns `netWorthMinor = assetsMinor - liabilitiesMinor` plus a
  per-account line list and the set of `excludedCurrencies`.
  `buildFinanceNetWorthHistory` folds daily
  `finance_account_balance_snapshots` rows into a `{ asOfDate, netWorthMinor }`
  series (a liability's snapshot balance is conventionally already negative,
  so the series is a plain per-day sum of raw balances — no sign flip).
- `src/domain/finance/cash-flow.ts` — `computeFinanceCashFlow(monthKey)`
  sums income/expense/net for one month from splits-expanded, transfer- and
  `excludedFromReports`-free lines in `baseCurrency`.
- `src/domain/finance/reports.ts` — `buildFinanceReportLines` is the one
  split-expansion/filter step every report function calls:
  `computeFinanceCategorySpend` (by category or category group, via
  `FinanceReportGroupBy`), `listFinanceCategorySpendDrilldown` (the exact
  lines summing to one category row — the UI's drill-down), `computeFinanceMerchantSpend`,
  `computeFinancePersonSpend`, `computeFinanceTrend` (income/expense by month
  or week), and `computeFinanceMonthOverMonth` (per-category spend across two
  arbitrary ranges).
- `src/lib/finance/recurring-detection.ts` — `detectFinanceRecurringSeries`
  groups the full transaction history by `merchantKey` + `accountId` + sign (the same merchant on two accounts is two series), requires ≥ 3
  occurrences, classifies a cadence (weekly/biweekly/semimonthly/monthly/
  quarterly/annual) from the median day gap when its stddev is within that
  cadence's band half-width, sets `expectedAmountMinor` to the median amount
  and `amountToleranceMinor` to `max(5% of median, 100)`, and computes
  `nextExpectedDate` — calendar-month anchored with end-of-month clamping for
  monthly/quarterly/annual cadences (`addMonthsClamped`; the 31st in a
  30-day/February month lands on that month's last day), plain day arithmetic
  for weekly/biweekly; semimonthly follows two stable days of the month. When the median gap fits both the biweekly and semimonthly bands, two stable anchor days (e.g. the 1st and 15th) classify it semimonthly and `nextExpectedDate` is the next anchor day. Flags `missed` (today past
  `nextExpectedDate` by more than the cadence's tolerance), `amount_changed`
  (newest occurrence outside tolerance), and `ended` (two consecutive
  misses). A series the user confirmed (`confirmedByUser`) is always returned
  by re-detection, even when the fresh group no longer meets the
  3-occurrence/cadence threshold — confirmation pins the series. Both stores feed it only non-transfer, non-`excludedFromReports` transactions, and treat its result as the full set: after the upsert, any unconfirmed series it no longer returns is deleted (import undone, cadence broken). Detection also runs at the end of `undoImportBatch`, inside its transaction.

Repository methods (both implementations, delegating to the pure functions
above): `computeFinanceNetWorth`, `listFinanceNetWorthHistory`,
`computeFinanceCashFlow`, `computeFinanceCategorySpend`,
`listFinanceCategorySpendDrilldown`, `computeFinanceMerchantSpend`,
`computeFinancePersonSpend`, `computeFinanceTrend`,
`computeFinanceMonthOverMonth`, `listFinanceRecurringSeries`,
`saveFinanceRecurringSeries`, `detectFinanceRecurringSeries` (re-runs
detection and upserts every result, preserving confirmed series — called
after every `importFinanceTransactions`, inside its transaction, and on
demand from `/finances`), `snapshotFinanceAccountBalances(asOfDate)` (derives
and upserts one `finance_account_balance_snapshots` row per account, source
`'derived'`, idempotent per day — an upsert on the `(account_id, as_of_date)`
primary key, written in one transaction so a day never keeps a prefix of accounts), and `listFinanceAccountBalanceSnapshots(accountId)`.

### Bootstrap: daily balance snapshots

`useLocalDayReconciliation` (`src/app/use-local-day-reconciliation.ts`) takes
a `financeEnabled` flag alongside the repository. On the same local-day
reconciliation pass that regenerates recurrences and promotes Scheduled
tasks, when `financeEnabled` it also calls
`snapshotFinanceAccountBalances(today)` so the net-worth history has one
point per day the app was open. The call is independently try/caught —
a snapshot failure is logged with a fixed message (the error is never logged, so no
amounts or row data) and never blocks recurrence/promotion or the eight-second startup
timeout. The upsert is idempotent, so every pass (focus, visibility, midnight, and
turning `financeEnabled` on, which is an effect dependency) refreshes today's point,
and it still runs when `reconcileDay` throws.

### FinanceOverviewPage (`/finances`, Phase 6)

Net worth (total plus assets/liabilities, with the non-base-currency banner
described above), this month's cash flow (income/expense/net), a 6-month
spending-trend bar chart (one column per month, zero-filled, each printing its
amount; plain CSS bars sized from `computeFinanceTrend`'s `expenseMinor`, no charting
dependency), the current month's top five
spending categories (`computeFinanceCategorySpend`), the account list rendered from the same `computeFinanceNetWorth` lines as the total (so closed accounts and the as-of-today cutoff agree with it; closed accounts are labelled), and up to five upcoming active
recurring series sorted by `nextExpectedDate` and formatted in the account's own currency, each with Confirmer/Mettre en
pause/Terminer actions that write through `saveFinanceRecurringSeries`. `load` first calls `detectFinanceRecurringSeries()` so dates and missed/ended series reflect today, and surfaces a load failure instead of a stuck "Chargement...".

### FinanceReportsPage (`/finances/reports`, Phase 6)

A date-range picker (defaults to the current month) feeding every report
below: spending by category with a "Voir le détail" drill-down that lists
the exact transactions summing to that row's total (via
`listFinanceCategorySpendDrilldown`), spending by merchant (top 10), spending
by person, an income-vs-expense table by month, and a month-over-month
per-category comparison against the preceding window of the same length as the selected range. An empty or inverted range is refused before any repository call; loads and drill-downs carry a request id so a stale response is ignored, changing the range closes the open drill-down, and a rejected load shows an error. The drill-down panel takes focus and closes on Escape.

## Forecasting and proactive alerts (Phase 7)

`src/domain/finance/forecast.ts` is pure, takes one `FinanceSnapshot` input
(built by `AppRepository.buildFinanceSnapshot(asOfDate)`), and exports
`computeFinanceForecast(snapshot)` plus `buildFinanceAlerts(forecast, settings)`.
Both repositories load the same rows into the same `FinanceSnapshot` shape and
hand it to the same two functions — never a SQL aggregate in one and a JS
reduce in the other.

**Per-envelope forecast**, for every budgeted category (`envelope =
assignedMinor + carryInMinor > 0`; unbudgeted categories are out of scope
entirely — no ladder, no alert, matching the "Non budgété" band's own
semantics):

- `spentMinor` is the category's actual activity this month **through
  `asOfDate`**, read off `computeFinanceBudgetState` over a budget input
  restricted by `restrictBudgetInputThrough` (never recomputed). A
  future-dated transaction is not spending that has already happened, so it
  affects neither `spentMinor`, the pace, nor `firstActivityMonthKey` until its
  date arrives.
- `currentPaceMinor` / `historicalPaceMinor` exclude transactions matched to
  an **active** recurring series (`merchantKey` + `accountId` + sign) so a
  lump-sum bill is counted once, in `spentMinor`, never smoothed into a pace.
  `historicalPaceMinor` is the **median** (not mean) of the three trailing
  full months' non-recurring daily spend rate — a median resists a single
  legitimate outlier (a car repair) firing an alert on unrelated categories.
- `blendedPaceMinor` follows the elapsed-day ladder (`< 5` → historical,
  `< 12` → 50/50 blend, otherwise current) **unless** there are fewer than 3
  trailing full months of data, in which case `lowConfidence = true` and the
  ladder collapses to pure current pace (rendered as "estimation
  provisoire" — the fallback that would otherwise read an undefined
  historical rate).
- `knownUpcomingMinor` sums **every remaining occurrence this month** of the
  category's active recurring **bills** (`expectedAmountMinor < 0`) — a weekly
  bill counts each week, not just its next date — each added as a lump sum on
  its own day, never smoothed. Only series on on-budget accounts in
  `financeBaseCurrency` count (an off-budget or foreign-currency bill or
  paycheck can neither trigger nor mask an alert).
- `projectedTotalMinor = spentMinor + blendedPaceMinor * remainingDays +
  knownUpcomingMinor`; `runoutDate` is the first remaining day this
  crosses the envelope, found by a day-by-day walk (so a lump-sum bill lands
  exactly on its posting day, not smoothed across the month).
- Status ladder, integer comparisons only (no float threshold): `exhausted`
  (`availableMinor <= 0`) → `will_run_out` (`projectedTotalMinor >=
  envelopeMinor`) → `watch` (`10 * projectedTotalMinor >= 9 * envelopeMinor`,
  i.e. `>= 90%`, strictly below the envelope) → `on_track`.

**Household cash-flow runout** — the more important signal — projects
`onBudgetBalance(today)` (every transaction on on-budget accounts through
today, regardless of `excludedFromBudget`, the same stock-balance rule as the
budget's `onBudgetBalance`) forward 60 days, adding every active recurring
on-budget series's **projected occurrences** in that window as income
(positive) or bills (negative). Occurrences of monthly/quarterly/annual
series are recomputed from the stored `dayOfMonth` anchor for each month
(a 31st bill is the 28th in February and the 31st again in March, never
chained from the clamped date); semimonthly occurrences use both anchor days
(the day of `nextExpectedDate` and of `lastSeenDate`) instead of a fixed
15-day gap; weekly/biweekly add 7/14 days, and subtracting a blended **discretionary pace** (the same
blend, aggregated across all non-recurring, non-transfer, on-budget outflow).
The first day the projected balance drops below
`settings.financeSafetyBufferMinor` is `cashRunoutDate` (`null` if it never
crosses within 60 days).

**Alerts.** `buildFinanceAlerts` ranks: a cash runout inside 14 days
(`critical`, rank 0) → `exhausted` envelopes (`critical`, rank 1) →
`will_run_out` envelopes (`warning`, rank 2) → `watch` envelopes (`info`,
rank 3) → a cash runout further out than 14 days (`warning`, rank 4, still
shown on `/finances` for visibility). Every alert carries a **stable key**
`${kind}:${categoryId-or-"cash"}:${monthKey}` — it does not change as the
same alert's urgency/severity changes day to day, which is what makes the
once-per-day-per-key notification rate limit meaningful.

### Repository surface

`buildFinanceSnapshot(asOfDate)` loads: the current month's
`computeFinanceBudgetState` input/output, on-budget accounts in
`financeBaseCurrency` and every
transaction on them through `asOfDate` (for `onBudgetBalance`), every
on-budget/`excludedFromBudget = 0` transaction through the current month's
`asOfDate` (for pace math — the same filter `budget.ts`'s `activity` uses), the
earliest activity month (for the `lowConfidence` 3-month check), and every
**active** recurring series on those accounts. `computeFinanceForecast(asOfDate)` loads that
snapshot and calls the two pure functions above.

### Alert notification ledger and policy

`finance_alert_notifications` (migration 39) is a tiny additive table —
`(alert_key, notified_on_date)` primary key, `notified_at` — read via
`listNotifiedFinanceAlertKeys(onDate)` and written via
`recordFinanceAlertNotifications(onDate, alertKeys)`. It exists purely to
rate-limit notifications; it is never read by the alerts list on `/finances`
or by `FinanceAlertsCard`, which always show the full current alert set.

`src/lib/finance/alert-notification-policy.ts`'s `evaluateFinanceAlertNotifications`
is pure and patterned after `src/lib/ai/pulse/notification-policy.ts`:
notifies `will_run_out`/`exhausted` envelopes and a cash runout inside 14
days only, **never** `watch`, respects `settings.financeNotifyRunout`, and
skips any alert key already present in the day's ledger.

### Wiring: startup and the local-day boundary

`useLocalDayReconciliation` (`src/app/use-local-day-reconciliation.ts`) now
also takes `financeNotifyRunout`. On the same reconciliation pass that
regenerates recurrences, promotes Scheduled tasks, and snapshots account
balances — which already runs once on mount (the app's "at startup after
bootstrap" trigger) and again at the next local midnight, on window focus,
and on becoming visible — when `financeEnabled && financeNotifyRunout` it
also calls `computeFinanceForecast(today)`, evaluates the notification
policy against today's ledger, sends at most one OS notification per
due alert (every pass re-forecasts and the per-day ledger alone suppresses
keys already delivered; overlapping passes are serialized so none can read the
ledger before another records into it) via `notifyPomodoroCompletion` (the existing
`tauri-plugin-notification` wrapper also used by the Pomodoro and coach-pulse
surfaces — no new plugin, no new capability), and records the keys actually
notified (each key is recorded right after its delivery). No network call is
involved; every failure is caught and logged with a fixed message or counts
only (alert count, notified count — never amounts or the raw error), and this never
blocks the eight-second startup fallback.

### Surfacing

- **`FinanceAlertsCard`** (`src/components/FinanceAlertsCard.tsx`) on Today,
  rendered only when `financeEnabled && financeAlertsOnToday`: the top 3
  alerts by rank plus a link to `/finances`. An empty alert set renders a
  quiet "no alerts" message rather than nothing, so the card's presence
  itself is not a silent all-clear signal that could be confused with "not
  loaded yet". A failed load shows an error banner with a "Réessayer" button
  instead of an empty card.
- **`FinanceOverviewPage`** (`/finances`) gained an "Alertes finances"
  section above the net-worth card, grouped by severity (critical/warning/info),
  showing every alert — not just the top 3.
- **`FinanceBudgetPage`** (`/finances/budget`) shows each envelope's
  `runoutDate` (or status label when there is none) next to its existing
  spent-percentage pace indicator, with a "(estimation provisoire)" suffix
  when `lowConfidence`.
- **Coach context — deferred, not shipped.** The spec allows
  `financeCoachContextEnabled` (default off) to join a compact
  status-and-category-names-only snapshot into the daily pulse payload "only
  if low effort." Given the size of this phase, that integration was
  deliberately skipped: the setting field exists (carried over from an
  earlier phase) and defaults off, but no code reads it yet, and the coach
  pulse payload is unchanged. Phase 8 (AI categorization) shipped
  separately, as the `finance_categorization` surface below — it does not
  touch the coach-pulse payload. Revisit this specific deferral if the
  coach-pulse context is later prioritized.

### Tests

`src/domain/finance/forecast.test.ts` hand-derives every expected number
(mid-month pace, the `elapsedDays < 5` history branch, a rent lump sum
landing on its exact day, median resisting a one-off outlier, an unbudgeted
category producing no alert, the `lowConfidence` + `elapsedDays < 5` + no
history fallback, an already-paid bill counted once, the 89%/91%/100%
status-ladder boundaries, and the household cash-runout date across upcoming
bills/income and a Jan-31-to-Feb-28 month boundary).
`src/lib/finance/alert-notification-policy.test.ts` covers the once-per-day
rate limit, `watch` never notifying, the 14-day cash-runout cutoff, and the
`financeNotifyRunout` flag. `src/lib/storage/repository.contract.ts`'s new
"forecasting and alerts (Phase 7)" block and
`src/lib/storage/migrations/finance-alert-notifications.test.ts` cover
repository parity and the migration. `TodayPage.test.tsx` and
`FinanceAlertsCard.test.tsx` cover the Today card's gating and content.

## AI categorization (Phase 8)

A sixth classification stage, run out-of-band from `classifyTransaction` (see
"Classification pipeline" above): `src/lib/ai/finance-categorization-service.ts`
sends **merchants**, not transactions, to the configured OpenRouter model and
applies the answer back to every matching row. See
[docs/ai-settings-and-privacy.md](ai-settings-and-privacy.md#finance-categorization-finance_categorization)
for exactly what is and is not sent and the gating flags.

### Gating

All three must be true, checked both by the service and by the
`/finances/review` button's `disabled` state:

- `settings.aiEnabled`
- a non-empty `settings.aiApiKey`
- `settings.financeAiCategorizationEnabled`

`settings.aiPayloadScope === "metrics"` additionally disables the stage
entirely (a merchant string is structure, not a metric — see
`buildFinanceCategorizationSnapshots`). With any of these off, every other
classification stage still works: the feature degrades, it does not break.

### Unknown merchants

`AppRepository.listFinanceUnknownMerchants(limit)` (the service asks for 400;
the repository default is 40) is a plain read (no
write transaction) returning merchant-level groups — `merchantKey`, a
representative `sign` (mode), `occurrenceCount`, a representative
`amountMinorSample` (median absolute amount), a representative `accountType`
(mode), and the matching `transactionIds` — for every currently
`category_source != "user"`, non-transfer, `Uncategorized` transaction that
has **no pending suggestion yet** (i.e. stages 2-5 all produced nothing at
all, not even a below-threshold suggestion). Exclusion is per transaction, not
per merchant: a merchant with one suggested and one bare row is still listed,
but its `transactionIds` contain only the bare row. Those ids travel with the
request (`transactionIds` on each snapshot chunk and on
`applyFinanceCategorizationResults`) so apply never touches siblings that were
not part of the request.

### Snapshot and privacy caps

`src/lib/ai/context/finance-categorization-snapshot.ts`'s
`buildFinanceCategorizationSnapshots` sanitizes each unknown-merchant group
into a request item. The "merchant string" sent is the group's `merchantKey`
— i.e. `normalizeDescription(descriptionRaw)`, the same normalized
(uppercased, accent-stripped) descriptor already used for matching — run
through `sanitizeMerchantDescriptor` (strips email addresses, card/account-
looking fragments `\b[\dX*]{6,}\b`, digit runs of 4+ characters, and
phone-number-shaped digit groups) and clamped to 60 characters. **This
removes structured identifiers only, not every piece of personal
information**: a counterparty name, a partial address, or any other plain
word present in the original description is sent as-is (e.g. an e-transfer
line like "INTERAC E-TRANSFER JEAN DUPONT" keeps the name). It also buckets
the representative amount into `<10`/`10-50`/`50-200`/`200-1000`/`>1000`
(base currency, integer-minor-unit comparisons only, never a float
division). A group's `amountMinorSample` is a median over its most common
currency only (`FinanceUnknownMerchantGroup.currency`); when that currency is
not the base currency there is no FX conversion, so the bucket is `unknown`. It then chunks the sanitized list into one or more requests of
**at most 40 merchants and 16 KiB of serialized JSON each** — an over-cap
batch is split into more requests, never truncated — each paired with a
`merchantKeyMap` (sanitized request key -> original `merchant_key`
value(s), needed because sanitization can rarely make two distinct
merchants collide on the same text) so results can be applied back to the
right rows. Collision suffixes (`#2`, `#3`, …) are allocated against every key
already in use, so a suffixed key can never equal another merchant's real key.
If the category list alone exceeds 16 KiB, no request is built at all (fail
closed), and a single merchant that cannot fit in an empty chunk is skipped.

### Service, cache, and the schema

`FinanceCategorizationService.classifyPending(repository, settings)`
(`FINANCE_CATEGORIZATION_PROMPT_VERSION = "finance_categorization.v1"`)
lists unknown merchants, builds the snapshot chunks, and for each chunk:
caches by `buildAiInputHash({ promptVersion, scope, snapshot })` exactly like
`GoalPacingService` (a cached answer that only collides with recently dismissed
suggestions creates nothing and is treated as a cache miss, so the provider is
called again); when AI is unconfigured, persists a `status: "skipped"`
`AiMessage` and applies nothing; otherwise calls the provider, does **one**
repair round-trip on invalid JSON (`finance-categorization-validator.ts`
rejects an out-of-list category id, a merchant key outside the request, a
confidence outside `[0, 1]`, an extra field on a merchant object, a
duplicated merchant key, or a response that does not contain exactly one entry
per requested merchant, so an empty or contradictory answer goes to repair and
then fallback instead of being cached as `ok`; extra top-level keys are
ignored). Validator errors and the service's `warning` are constant,
value-free strings (never a merchant descriptor or provider error text),
because callers log them, persists `status: "ok"` or
`"fallback"`, and — on a valid response — applies the result. Every run
(including `"skipped"`) is persisted via `saveCoachPulseEpisode` exactly like
`GoalPacingService`'s `ok`/`fallback` rows, so it is picked up by the
existing AI cost/usage dashboard (`computeAiUsageForMonth`) with no surface
-specific code there. `finance-categorization-loader.ts` can hydrate the most
recent run (any scope), rejecting a stale prompt version like every other
surface's loader; no screen calls it yet.

### Applying results

`AppRepository.applyFinanceCategorizationResults` is the one short exclusive
block (one `BEGIN IMMEDIATE`) that writes the outcome. For each result, for
each of its original merchant key(s) (via `merchantKeyMap`):

- If `(merchantKey, categoryId)` was dismissed in the last 90 days
  (`src/lib/finance/dismissed-suggestions.ts`, the same window memory/seed
  suggestions honor), nothing is written for **any** transaction under that
  merchant key — `suppressedDismissed` counts the merchant key once, not
  the number of transactions it would otherwise have touched.
- Otherwise, for every currently-eligible transaction under that merchant
  key (`category_source != "user"`, not a transfer, still `Uncategorized`)
  that is in the request's `transactionIds` **and** has no pending suggestion
  (one may have appeared during the AI round trip — existing pending
  suggestions are never overwritten),
  a `finance_category_suggestions` row is always written (`origin: "ai"`,
  with `rationale`, `model`, `promptVersion`).
- When `settings.financeAiAutoApplyEnabled` **and**
  `result.confidence >= settings.financeAiAutoApplyMinConfidence` both hold
  (and, by construction, the row was never user-set or already decided by a
  stronger stage), the transaction's category is set directly
  (`category_source = "ai"`) and that same suggestion row is written as
  already `"accepted"` instead of being left in the review queue — there is
  nothing left for the user to decide. Otherwise the suggestion is left
  `"pending"` for `/finances/review`.

A `category_source = "user"` row is never a candidate in the first place (it
never appears in `listFinanceUnknownMerchants`, and
`applyFinanceCategorizationResults`'s eligibility check re-verifies this),
matching the absolute invariant every other automatic stage honors.

### Run triggers

Only two, both explicit — **never** a timer, **never** at startup:

1. After `FinanceImportPage`'s import call resolves (outside the import's own
   transaction), when `financeAiCategorizationEnabled` is on. A failure here
   is logged (counts only) and never surfaces as an import error — the
   import itself already succeeded.
2. The "Classer les en attente (IA)" button on `/finances/review`, with an
   explicit cost-hint tooltip.

### Settings UI

`SettingsPage`'s "Finances" section gained `financeAiCategorizationEnabled`,
`financeAiAutoApplyEnabled`, and `financeAiAutoApplyMinConfidence` (accepts a
comma or dot decimal; a value outside `[0, 1]` or unparsable aborts the save
with `finance.aiAutoApplyMinConfidenceInvalid`, like the safety buffer) — all three rendered `disabled` (not hidden) while
`settings.aiEnabled` is false, with a helper line stating the dependency.

## Related documentation

- [Storage and backups](storage-and-backups.md#finance-tables)
- [Conventions](conventions.md) (minor-units rule)
- [AI settings and privacy](ai-settings-and-privacy.md#finance-categorization-finance_categorization)
- [specs/done/finance.md](../specs/done/finance.md) — the full phased spec, now shipped

## Suggestion lifecycle (Phase 4 review fixes)

A pending suggestion is retired (deleted) when a newer category decision supersedes
it: a manual `setFinanceTransactionCategory` (including `all_matching` backfilled
rows) or a rule/transfer outcome during reclassification. A reclassification that
proposes a different category updates the pending row instead of keeping the stale
one, and one that proposes nothing drops non-AI pending rows.
`decideFinanceCategorySuggestion` only acts on `pending` suggestions; repeating it on
a decided one is a no-op, so merchant memory is never reinforced twice. The review
page also disables its actions while one is running. When several enabled rules
match, `addLabels` is the deduplicated union across all of them. The transactions
page keeps the last bulk-undo banner through unrelated single-row edits.
