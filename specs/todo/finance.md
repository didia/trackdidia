# Spec — Household Finances (Mint-style tracking + YNAB-style envelope budgeting)

**Status:** draft, unshipped.
**Scope:** add a household finance domain to TrackDidia: CSV transaction import, heuristic + learned + AI categorization with a suggestion queue, multi-person / multi-account tracking, net worth, cash flow, trends, recurring-bill detection, category reports, YNAB-style zero-based envelope budgeting with rollover, and proactive budget-runout forecasting surfaced on Today and to the coach.

## Context

TrackDidia is a local-first personal OS: a Tauri v2 desktop app (React 18 + TypeScript, Vite 5, Vitest 2, Biome) whose only durable store is a SQLite file in the macOS app-data directory for `com.trackdidia.desktop`. Every data access goes through `AppRepository` (`src/lib/storage/repository.ts`, 327 lines), implemented by `TauriSqliteRepository` (4 878 lines) on desktop and `MemoryRepository` (2 083 lines) for browser preview and the eight-second startup fallback. Schema changes are append-only entries in the `migrations` array; **the highest shipped id is 33 (`add_weekly_objective_starts_on_week_start_date`)**.

Finance is the first domain in the app that is not about time. It brings three things the existing domains do not have: money arithmetic (which must never be floating point), a user-supplied external file format, and a learning loop where the user's corrections change future automatic behavior. It also brings the largest single schema addition since email triage.

Three existing precedents carry most of the design:

1. **Email triage** is the template for a large subsystem: migration 29 creates ten tables in one migration, and the row mapping/query code lives in `src/lib/storage/email-triage-sqlite-store.ts` (1 282 lines) and `email-triage-memory-store.ts` (615 lines), reached through thin delegating methods on both repositories (`getEmailTriageStore()` at `tauri-sqlite-repository.ts:1078`). Finance follows this exactly rather than adding ~2 000 lines to `tauri-sqlite-repository.ts`.
2. **The AI surface pattern** — `GoalPacingService` + `loadLatestGoalPacing` — is the template for a cached, fallback-first model call: snapshot → `buildAiInputHash` → `ai_messages` cache lookup → local fallback when AI is unconfigured → one repair round-trip on invalid JSON → persisted as `ok` / `fallback` / `skipped`.
3. **One-time idempotent normalizations gated by a settings marker** (`gtdReferencesMigrationDoneAt`, `gtdScheduledNormalizationDoneAt` in `app-context.tsx`) is the template for seeding the default category taxonomy without freezing seed data inside a migration.

## Decisions

| Decision | Choice |
|---|---|
| Money representation | `INTEGER` minor units + ISO-4217 `currency` on every row. No floats anywhere, including intermediate arithmetic. |
| Sign convention | Negative = outflow, positive = inflow, on every account type including credit cards and loans. |
| Multi-currency | Single `financeBaseCurrency` (default `CAD`) in v1. Non-base-currency accounts are *storable* but excluded from cross-account rollups, with a visible banner. FX conversion is out of scope. |
| Household model | `finance_people` rows; accounts carry `owner_person_id` (nullable) + `ownership` (`individual` \| `joint`); transactions carry an optional `person_id` for "who spent it". Budgets are household-wide; person is a report/filter dimension, not a separate budget. |
| Ingest | CSV only, user-initiated. No bank APIs, no Plaid, no scraping, no scheduled fetch. |
| Storage of raw import | Original description and the raw CSV row are retained per transaction; the source file itself is not copied into the app directory. |
| Classification order | user rules → transfer detection → learned merchant memory → bundled seed heuristics → AI → `Uncategorized`. |
| AI role | **Suggestion-only by default.** AI never overwrites a user-set or rule-set category. Auto-apply is opt-in and threshold-gated. |
| AI transport | New `AiSurface` `"finance_categorization"` on the existing `AiProvider.generateStructured` path, not a separate classifier provider. |
| AI payload unit | Anonymized **merchant descriptors**, not transactions. No balances, no account numbers, no person names, no dates, no exact amounts. |
| Budget model | YNAB: monthly envelopes, explicit assignment, positive rollover by default, per-category overspend policy. |
| Credit-card payment categories | **Out of scope in v1.** Cards are on-budget, purchases hit the category, payments are transfers. Documented simplification. |
| Splits | Separate `finance_transaction_splits` table; the parent keeps the full amount and reports expand splits when present. |
| Forecasting | Pure functions in `src/domain/finance/`, blending current-month pace with a trailing-3-month median, plus known recurring bills as lump sums. |
| Navigation | One sidebar entry "Finances" with in-page tabs, not seven new sidebar rows. |
| Feature flag | `financeEnabled`, **default `false`**. Nav entry and bootstrap work are hidden until enabled. Conditional nav is a **new** pattern: `AppShell.tsx` today renders a flat, ungated item array (email triage is always visible), so `AppShell` must read `settings` from `useAppContext()` and filter; `/finances*` routes stay registered but redirect to `/` while `financeEnabled` is false, so stale bookmarks do not 404. |
| Balances | Always **derived**: `opening_balance_minor` + Σ transactions. `current_balance_minor` / statement balances are reconciliation checks that surface a discrepancy banner and never feed budget arithmetic. |
| Migration | Single migration **id 34**, `add_finance_foundation`. |

### Out of scope (v1)

Bank/OFX/QFX/QIF connections, investment holdings and cost basis, tax lots or tax reporting, bill *payment*, debt-payoff planners, loan amortization schedules, multi-currency conversion, goals/targets on categories (YNAB "Targets"), shared/multi-device access to finance data, receipt capture or OCR, mobile.

### Assumptions (state, do not silently rely on)

- The Mint CSV export header is `"Date","Description","Original Description","Amount","Transaction Type","Category","Account Name","Labels","Notes"`, with `Amount` always positive and the sign carried by `Transaction Type` (`debit`/`credit`), and `Date` in `M/D/YYYY`. **Verify against a real export before implementing the Mint profile**; the generic mapping path must be able to express whatever the real file turns out to be, so a mismatch is a profile fix, not a redesign.
- The user's household is small (2 adults), account count is under ~20, and lifetime transaction volume is in the tens of thousands — small enough that report aggregation in SQL over the full table is fine, and no pre-aggregation tables are needed.
- The user's base currency is CAD.

### Open questions

1. *(Resolved — see the Balances decision.)* Confirm the UX only: the account form asks for an opening balance as of a date.
2. Should AI categorization default to enabled once the user has already enabled AI globally? The spec says no (separate `financeAiCategorizationEnabled`, default off) because finance data is more sensitive than daily metrics.
3. Credit-card handling (§Budget) is deliberately simplified. If the household carries balances month to month, YNAB's payment-category model may be needed in v2.
4. Whether `/finances` should appear in the coach's daily pulse context at all, or only as a standalone Today card. Spec ships the Today card first and puts coach context behind `financeCoachContextEnabled` (default off).

## Data model

All finance tables are prefixed `finance_`. Ids are client-generated TEXT primary keys via `createEntityId("finance-account")` etc. (`src/lib/gtd/shared.ts`), matching existing entity conventions. All dates are local `YYYY-MM-DD`; all timestamps are ISO strings from `nowIso()`.

```
finance_people(id, display_name, color, archived, created_at, updated_at)

finance_accounts(
  id, name, institution, type, currency, owner_person_id, ownership,
  on_budget, closed, opening_balance_minor, current_balance_minor,
  balance_as_of, external_key, notes, sort_order, created_at, updated_at)
  -- type: checking|savings|cash|credit_card|line_of_credit|loan|mortgage|investment|asset|other
  -- ownership: individual|joint
  -- on_budget: 1 for cash + credit accounts that participate in envelopes
  -- external_key: the account label as it appears in imported files (UNIQUE, nullable)

finance_categories(
  id, name, parent_id, kind, archived, is_system, defers_to_next_month,
  sort_order, created_at, updated_at)
  -- kind: expense|income|transfer|internal
  -- parent_id NULL = category group (YNAB "group" == Mint top-level)
  -- is_system: Uncategorized (kind 'expense'), Transfer (kind 'transfer'),
  --            Split (kind 'internal')
  -- defers_to_next_month: 1 only on kind='income' categories; drives the
  --                       deferredIncome terms of readyToAssign

finance_transactions(
  id, account_id, posted_date, amount_minor, currency,
  description_raw, description_original, merchant_key, merchant_display,
  category_id, category_source, category_confidence, categorized_at,
  person_id, notes, labels_json, pending,
  is_transfer, transfer_group_id,
  excluded_from_budget, excluded_from_reports,
  has_splits, import_batch_id, dedupe_hash, source_row_json,
  created_at, updated_at)
  -- category_source: user|rule|memory|seed|ai|default
  -- UNIQUE(account_id, dedupe_hash)

finance_transaction_splits(
  id, transaction_id, amount_minor, category_id, notes, sort_order, created_at)
  -- invariant: SUM(amount_minor) = parent amount_minor, enforced in the engine

finance_rules(
  id, name, priority, enabled, matcher_json, actions_json,
  created_at, updated_at, last_applied_at, applied_count)
  -- matcher_json: {descriptionContains?, descriptionRegex?, accountIds?, personId?,
  --                amountMinMinor?, amountMaxMinor?, sign?}
  -- actions_json: {categoryId?, merchantDisplay?, personId?, markTransfer?,
  --                excludeFromBudget?, excludeFromReports?, addLabels?}

finance_merchant_memory(
  merchant_key, account_id, sign, category_id, hit_count, correction_count,
  confidence, source, last_applied_at, created_at, updated_at)
  -- PRIMARY KEY(merchant_key, account_id, sign); account_id '' = any account
  -- source: seed|auto_confirm|user_correction

finance_category_suggestions(
  id, transaction_id, merchant_key, suggested_category_id, confidence,
  origin, rationale, model, prompt_version, status, decided_at, created_at)
  -- origin: memory|seed|ai
  -- status: pending|accepted|corrected|dismissed
  -- UNIQUE(transaction_id) WHERE status='pending'

finance_budget_entries(
  month_key, category_id, assigned_minor, overspend_policy, note, updated_at)
  -- PRIMARY KEY(month_key, category_id); month_key = 'YYYY-MM'
  -- overspend_policy: reduce_next_ready_to_assign|carry_negative

finance_budget_months(month_key, ready_to_assign_note, closed_at, updated_at)

finance_recurring_series(
  id, merchant_key, account_id, category_id, cadence, expected_amount_minor,
  amount_tolerance_minor, day_of_month, last_seen_date, next_expected_date,
  occurrence_count, status, confirmed_by_user, created_at, updated_at)
  -- cadence: weekly|biweekly|semimonthly|monthly|quarterly|annual
  -- status: active|paused|ended

finance_account_balance_snapshots(account_id, as_of_date, balance_minor, source, created_at)
  -- PRIMARY KEY(account_id, as_of_date); source: derived|statement|manual

finance_import_profiles(
  id, name, signature, column_map_json, date_format, amount_mode, sign_convention,
  default_account_id, created_at, updated_at, last_used_at)
  -- signature: stable hash of the normalized header row (UNIQUE)
  -- amount_mode: single_signed|debit_credit_columns|amount_with_type_column

finance_import_batches(
  id, profile_id, file_name, file_hash, account_id, row_count,
  imported_count, duplicate_count, skipped_count, error_count,
  status, error_summary, started_at, finished_at)
```

TypeScript mirrors live in `src/domain/finance.ts` (types only, like `src/domain/email-triage.ts`), not in the already-large `src/domain/types.ts`. `AppSettings` in `src/domain/types.ts` gains the finance flags (below), because that type is the single settings blob.

### Money

`src/lib/finance/money.ts` — pure, no I/O:

- `Money = { amountMinor: number; currency: string }`.
- `currencyExponent(code)` from a small static table (CAD/USD/EUR = 2, JPY = 0), defaulting to 2 with a warning-free fallback.
- `parseAmountToMinor(text, { exponent, decimalSeparator, thousandsSeparator })` handling `1,234.56`, `1 234,56`, `(45.00)` (accounting negative), leading `$`/`CA$`, trailing `CR`/`DR`, and unicode minus `−`. Returns a discriminated result, never `NaN`.
- `formatMoney(money, locale = "fr-CA")` via `Intl.NumberFormat`, and `formatMoneySigned` for report columns.
- `addMoney`/`sumMoney` assert a single currency and throw on mixing — a loud failure is correct here.

**Every amount in the codebase is minor units.** No helper accepts or returns a decimal number. Add a Biome-visible convention note in `docs/conventions.md`.

## Migrations

**Migration 34, `add_finance_foundation`**, creates every table above plus indexes:

```
idx_finance_txn_account_date      ON finance_transactions(account_id, posted_date)
idx_finance_txn_date              ON finance_transactions(posted_date)
idx_finance_txn_category_date     ON finance_transactions(category_id, posted_date)
idx_finance_txn_merchant          ON finance_transactions(merchant_key)
idx_finance_txn_batch             ON finance_transactions(import_batch_id)
idx_finance_txn_transfer_group    ON finance_transactions(transfer_group_id)
uniq_finance_txn_dedupe           UNIQUE ON finance_transactions(account_id, dedupe_hash)
idx_finance_splits_txn            ON finance_transaction_splits(transaction_id)
uniq_finance_suggestion_pending   UNIQUE ON finance_category_suggestions(transaction_id)
                                  WHERE status = 'pending'
idx_finance_suggestions_status    ON finance_category_suggestions(status, created_at)
idx_finance_budget_month          ON finance_budget_entries(month_key)
idx_finance_recurring_next        ON finance_recurring_series(status, next_expected_date)
uniq_finance_profile_signature    UNIQUE ON finance_import_profiles(signature)
uniq_finance_account_external_key UNIQUE ON finance_accounts(external_key)
                                  WHERE external_key IS NOT NULL
```

Notes and constraints:

- **No `ALTER TABLE` on any existing table.** Finance is purely additive, so a finance defect cannot damage GTD, review, or Pomodoro rows.
- `id: 34` is the next free id. ⚠️ `specs/todo/mobile-and-sync.md` also claims id 33 for its sidecar tables; that spec predates migration 33 and is stale. Whichever lands first takes the next free integer and the other must be renumbered **in its spec, before implementation** — never after shipping.
- Category seeds are **not** in the migration. `src/lib/finance/default-categories.ts` holds a deterministic list with fixed ids (`fincat:alimentation`, `fincat:alimentation.epicerie`, …). `AppProvider` applies it once, idempotently, gated on `settings.financeCategoriesSeededAt`, exactly like the GTD normalizations. Re-running it is a no-op because the ids are fixed and inserts are `INSERT OR IGNORE`.
- The `Uncategorized` (`fincat:non-categorise`), `Transfer` (`fincat:transfert`), and `Split` system categories are inserted by migration 34 itself, because engine code hard-references those ids.
- `MemoryRepository`'s in-memory finance store must be created with the same seeds so browser-preview tests see the same taxonomy.

## Repository methods

New methods on `AppRepository` (all return `Promise<T>`; signatures below omit it for brevity), implemented in **both** classes and delegated to `FinanceSqliteStore` / `FinanceMemoryStore`, mirroring `getEmailTriageStore()`:

```
// household + accounts
listFinancePeople(): FinancePerson[]
saveFinancePerson(person): FinancePerson
listFinanceAccounts(filters?): FinanceAccount[]
saveFinanceAccount(account): FinanceAccount
closeFinanceAccount(id): FinanceAccount

// categories + rules + memory
listFinanceCategories(includeArchived?): FinanceCategory[]
saveFinanceCategory(category): FinanceCategory
archiveFinanceCategory(id, reassignToId): number   // returns rows reassigned
listFinanceRules(): FinanceRule[]
saveFinanceRule(rule): FinanceRule
deleteFinanceRule(id): void
listFinanceMerchantMemory(filters?): FinanceMerchantMemoryEntry[]
upsertFinanceMerchantMemory(entry): FinanceMerchantMemoryEntry
forgetFinanceMerchantMemory(merchantKey, accountId, sign): void

// transactions
listFinanceTransactions(filters): FinanceTransaction[]
  // filters: dateFrom/dateTo, accountIds, categoryIds, personIds, search,
  //          uncategorizedOnly, includeTransfers, limit, offset
countFinanceTransactions(filters): number
getFinanceTransaction(id): FinanceTransaction | null
saveFinanceTransaction(txn): FinanceTransaction
setFinanceTransactionCategory(input: {
  transactionId, categoryId, scope: "this" | "this_and_future" | "all_matching"
}): { updated: number; memory: FinanceMerchantMemoryEntry | null }
bulkUpdateFinanceTransactions(ids, patch): number
saveFinanceTransactionSplits(transactionId, splits): FinanceTransaction
setFinanceTransfer(pair: { transactionIdA, transactionIdB } | null, groupId?): void

// import
listFinanceImportProfiles(): FinanceImportProfile[]
saveFinanceImportProfile(profile): FinanceImportProfile
findFinanceImportProfileBySignature(signature): FinanceImportProfile | null
importFinanceTransactions(input: FinanceImportRequest): FinanceImportSummary
listFinanceImportBatches(limit?): FinanceImportBatch[]
undoFinanceImportBatch(batchId): number   // deletes only rows created by that batch

// classification queue
listFinanceCategorySuggestions(status?, limit?): FinanceCategorySuggestion[]
saveFinanceCategorySuggestions(suggestions): FinanceCategorySuggestion[]
decideFinanceCategorySuggestion(id, decision: {
  status: "accepted" | "corrected" | "dismissed"; categoryId?: string
}): FinanceCategorySuggestion

// budget
getFinanceBudgetMonth(monthKey): FinanceBudgetMonthData
setFinanceBudgetAssignment(monthKey, categoryId, assignedMinor): FinanceBudgetEntry
setFinanceCategoryOverspendPolicy(monthKey, categoryId, policy): void
  // writes the policy on the (monthKey, categoryId) entry and every later existing
  // entry for that category; the policy is read per month by carryIn
computeFinanceBudgetState(monthKey): FinanceBudgetState   // envelopes + Ready to Assign

// reporting / forecasting inputs
computeFinanceNetWorth(asOfDate): FinanceNetWorthSnapshot
computeFinanceCashFlow(monthKey): FinanceCashFlowSummary
computeFinanceCategorySpend(range, groupBy): FinanceCategorySpendRow[]
computeFinanceMerchantSpend(range, limit): FinanceMerchantSpendRow[]
computeFinanceTrend(range, granularity): FinanceTrendPoint[]
listFinanceRecurringSeries(status?): FinanceRecurringSeries[]
saveFinanceRecurringSeries(series): FinanceRecurringSeries
snapshotFinanceAccountBalances(asOfDate): number
buildFinanceSnapshot(asOfDate): FinanceSnapshot   // the forecast/alert input bundle
```

All `compute*` methods fetch rows and delegate to the **same** pure function in `src/domain/finance/` in both implementations, as `computeWeeklyReviewSummary` does — never a SQL `GROUP BY` in one class and a JS reduce in the other.

⚠️ **Write-path discipline.** `TauriSqliteRepository` serializes writes through `DbSerialQueue` (`private readonly writeQueue` at line 1073; `runExclusive` at line 1103) and `DbSerialQueue.run()` errors on reentrancy with a 15-second watchdog. `importFinanceTransactions` — which inserts thousands of rows, runs transfer detection, and writes suggestions — must be **one** `runExclusive` block issuing `BEGIN IMMEDIATE` once and calling internal helpers. It must never call the public `saveFinanceTransaction` / `setFinanceTransactionCategory`, each of which takes the queue itself.

Batch inserts should use multi-row `INSERT … VALUES (…),(…)` chunked to ≤ 200 rows per statement to stay under SQLite's parameter limit while keeping a 10 000-row import to tens of statements rather than tens of thousands.

## CSV import

### Getting the file into the app

There is currently **no** `@tauri-apps/plugin-fs` dependency and no existing file-content import UI — `importGoogleTasksExport` exists on the repository but has no call site, and the only `@tauri-apps/plugin-dialog` use is folder selection for the backup destination (`SettingsPage.tsx:804`). Use a plain `<input type="file" accept=".csv,text/csv" multiple>` plus `File.text()`. It works in the WKWebView, needs no new plugin, no new capability, and no new Rust command, and it is directly testable with Testing Library. Decode as UTF-8 and strip a BOM; if the decoded text contains U+FFFD, retry as `windows-1252` via `TextDecoder` and tell the user which encoding was used.

### Parsing

`src/lib/finance/csv.ts` — a hand-rolled RFC 4180 parser (no new dependency):

- Quoted fields, doubled quotes, embedded commas and newlines, `\r\n` / `\n` / `\r`.
- Delimiter sniffing across `,` `;` `\t` using the header line.
- Returns `{ header: string[]; rows: string[][]; warnings: string[] }` and never throws on a malformed row — a short/long row is reported as a skipped row with its line number.

`src/lib/finance/import-profile.ts`:

- `buildHeaderSignature(header)` — lowercase, trim, strip accents/punctuation, join with `|`, then hash with the 128-bit hash below. Stored on the profile and used for auto-recognition of a repeat export.
- `MINT_PROFILE` — a bundled profile matching the Mint header, `amount_mode: "amount_with_type_column"`, `date_format: "M/D/YYYY"`, mapping `Account Name → external_key`, `Original Description → description_original`, `Category → an import-time category hint`, `Labels → labels_json`, `Notes → notes`.
- Additional bundled profiles are cheap to add later; the generic path covers everything in the meantime.

### Mapping UI

If no profile matches the signature, `/finances/import` shows the first 20 parsed rows and asks the user to map: date, description, original description (optional), amount (single signed column **or** debit + credit columns **or** amount + type column), account (a column, or one account for the whole file), category hint (optional), notes, labels. Date format is inferred from the sample with an explicit override (`M/D/YYYY`, `D/M/YYYY`, `YYYY-MM-DD`) — and **ambiguity must be surfaced**: if every sampled day ≤ 12, the inference is unreliable and the UI must ask rather than guess. The saved profile is reused automatically next time.

Account binding: an unknown `external_key` offers "create account" or "map to existing account", and the choice is persisted on `finance_accounts.external_key` so later imports bind silently.

### Dedupe and idempotent re-import

```
dedupeHash = hash128(join("", [
  accountId,
  postedDate,                       // normalized YYYY-MM-DD
  String(amountMinor),
  currency,
  normalizeDescription(descriptionRaw),
  String(occurrenceIndex)           // 0-based index among identical keys *within this file*
]))
```

`normalizeDescription` uppercases, strips accents, collapses whitespace, and removes trailing reference/auth numbers (`#\d{4,}`, `\bREF\s*\d+`) — the same normalizer that produces `merchant_key`, so dedupe and classification agree on identity.

`occurrenceIndex` is what makes two genuinely identical same-day coffees both survive, while a re-import of the same file produces the same two hashes and therefore zero new rows. Insert with `INSERT … ON CONFLICT(account_id, dedupe_hash) DO NOTHING` and count the difference as duplicates.

⚠️ `src/lib/hash.ts`'s `hashString` is a 32-bit non-cryptographic hash. At 10 000 transactions the birthday collision probability is ~1 %, and a collision here silently **drops a real transaction**. Add `src/lib/finance/hash.ts` with a 128-bit FNV-1a (or xxhash64 pair) returning a hex string. Do not use WebCrypto `subtle.digest`: it is async and not reliably exposed under the jsdom test environment.

**Near-duplicates (pending → posted drift).** A transaction exported while pending and re-exported after posting can change date and/or description and would insert twice. After the exact-hash dedupe, a near-duplicate pass flags rows with the same account, identical `amount_minor`, `|dateDiff| ≤ 3` and description similarity above a threshold vs. an existing row: they are inserted but listed for review in the import summary, **never silently merged**. The inverse tradeoff is accepted: two genuinely identical same-day transactions split across two files both get `occurrenceIndex = 0` and collide, so suppressed duplicates are listed in the summary with a "keep anyway" action rather than only counted.

**Overlapping exports** (the common case — each monthly export repeats the prior month) therefore merge cleanly. `undoFinanceImportBatch` deletes only rows whose `import_batch_id` matches **and** whose `category_source` is not `user`, so an undo cannot destroy manual work; rows it refuses to delete are reported back to the user. Cross-batch hole: if a later batch deduped against a row of this batch, deleting it would remove a transaction that later batch still covers, so undo is **restricted to the most recent batch** for an account. Cascade: delete the rows' splits and pending suggestions; repair the transfer group of a surviving partner (clear `is_transfer`/`transfer_group_id`, restore its category to a pending suggestion); rows undo refuses to delete keep their `import_batch_id` and are reported.

### Transfer detection

After insert, within the same transaction, `src/lib/finance/transfers.ts` (pure, given candidate rows):

1. Consider only transactions in **different** accounts, not already in a transfer group, not excluded.
2. Pair `a` with `b` when `a.amountMinor === -b.amountMinor`, same currency, and `|dateDiffDays| ≤ 3`.
3. When several candidates match, prefer the smallest date difference, then the closest description similarity (shared token count), then the lowest id for determinism.
4. A matched pair gets a shared `transfer_group_id`, `is_transfer = 1`, `category_id = fincat:transfert`, `category_source = 'rule'`. A transfer is budget-neutral (`excluded_from_budget = 1`) **only when both legs are on-budget accounts**. When exactly one leg is on-budget (e.g. checking → off-budget investment), that leg keeps `excluded_from_budget = 0` and, until the user picks a real category, carries `category_id = fincat:non-categorise` (kind `expense`) with a pending suggestion — **not** `fincat:transfert`, whose kind is outside `Σ available` and would make Ready to Assign drop with nothing to point at.
5. Description keywords (`VIREMENT`, `TRANSFER`, `PAIEMENT CARTE`, `PAYMENT - THANK YOU`, `AUTOMATIC PAYMENT`) raise a single-sided transaction to *probable transfer* — marked `is_transfer = 1` but left `excluded_from_budget = 0` with `category_id = fincat:non-categorise` and a pending suggestion, so it stays visible in the budget until the user confirms; confirming sets `excluded_from_budget = 1` (or binds the missing leg). An unmatched "transfer" that is actually a real expense must never silently vanish from the budget.

Detection runs across the whole history, not just the batch, because the two legs of one transfer frequently arrive in different files.

### Import summary

`FinanceImportSummary = { batchId, rowCount, imported, duplicates, skipped, errors, newAccounts, transfersDetected, pendingSuggestions, warnings[] }`, rendered as a result panel and persisted in `finance_import_batches`.

## Classification pipeline

`src/lib/finance/classify.ts` exposes one pure function:

```
classifyTransaction(txn, context): ClassificationOutcome
// context: { rules, memory, seeds, categories, thresholds }
// outcome: { categoryId, source, confidence, suggestion? }
```

Order, highest authority first — **the first stage that produces a category wins**:

1. **User-set** (`category_source === "user"`). Never touched by any automatic stage, ever. This is the invariant that makes the learning loop trustworthy.
2. **User rules** (`finance_rules`, ordered by `priority` then id). Deterministic, confidence `1.0`, `source = "rule"`.
3. **Transfer detection** result (above).
4. **Learned merchant memory.** Lookup order: exact `(merchantKey, accountId, sign)` → `(merchantKey, "", sign)` → `(merchantKey, "", 0)`. Auto-applies when `confidence ≥ 0.85` **and** `hit_count ≥ 2`; otherwise writes a pending suggestion. `source = "memory"`.
5. **Bundled seed heuristics** — `src/lib/finance/seed-heuristics.ts`, an ordered list of `{ pattern: RegExp, categoryId, confidence }` for merchants that are unambiguous in the Canadian/French context (grocery chains, fuel, telecoms, transit, streaming, pharmacy). Confidence caps at `0.7`, so a seed always produces a **suggestion**, never a silent auto-apply. Seeds are a convenience, not truth; the user's memory always outranks them.
6. **AI** (below) — always writes a suggestion; auto-applies only when `financeAiAutoApplyEnabled` is on and `confidence ≥ financeAiAutoApplyMinConfidence` (default `0.9`).
7. **`Uncategorized`**, `source = "default"`.

### Learning from corrections

`setFinanceTransactionCategory` is the single learning entry point:

- Writes `category_id`, `category_source = "user"`, `categorized_at`.
- Upserts `finance_merchant_memory` for `(merchant_key, accountId|"" , sign)`: on agreement with the existing entry, `hit_count += 1` and `confidence = min(0.99, confidence + 0.05)`; on disagreement, replace the category, set `correction_count += 1`, and **reset** confidence to `0.6` so one correction does not immediately become an auto-apply.
- `scope` controls blast radius: `"this"` (default), `"this_and_future"` (memory only, no backfill), `"all_matching"` (also recategorizes existing transactions with the same `merchant_key` whose `category_source !== "user"`, reporting the count and offering a single undo).
- Accepting a suggestion is the same path with `origin` recorded, so accepted AI suggestions reinforce memory exactly like manual edits. Dismissing a suggestion records a negative signal: the `(merchantKey, suggestedCategory)` pair is suppressed for future AI suggestions for 90 days.

### AI stage

New `AiSurface` member `"finance_categorization"`. Adding it is a typed, compiler-enforced change — `SURFACE_LABELS: Record<AiSurface, string>` in `src/lib/ai/analytics/proposal-analytics.ts:58` is exhaustive, so the build fails until the surface is labeled, and `PROMPT_REGISTRY` in `src/lib/ai/prompts/registry.ts` must gain an entry.

Files, following the `goal-pacing-*` pair exactly:

- `src/lib/ai/context/finance-categorization-snapshot.ts` — builds the payload.
- `src/lib/ai/proposals/finance-categorization-schema-prompt.ts` — the JSON schema block listing the **allowed category ids**, exactly as `buildGoalPacingSchemaPrompt(goalIds)` does.
- `src/lib/ai/proposals/finance-categorization-validator.ts` — strict parse; rejects unknown category ids, unknown merchant keys not present in the request, confidences outside `[0,1]`, and extra fields.
- `src/lib/ai/finance-categorization-service.ts` — `FINANCE_CATEGORIZATION_PROMPT_VERSION = "finance_categorization.v1"`, cache via `buildAiInputHash`, one repair round-trip, `ok`/`fallback`/`skipped` statuses, persisted through `saveCoachPulseEpisode(message, [])` like `GoalPacingService`.
- `src/lib/ai/finance-categorization-loader.ts` — hydration, with the same stale-prompt-version rejection.
- Branch in `buildSystemPrompt` in `src/lib/ai/openrouter-provider.ts` and a new member of the `AiStructuredRequest` union in `src/lib/ai/provider.ts`.

**The unit of work is the merchant, not the transaction.** One request covers up to 40 unknown merchants; the response maps `merchantKey → { categoryId, confidence, rationale }`, and the result is applied to every pending transaction sharing that key. This cuts cost by roughly the number of transactions per merchant and, more importantly, bounds what leaves the machine.

Privacy limits, enforced in the snapshot builder and covered by a test that asserts the serialized payload:

- **Sent:** sanitized merchant string, transaction sign, occurrence count, an amount **bucket** (`<10`, `10-50`, `50-200`, `200-1000`, `>1000` in base currency), account **type** (`checking`, `credit_card`, …), and the allowed category id/name list.
- **Never sent:** account names, institutions, account numbers, balances, net worth, person names, exact amounts, dates, notes, labels, or full descriptions.
- Merchant sanitization strips digit runs of length ≥ 4, email addresses, anything that looks like a card or account fragment (`\b[\dX*]{6,}\b`), and clamps to 60 characters.
- Payload is capped at 16 KiB; over-cap requests are split, not truncated.
- `aiPayloadScope === "metrics"` disables the AI stage entirely (merchant strings are structure, not metrics).
- Gated by `settings.aiEnabled && settings.aiApiKey && settings.financeAiCategorizationEnabled`, all three. With AI off, stages 1–5 and `Uncategorized` still work — the feature degrades, it does not break.
- The OpenRouter key is never logged. Note that `OpenRouterProvider.generateStructured` calls `fetch` directly (line 341) rather than going through `src-tauri/src/provider_http.rs`; that is existing behavior and this spec does not change it, but `openrouter.ai` is already in the Rust `ALLOWED_HOSTS` if it is ever routed there.

Run trigger: after an import completes, and on an explicit "Classify pending" button on `/finances/review`. Never on a timer, never at startup — the user should not discover a surprise AI bill from opening the app.

## Budget model

Pure functions in `src/domain/finance/budget.ts`. The repository provides rows; all arithmetic lives here (the `AGENTS.md` centralization rule, matching `src/domain/weekly-review.ts` et al.).

Definitions, all in minor units, all restricted to `on_budget` accounts and excluding rows with `excluded_from_budget = 1`. **Filter on `excluded_from_budget` only, never on `is_transfer`**: a both-legs-on-budget transfer is already flagged excluded, while a one-legged or unconfirmed transfer is deliberately `is_transfer = 1, excluded_from_budget = 0` and must keep counting (see §Transfer detection).

```
activity(cat, month)   = Σ amount_minor of that category's transactions (splits expanded) in month
                         (negative for spending)
available(cat, month)  = carryIn(cat, month) + assigned(cat, month) + activity(cat, month)
carryIn(cat, month)    = 0                                  for the first budgeted month
                       = max(0, available(cat, prev))        when available(cat, prev) >= 0
                       = available(cat, prev)                when negative AND policy = carry_negative
                       = 0                                   when negative AND policy = reduce_next_ready_to_assign
                         -- policy = the overspend_policy of the (prev, cat) budget entry,
                         --          defaulting to reduce_next_ready_to_assign when absent

readyToAssign(M)       = onBudgetBalance(end of M)
                       − Σ available(cat, M) over categories with kind = 'expense'
                                             (including Uncategorized)
                       − Σ assigned(cat, m) for all m > M
                       − deferredIncome(M) + deferredIncome(M − 1)
```

`deferredIncome(M)` = Σ `activity` (positive) in month `M` of income categories with `defers_to_next_month = 1`; `deferredIncome(M − 1)` releases the previous month's deferral into this month. `deferredIncome` of a month before the first budgeted month is `0`.

Income (`kind = 'income'`) is never an envelope: its activity reaches Ready to Assign through `onBudgetBalance`. "Income for next month" is the only exception, moved by the `deferredIncome` terms. Assigning to an `income`-kind category is rejected by `setFinanceBudgetAssignment`, since such a row would be counted by neither side of the invariant.

There is **no separate overspend term**. Under `reduce_next_ready_to_assign` the clamp `carryIn = 0` is itself the absorption: the cash is gone from the balance with no matching positive `available`, so next month's Ready to Assign drops by exactly the overspend. Under `carry_negative` the deficit stays inside `Σ available` and Ready to Assign is unaffected. `budget.test.ts` must assert the invariant directly: `onBudgetBalance(end of M) == Σ available(cat, M) + readyToAssign(M) + Σ assigned in future months + (deferredIncome(M) − deferredIncome(M − 1))`, where `Σ available` runs over `kind = 'expense'` categories only. Worked example to include as a test: income 100, assign 50 to A, spend 80 on A → month 2 Ready to Assign is 20 under `reduce_next_ready_to_assign`.

`onBudgetBalance` = `opening_balance_minor` + Σ all transactions in that account up to the month end. Credit-card accounts contribute their (negative) balance, which is why v1 shows a plain "card balance" line instead of YNAB's payment envelope.

Behaviors:

- **Split aggregation rule** (used by budget, every report, and forecasting): for `has_splits = 1`, aggregate the rows of `finance_transaction_splits` and exclude the parent; otherwise aggregate the transaction. The parent's `category_id` is `fincat:split` and is never counted. A report test asserts a split transaction contributes its full amount exactly once.
- **Assign money**: `setFinanceBudgetAssignment(monthKey, categoryId, assignedMinor)`. Idempotent upsert; assigning `0` deletes the row so an unbudgeted category stays visually distinct from one budgeted at zero.
- **Computation shape.** `carryIn` recurses back to the first budgeted month, so `computeFinanceBudgetState(M)` needs activity for *every* month up to `M`, not just `M`. Both implementations load the same input shape — all on-budget, non-excluded transactions (splits expanded) from the first budgeted month through the end of `M`, plus all budget entries — and hand it to one pure function. At the stated volume that is fine; if it ever is not, the fix is a cached snapshot in the app layer, never a materialized rollover column.
- **Rollover** is implicit in `carryIn` and is recomputed, never materialized — so correcting a transaction six months back automatically fixes every later month rather than leaving a stale stored balance. This is the single most important structural decision in the budget model.
- **Quick actions** (YNAB parity, all just assignment writes): "assign last month's amount", "assign average of last 3 months", "cover overspending from another category", "assign all Ready to Assign".
- **Mint parity — track everything.** The budget page has a "Non budgété" band listing every category with activity and no assignment, with its total and a one-click assign. Off-budget accounts (investment, mortgage, manual assets) never touch envelopes but always count in net worth, trends, and reports.
- **Income** goes to Ready to Assign by default (categories with `kind = "income"`); a category can be marked "income for next month" (`finance_categories.defers_to_next_month = 1`) to defer it, which shifts it to the following month's Ready to Assign.
- **Closing a month** (`finance_budget_months.closed_at`) is advisory: it freezes the UI against accidental edits and can be reopened. It changes no arithmetic.

## Proactive runout forecasting

`src/domain/finance/forecast.ts`, pure, input `FinanceSnapshot` (built by the repository), output `FinanceForecast`:

**Per envelope**, for the current month with `elapsedDays` / `totalDays`:

```
spent            = -activity(cat, month)             // positive number
currentPace      = nonRecurringSpent / max(elapsedDays, 1)   // per day
historicalPace   = median over the 3 trailing full months m of
                   (nonRecurringSpend(cat, m) / daysInMonth(m))
blendedPace      = elapsedDays < 5 ? historicalPace
                 : elapsedDays < 12 ? 0.5*currentPace + 0.5*historicalPace
                 : currentPace
knownUpcoming    = Σ expected_amount_minor of active recurring series for this category
                   whose next_expected_date falls in the remaining month
projectedTotal   = spent + blendedPace*remainingDays + knownUpcoming
                   // spent = full actual; paces exclude recurring-series-matched
                   // transactions so lump-sum bills are never counted twice
runoutDate       = the first date d in the rest of the month where
                   spent + blendedPace*(d - today) + upcomingThrough(d) >= envelope
                   (null when it never crosses)
```

`envelope(cat) = assigned(cat, M) + carryIn(cat, M)` — the budget for the month, *not* the remaining `available`. `nonRecurringSpent` and `nonRecurringSpend` are spend on transactions not matched to an active `finance_recurring_series`. A median over a daily series is deliberately avoided: it is 0 for any category with a few transactions a month.

Status ladder, evaluated top-down: `exhausted` (`available ≤ 0` already) → `will_run_out` (a `runoutDate` exists, i.e. `projectedTotal ≥ envelope`) → `watch` (no `runoutDate`, but `projectedTotal ≥ 0.9 × envelope`) → `on_track`. Note that `projectedTotal` *is* the value of the runout expression at month end, so `projectedTotal ≥ envelope` and "a runoutDate exists in this month" are the same condition — `watch` is therefore defined strictly below the envelope, as approaching-but-not-crossing. **The ladder is only evaluated for budgeted categories (`envelope > 0`).** A category with `envelope ≤ 0` is never `exhausted` or `will_run_out`: unbudgeted spending is Mint-style tracking, not a budget breach, and it surfaces in the budget page's "Non budgété" band instead. Without this guard every unbudgeted category with any activity would have `available < 0` and fire an `exhausted` alert on day one. Recurring bills are added as **lump sums on their expected day**, never smoothed into the pace — smoothing a $1 400 rent over 30 days makes the forecast useless in exactly the case that matters.

**Household cash-flow runout**, the second and more important signal:

```
projectedBalance(d) = onBudgetBalance(today)
                    + Σ expected recurring income with next_expected_date in (today, d]
                    − Σ expected recurring bills  with next_expected_date in (today, d]
                    − discretionaryPace * (d - today)
```

`discretionaryPace` is the blended (same blend as above) non-recurring, non-transfer, on-budget outflow pace across all categories.

The first `d` where `projectedBalance(d) < financeSafetyBufferMinor` is the cash runout date. Project 60 days ahead so a mid-month warning can still cover next month's rent.

Guards, all tested: an unbudgeted category (`envelope ≤ 0`), including one with spending, produces `on_track` and no alert (silence beats noise; it belongs to the "Non budgété" band); a division by zero elapsed day is impossible by construction; a month with fewer than 3 prior months of data falls back to current pace with a `lowConfidence` flag that the UI renders as "estimation provisoire" — this fallback **overrides** the `elapsedDays < 5` branch, which would otherwise use an undefined `historicalPace`; and with both no history and `elapsedDays < 5` the category is `on_track` with `lowConfidence` and raises no alert at all; a single large legitimate one-off (car repair) must not fire a runout alert on every other category, so `blendedPace` uses a **median**, not a mean.

**Surfacing:**

- `src/components/FinanceAlertsCard.tsx` on `/` (Today), rendered only when `financeEnabled && financeAlertsOnToday`, showing at most the 3 highest-severity alerts plus a link to `/finances`. Today's page already has the `SectionCard` idiom (`TodayPage.tsx:406,440,483`); this is one more.
- Full list on `/finances`, grouped by severity.
- Optional coach context: when `financeCoachContextEnabled` is on, a compact `FinanceSnapshot` (statuses and category names only — no amounts) joins the daily pulse payload. Default off, and off is the safe default because the coach payload has the widest AI exposure in the app.
- A **desktop notification** at most once per day per alert key, reusing `tauri-plugin-notification` and the existing rate-limiting idiom in `src/lib/ai/pulse/notification-policy.ts`. Never notify for `watch`; only `will_run_out` and `exhausted`, and only for cash runout inside 14 days.

## Recurring bills

`src/lib/finance/recurring-detection.ts`, pure, over the full transaction history:

- Group by `merchant_key` + sign; require ≥ 3 occurrences.
- Compute the day gaps; classify cadence when the median gap is within tolerance (weekly 7±2, biweekly 14±3, semimonthly 15±3, monthly 28–33, quarterly 88–95, annual 360–370) and the gap standard deviation is under half the tolerance.
- `expected_amount_minor` = median amount; `amount_tolerance_minor` = max(5 % of median, 100).
- `next_expected_date` = last seen + median gap, clamped to a valid calendar date (the 31st in a 30-day month lands on the last day).
- Flags: `missed` when `next_expected_date` is more than tolerance days past with no match; `amount_changed` when the newest occurrence is outside tolerance; `ended` after two consecutive misses.
- Detection is advisory and re-derivable; user confirmation (`confirmed_by_user`) pins a series so re-detection cannot silently drop it.

Detection runs after each import (inside the import transaction) and on demand from `/finances`.

## Screens and routes

Routes nest under the existing `AppShell` route in `src/App.tsx`. `AppShell.tsx` gains **one** nav item, `{ to: "/finances", labelKey: "finances" }`, rendered only when `settings.financeEnabled` — the sidebar already carries 19 items and seven more would wreck it. In-page tabs handle the rest.

| Route | Page | Content |
|---|---|---|
| `/finances` | `FinanceOverviewPage` | Net worth (assets/liabilities split), this month's cash flow, runout alerts, account list with balances, 6-month spending trend, top categories, upcoming recurring bills |
| `/finances/transactions` | `FinanceTransactionsPage` | Virtualized/paged list with filters (date range, account, category, person, search, uncategorized only), inline category edit, split editor, mark/unmark transfer, exclude, bulk selection toolbar |
| `/finances/budget` | `FinanceBudgetPage` | Month selector, Ready to Assign header, envelope grid (Assigned / Activity / Available) grouped by category group, quick-assign actions, "Non budgété" band, pace indicator per envelope |
| `/finances/reports` | `FinanceReportsPage` | Spending by category (with drill-down to transactions), by merchant, by person, income vs expense over time, month-over-month comparison |
| `/finances/import` | `FinanceImportPage` | File picker, profile auto-detect, mapping UI with preview, account binding, import result, batch history with undo |
| `/finances/accounts` | `FinanceAccountsPage` | Account and household-member CRUD, on-budget toggle, manual balance for asset accounts, close/reopen |
| `/finances/review` | `FinanceReviewPage` | The suggestion queue: pending suggestions grouped by merchant, accept / correct / dismiss, bulk accept-all-above-threshold, "Classify pending" AI trigger with an explicit cost hint |

All UI strings in French, via a new `src/locales/fr/finance.json` namespace registered in `src/i18n/index.ts`; `nav.json` gains `"finances": "Finances"`. Keep the pages thin: every number they render comes from a pure function in `src/domain/finance/` or an engine in `src/lib/finance/`.

## Settings

New `AppSettings` fields (in `src/domain/types.ts`, defaulted in `defaultAppSettings()` in `src/domain/daily-entry.ts`). No migration is needed — settings are a single JSON blob read through `mergeAppSettingsWithDefaults` (`src/lib/relationship-draws.ts:42`, applied at `tauri-sqlite-repository.ts:1837`), so absent keys pick up defaults automatically. Add a `backup.test.ts`-style merge test for the new keys anyway.

```
financeEnabled: false
financeBaseCurrency: "CAD"
financeAiCategorizationEnabled: false
financeAiAutoApplyEnabled: false
financeAiAutoApplyMinConfidence: 0.9
financeAlertsOnToday: true
financeCoachContextEnabled: false
financeNotifyRunout: true
financeSafetyBufferMinor: 0
financeCategoriesSeededAt: ""
```

A "Finances" section in `SettingsPage` groups these, with the AI sub-settings disabled (not hidden) while `aiEnabled` is false, so the dependency is legible.

## Bootstrap

`AppProvider` changes, preserving every property in the `AGENTS.md` bootstrap contract:

- After SQLite init and settings read, **if and only if `financeEnabled`**: seed default categories once (gated on `financeCategoriesSeededAt`, idempotent by fixed ids). The same seeding also runs on the `financeEnabled` false→true transition in Settings, so the first visit to `/finances` never shows an empty taxonomy.
- On the existing local-day-boundary reconciliation (`use-local-day-reconciliation.ts`), call `snapshotFinanceAccountBalances(today)` so the net-worth series has one point per day the app was open, and recompute the forecast for the Today card.
- **No network call, no AI call, and no import runs at startup.** Finance adds no new failure mode to the eight-second timeout path; if the finance store fails, the finance nav entry shows an error state and the rest of the app is unaffected.
- The in-memory fallback repository provides the finance store too, so browser preview renders the screens with empty (non-persistent) data.

## Privacy and data safety

- Finance data lives only in the local SQLite file and therefore in `VACUUM INTO` backups, like everything else. Say so explicitly in `docs/storage-and-backups.md`.
- No finance data is sent anywhere except the bounded, anonymized merchant descriptors of the AI stage, and only with three flags enabled.
- No account numbers are ever stored. If an imported column looks like an account number (`\b\d{6,}\b` in the account field), keep only the last 4 digits in `external_key`.
- Debug logging (`src/lib/debug.ts`) must never log amounts, balances, merchant strings, or the API key. Log counts and durations only.
- **Before the first real import, take a manual backup from Settings.** There is no restore-from-backup UI; this is the only recovery path, and an import is the largest single write the app has ever done.

## Tests

Pure engines (highest value, no mocking required):

- `src/lib/finance/money.test.ts` — parse `1,234.56`, `1 234,56`, `(45.00)`, `$-12.00`, `12.00 CR`, unicode minus; exponent handling; `sumMoney` throws on mixed currency; no float drift over 10 000 additions.
- `src/lib/finance/csv.test.ts` — quoted commas, embedded newlines, doubled quotes, CRLF, BOM, `;` and tab delimiters, ragged rows reported not thrown, empty file, header-only file.
- `src/lib/finance/import-profile.test.ts` — Mint header signature match; ambiguous `D/M` vs `M/D` inference is reported as ambiguous rather than guessed.
- `src/lib/finance/hash.test.ts` — determinism, distribution sanity, and no collision across a 50 000-row synthetic corpus.
- `src/lib/finance/transfers.test.ts` — clean pair; three-day window boundary (3 pairs, 4 does not); two candidate matches resolve deterministically; already-paired rows are not re-paired; keyword-only single side yields a suggestion, not a silent exclusion.
- `src/lib/finance/classify.test.ts` — one case per pipeline stage; a user-set category survives every automatic stage; memory below threshold suggests rather than applies; a seed never auto-applies; a dismissed AI pair is suppressed for 90 days.
- `src/domain/finance/budget.test.ts` — available/carryIn/readyToAssign arithmetic; the balance invariant asserted directly on the worked example under **both** overspend policies; positive rollover; retroactive edit six months back propagates forward; assigning `0` removes the row; income deferred to next month (asserting the invariant across the M/M+1 boundary); an on-budget credit-card purchase plus its payment transfer leave Ready to Assign unchanged; a one-legged transfer to an off-budget account counts as spending rather than silently reducing Ready to Assign.
- `src/domain/finance/forecast.test.ts` — mid-month pace; `elapsedDays < 5` uses history; a rent lump sum lands on its day; median resists a one-off outlier; an unbudgeted category with heavy spending produces no alert; cash runout crosses the buffer on the right date; month-boundary and 28/31-day months; status-ladder boundaries (`projectedTotal` at 89 %/91 % of envelope → `on_track`/`watch`, at 100 % → `will_run_out`); an already-paid recurring bill is counted once (in `spent`, not again via the pace or `knownUpcoming`).
- `src/lib/finance/recurring-detection.test.ts` — monthly/biweekly/annual cadence classification; the 31st clamps in February; missed and amount-changed flags; a confirmed series is not dropped by re-detection.

Storage and parity:

- `src/lib/storage/memory-repository.test.ts` — extend for **every** new method (the parity contract). This file is the enforcement point.
- `src/lib/storage/finance-persistence.test.ts` — mirror `email-triage-persistence.test.ts`: round-trip mapping for each table, split-sum invariant, suggestion unique-pending index, dedupe uniqueness.
- `src/lib/storage/migrations/finance-foundation.test.ts` — mirror `migrations/email-triage-foundation.test.ts`: assert migration 34 exists, is id 34, creates each table and index, and touches no pre-existing table.
- **Idempotent re-import test**: import a fixture, import the identical file again, assert `imported === 0` and `duplicates === rowCount`, and assert the transaction count is unchanged. Then import an overlapping file (last month repeated + this month new) and assert only the genuinely new rows land.

AI:

- `src/lib/ai/finance-categorization-service.test.ts` — cache hit by input hash; `skipped` status when AI is unconfigured; repair round-trip on invalid JSON; `fallback` on provider error; a category id outside the allowed list is rejected.
- `src/lib/ai/context/finance-categorization-snapshot.test.ts` — **serialize the payload and assert by substring that the payload contains no balance, no account name, no person name, no exact amount and no date; and apply the digit-run (≥ 4), email and card-fragment rules to the merchant descriptor fields only** (amount buckets such as `200-1000` and occurrence counts legitimately contain digits). This is the test that makes the privacy claim enforceable rather than aspirational.
- Extend the existing `openrouter-provider.test.ts` for the new surface branch.

Screens (Testing Library via `src/test/test-utils.tsx`, which already builds on `MemoryRepository`):

- `FinanceImportPage.test.tsx` — paste CSV text into the file input, map columns, preview, import, result panel.
- `FinanceBudgetPage.test.tsx` — assign money, see Available and Ready to Assign update, cover overspending.
- `FinanceReviewPage.test.tsx` — accept a suggestion and assert the merchant memory was reinforced; correct one and assert the memory flipped with reset confidence.
- `TodayPage.test.tsx` — the finance alert card is absent when `financeEnabled` is false and present with the right alert when it is true.

Timezone note: `vite.config.ts` pins `TZ` for tests, so forecast and month-boundary tests must inject a date rather than mutating the global TZ.

## Documentation (required by `AGENTS.md`)

- New canonical page `docs/finance.md` + its domain log `docs/logs/finance.md` (path rule `docs/<page>.md` → `docs/logs/<page>.md`).
- Register the page in **three** places: `docs/index.md` (Product domains table + Source map rows), the quick-reference table in `AGENTS.md`, and the identical table in `CLAUDE.md` — CI runs `cmp AGENTS.md CLAUDE.md`.
- Add the new domain log to `docs/log.md` (the one case where editing it is correct).
- Update `docs/architecture.md` (routes, boot flow, the finance store boundary), `docs/storage-and-backups.md` (migration 34, the finance tables, finance data is in backups), `docs/ai-settings-and-privacy.md` (the `finance_categorization` surface, exactly what is and is not sent, the three gating flags), and `docs/conventions.md` (minor-units rule). Prepend an entry to each touched page's domain log.
- Move this spec to `specs/done/` only once implementation, tests, and docs have all shipped, and add it to the `specs/README.md` index in the meantime.

## Phased delivery

Each phase is independently shippable and leaves the app green. The pure engines come before any migration, because that is where the design risk lives.

**Phase 1 — Money, CSV, and the import pipeline (no UI).**
`money.ts`, `hash.ts`, `csv.ts`, `import-profile.ts`, `transfers.ts`, `src/domain/finance.ts`, plus the full test suite.
*Acceptance:* `npm run verify` green; a Mint-format fixture and two generic fixtures parse to expected minor-unit rows; re-parsing the same fixture yields identical dedupe hashes; a synthetic transfer pair is detected; no SQLite or UI code exists yet.

**Phase 2 — Schema and repository parity.**
Migration 34, `FinanceSqliteStore`, `FinanceMemoryStore`, the `AppRepository` additions, seeds, and `importFinanceTransactions` as a single transaction.
*Acceptance:* migration test passes; `memory-repository.test.ts` covers every new method; a 5 000-row import completes in one `runExclusive` block with no `DbSerialQueue` reentrancy error; re-importing yields zero new rows; `undoFinanceImportBatch` removes exactly the batch's non-user-categorized rows.

**Phase 3 — Accounts, import, and transaction screens.**
`/finances/accounts`, `/finances/import`, `/finances/transactions`, the nav entry, `financeEnabled`, the finance settings section, `finance.json`.
*Acceptance:* the user can create a household member and accounts, import a real Mint export end to end in `npm run tauri dev`, see transactions listed and filterable, edit a category inline, split a transaction, and mark a transfer; with `financeEnabled` false nothing appears anywhere.

**Phase 4 — Classification: rules, memory, seeds, review queue.**
`classify.ts`, `seed-heuristics.ts`, `finance_rules` UI, `/finances/review`, `setFinanceTransactionCategory` with all three scopes. **No AI yet.**
*Acceptance:* a fresh import of a month of real data auto-categorizes a majority of rows via rules + memory + previously learned corrections; correcting one merchant and choosing `all_matching` recategorizes the history and never touches a user-set row; the queue shows seed suggestions and accepting one reinforces memory.

**Phase 5 — Budget.**
`src/domain/finance/budget.ts`, `/finances/budget`, assignment writes, rollover, overspend policies, the "Non budgété" band.
*Acceptance:* assigning money updates Available and Ready to Assign; a positive balance rolls to the next month; an overspend behaves per policy; editing a transaction six months back correctly changes every later month's carry-in; zero-based reconciliation reaches exactly zero Ready to Assign when everything is assigned.

**Phase 6 — Tracking, reports, recurring, net worth.**
`computeFinanceNetWorth`, cash flow, category/merchant/person reports, trends, `recurring-detection.ts`, daily balance snapshots, `/finances` and `/finances/reports`.
*Acceptance:* net worth matches hand-computed assets minus liabilities for a fixture; a known monthly subscription is detected with the correct cadence and next date; a category report drills down to the exact transactions that sum to it.

**Phase 7 — Forecasting and proactive alerts.**
`src/domain/finance/forecast.ts`, `FinanceAlertsCard` on Today, notification policy, optional coach context.
*Acceptance:* an envelope on track to overspend shows a runout date that matches hand arithmetic; a one-off outlier does not fire an alert across unrelated categories; the cash-runout date accounts for upcoming recurring bills; a notification fires at most once per day per alert key; Today shows nothing when `financeAlertsOnToday` is off.

**Phase 8 — AI categorization.**
The `finance_categorization` surface, service, loader, validator, schema prompt, snapshot with the privacy caps, and the auto-apply threshold.
*Acceptance:* with AI off everything in Phases 4–7 still works; with AI on, unknown merchants get suggestions carrying rationale; the payload-assertion test passes; an out-of-list category id is rejected; suggestions never overwrite a user-set category; cost appears in the existing AI cost dashboard.

## Risks, ranked

1. **A dedupe collision or a wrong dedupe key silently loses or duplicates transactions.** The user would not notice for months, and the budget would be quietly wrong. Mitigated by the 128-bit hash, the `occurrenceIndex` term, the UNIQUE constraint, and the explicit idempotent-re-import test.
2. **Float arithmetic creeping in** through a chart library, a percentage, or an average. Mitigated by minor units everywhere, no helper accepting decimals, and the no-drift test.
3. **Automatic categorization overwriting user intent** destroys trust in the learning loop permanently. Mitigated by the absolute `category_source === "user"` invariant, tested directly.
4. **Over-sharing with the AI provider** — this is the most sensitive data in the app. Mitigated by merchant-level payloads, amount bucketing, the sanitizer, three gating flags defaulting off, and a payload-content assertion test.
5. **Import as the largest write the app has ever performed**, against the user's only database with no restore UI. Mitigated by a single transaction with rollback, the batch-undo path, and a documented "back up first" step.
6. **Forecast noise.** A budget alarm that cries wolf gets ignored, at which point the feature's core value is gone. Mitigated by median-based pacing, lump-sum treatment of recurring bills, a `watch` tier that never notifies, and per-day notification rate limiting.
7. **Migration id collision with `specs/todo/mobile-and-sync.md`**, which still claims id 33. Resolve in the spec before either is implemented.
8. **Scope.** This is the largest feature in the app. The phase boundaries are chosen so that stopping after Phase 4 still leaves a genuinely useful Mint-style tracker, and stopping after Phase 5 leaves a working YNAB.
