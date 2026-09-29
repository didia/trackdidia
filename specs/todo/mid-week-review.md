# Spec — Mid-week steering page

**Status:** approved, unshipped. Planner/validator loop: approved on iteration 1, revised
for owner decisions, re-approved on iteration 2. The Wednesday snapshot (§B2.3–B2.4) was
added after that at the owner's request, and was revised once after validator review. A
second revision addressed the owner's PR review (#171): decisions load and save
acknowledgement, snapshot preservation, atomic objective-cache merges, per-signal coverage,
floating-point boundaries, Sunday AI behavior and steering-action validation.
**Scope:** a dedicated `/mi-semaine` page that reads the week in progress (RescueTime goals,
daily habits, tracked metrics, tasks, weekly objectives, journal), shows what is lagging
against a pro-rated pace, suggests how to recover, and saves what the owner decides to
change. The weekly review then shows those decisions next to the week's final numbers.

## Context

Today the Wednesday prompt on `/aujourdhui` (`TodayPage.tsx`, `isWednesday`) only links to
`/semaine?date=…`. The weekly review answers "how did the week go?". The mid-week check has
to answer a different question: "am I on pace, and what should I change for the rest of the
week?".

Every existing aggregate is whole-week. `buildWeeklyReviewSummary` divides TRC by a hard `7`
and scores pomodoros against `pomodoroTarget = 56`. `RescueTimeGoalsService` scores
week-to-date `actualHours` against a full-week `weeklyTargetHours`. On a Wednesday, every
"more is better" axis therefore reads as failing. The core of this spec is pro-rating the
**expected** value.

## Owner decisions

| Decision | Choice |
|---|---|
| Own page | Yes, `/mi-semaine`, with a nav entry. The Wednesday prompt links there. `/semaine` keeps its role. |
| Week scope | Always the current week (`getWeekStartSunday(calendarDay)`). No week picker and no `?date=`. |
| Rollout | Deterministic page first. AI steering (PR D) follows. |
| Persist decisions | Yes, in a new table (migration 36). Never `tempsEtPlan` and never a new `WeeklyRitualSectionKey`. |
| Wednesday snapshot | Yes. Saving decisions also stores the lagging list at that moment, so Sunday can compare before and after. |
| RescueTime cache | Yes. Same cache and key as the weekly review: `(week_start_date, kind, credential_fingerprint)` from [`weekly-review-caching.md`](weekly-review-caching.md) §1. |
| Thresholds | Start at `0.1` (tolerance) and `0.25` (lagging). The owner tunes them later. |
| Journal feed (PR C) | **Optional, not approved.** Ship only if the owner confirms. |

## PR sequence

| PR | Content | Migration |
|---|---|---|
| **A** | RescueTime snapshot cache (`weekly-review-caching.md` §1 only) plus the opt-in freshness window | 35 |
| **B1** | Pure mid-week domain math and its tests. No UI, no repository. | — |
| **B2** | Decisions table and repository parity, the page, the `/semaine` card, wiring, i18n, docs | 36 |
| **C** | *(optional)* Mid-week decisions as a `midWeek` journal kind | — |
| **D** | `mid_week_steering` AI surface | — |

Migration 34 shipped in #172 (`add_weekly_objective_ends_on_week_start_date`), so the
RescueTime cache that `weekly-review-caching.md` originally numbered 34 takes **35**, and
mid-week decisions take **36**. `planned-order.test.ts` already enforces unique, strictly
increasing migration ids, so a misordered merge fails CI. Never renumber a shipped
migration: a later PR takes the next free id.

### Built on merged refactors

These refactors have all merged into `master`. Implementations use them rather than the
older patterns:

- **#170, repository contract suite:** tests for every new repository method go in
  `src/lib/storage/repository.contract.ts` (`describeRepositoryContract`), which runs
  against both `MemoryRepository` and `TauriSqliteRepository`.
- **#162, `domain/types` split:** new types go in the per-domain modules:
  - `src/domain/types/reviews.ts`: `MidWeekDecisions`, `cachedAt` on
    `WeeklyObjectivesSnapshot`, and `RescueTimeSnapshotCacheKind` /
    `RescueTimeSnapshotCacheEntry` (next to `RescueTimeTaxonomy`)
  - `src/domain/types/ai.ts`: the `AiSurface` member and the steering types
  - The pure mid-week types (`MidWeekSignal`, `MidWeekLaggingSnapshot`, …) stay in
    `src/domain/mid-week-review.ts`, as `RescueTimeGoalsSnapshot` stays in
    `src/domain/rescuetime-goals.ts`.
- **#154, `useLatestRequest` / `useAsyncResource`** (`src/app/use-latest-request.ts`): the
  page uses these instead of hand-rolled request-sequence refs.
- **#159, `PageHeader`** (`src/components/PageHeader.tsx`): the page's hero uses it.
- **#169, `loadLatestSurfaceResult`** (`src/lib/ai/latest-surface-result-loader.ts`): PR D's
  loader uses it.
- **#168, table-driven `OpenRouterProvider` builders:** PR D adds a table entry.
- **#166, redaction helpers** (`src/lib/ai/context/redaction.ts`): PR D's snapshot uses them.

### Spec lifecycle

`specs/README.md` lists this spec under `todo/` from the commit that adds it. The spec stays
in `todo/` until PR D ships. PR C is optional and does not block the move to `done/`.

---

## PR A — RescueTime snapshot cache and freshness window

Implement [`weekly-review-caching.md`](weekly-review-caching.md) §1 as written, with the
clarifications below. §2 (compact goal lines) and §3 (weekly coach last-good cache) remain
unshipped.

- **Migration 35 `create_rescuetime_snapshot_cache`**, with the schema from §1 (§1 said 34;
  #172 has since taken that id). The repository methods `getRescueTimeSnapshotCache`,
  `saveRescueTimeSnapshotCache` and `pruneRescueTimeSnapshotCache(keepFingerprint: string |
  null)` go in both implementations. Normalize `weekStartDate` with `buildWeekDates` on read
  and write.
- **Fingerprint:** `src/lib/rescuetime/credential-fingerprint.ts`,
  `rescueTimeCredentialFingerprint(apiKey)`. It trims the key, then takes a SHA-256 via
  `crypto.subtle.digest` (same pattern as `src/lib/email-triage/oauth/pkce.ts`), hex encoded
  and truncated to 16 characters. Compute it from the key captured at the start of the pull
  and use that value for the write. Reads use the current key's fingerprint.
- **Snapshot types:** add `cachedAt?: string` to `RescueTimeGoalsSnapshot`
  (`src/domain/rescuetime-goals.ts`), `RescueTimeProductivityPulseSnapshot` (declared in
  `src/lib/rescuetime/rescuetime-goals-service.ts`) and `WeeklyObjectivesSnapshot`
  (`src/domain/types/reviews.ts`).
- **Each method has its own write and catch branch:**
  - `computeGoalsSnapshot` writes `goals` on success, even for an empty list. On failure it
    reads `goals`, rebuilds the items and recomputes `achievement` with
    `scoreMoreGoal` / `scoreLessGoal`.
  - `computeProductivityPulse` writes `pulse` on success. On failure it reads `pulse`; a
    cached `null` is distinct from "no row".
  - When a cached entry is used, set `cachedAt = fetchedAt` and drop `fetchError`. If there
    is no parseable entry, keep today's behavior. Each write sits in its own `try/catch`.
  - `WeeklyObjectivesService` follows the §1 merge rules and per-value `fetchedAt`
    provenance, through the atomic merge below.
- **Atomic objective-cache merge.** Two overlapping objective computations must not erase
  each other's fresh ids. The service therefore never does its own read, merge and write.
  - Add `mergeRescueTimeObjectiveSecondsCache({ weekStartDate, credentialFingerprint,
    values: Record<objectiveId, { seconds; fetchedAt }>, fetchedAt })` to `AppRepository`.
  - It reads the current `objective_seconds` row and merges with the pure
    `mergeObjectiveSecondsPayload(existing, values)` (in `src/domain/rescuetime-goals.ts`).
    Incoming ids overwrite; every other id keeps its own `fetchedAt`; an unparseable
    existing payload counts as empty. Then it writes the result.
  - In `TauriSqliteRepository`, the read, the merge and the upsert run inside **one**
    `runExclusive` call. Every write goes through that `DbSerialQueue`, so no other write
    can land between the read and the upsert.
  - In `MemoryRepository`, the read, the merge and the write run synchronously with no
    `await` in between.
  - This mirrors `addPastorCustomVerse` in `tauri-sqlite-repository.ts`, which already
    reads, merges and writes inside one `runExclusive`. Reads are not queued in this
    repository, so the merge reads through a plain `db.select`.
  - It must never call a method that itself calls `runExclusive`: `DbSerialQueue`'s
    watchdog rejects reentrant calls after 15 s. Extract an `…Internal` helper that takes
    the open connection, as `saveWeeklyReviewInternal` does.
  - `saveRescueTimeSnapshotCache` is used only for the `goals` and `pulse` kinds.
- **Freshness window (extends §1):** an optional `options?: { maxAgeMs?: number }` on
  `computeGoalsSnapshot`, `computeProductivityPulse` and `computeWeeklyObjectivesSnapshot`.
  When all of the following hold, return the cached snapshot with `cachedAt` and make no
  network call:
  - `maxAgeMs > 0`
  - `rescuetimeConfigured` is true (checked **before** any cache read)
  - an entry for the current fingerprint is younger than `maxAgeMs`

  For objectives, skip the pull only when every active time objective has a fresh entry.
  With the option absent, behavior is unchanged, so `WeeklyReviewPage` stays
  live-every-time. Add a one-line note recording this extension to §1's read rules.
- **Pruning:** in `saveSettings` (`src/app/app-context.tsx`), when the trimmed RescueTime
  key changes, call `pruneRescueTimeSnapshotCache`. Run it in its own swallowed `try/catch`
  and never log the key. This is housekeeping only; correctness does not depend on it.
- **`WeeklyReviewPage`, minimal changes for §1:**
  - The goals list renders whenever `items.length > 0`, even when `fetchError` is set.
  - The standing objectives render the banner **and** the list.
  - When `cachedAt` is set, show `weekly.rescueGoals.cachedNotice` and the source label
    `weekly.rescueGoals.source.cache`.
  - Cached values keep feeding the score axes and the AI snapshot inputs.
  - The `div.weekly-day-grid` block and the `"0.25/1"` assertion are untouched; they belong
    to §2.
- **Spec lifecycle:** `weekly-review-caching.md` stays in `todo/`. Its status line becomes
  "§1 shipped; §2 and §3 not implemented", and `specs/README.md` is updated to match.
- **Docs:**
  - `docs/reviews-and-goals.md`: replace "not persisted" with the cache contract.
  - `docs/storage-and-backups.md`: migration 35 row and a table-reference block.
  - `docs/ai-settings-and-privacy.md`: goal titles are stored at rest, scoped by the key
    fingerprint; the key itself is never stored.
  - Prepend entries to the three matching `docs/logs/` pages.

### PR A tests

- `migrations/rescuetime-snapshot-cache.test.ts`, using the same `find(id === 35)` shape as
  `weekly-objective-starts-on.test.ts`.
- `credential-fingerprint.test.ts`: stable, hex, 16 characters, differs per key, trims.
- Repository, in the shared contract suite: round trip, upsert, miss returns `null`,
  isolation per fingerprint, prune keeps only the given fingerprint, and prune with `null`
  clears everything.
- Merge, also in the contract suite:
  - Two merges started together (`Promise.all`) with disjoint ids both survive.
  - For the same id, the call queued later wins.
  - Retained ids keep their original `fetchedAt`.
  - A corrupt existing payload is replaced rather than throwing.
- `rescuetime-goals-service.test.ts`:
  - Cache is written on success, including for an empty goal list.
  - A failed pull with a cached entry returns `cachedAt` and no `fetchError`.
  - With no cache, the current `fetchError` behavior is unchanged.
  - An unconfigured key never reads the cache.
  - After switching from key A to key B, a failed pull never returns A's entries, and a late
    pull for key A never becomes visible to B.
  - Pulse values `null` and `0` both round-trip.
  - Freshness: a fresh entry makes no client call; a stale entry pulls; an unconfigured key
    reads nothing; another fingerprint's entry is never served.
- `weekly-objectives-service.test.ts`:
  - When one kind group fails, the others are unaffected, and a merge never erases existing
    entries.
  - Values fetched Monday stay dated Monday.
  - `cachedAt` is the oldest reused `fetchedAt`.
  - `fetchError` remains when an objective has no cached value.
  - When only some objectives have a fresh entry, the live pull still runs.
- `WeeklyReviewPage.test.tsx`: the cached notice renders, and the standing list renders next
  to a partial `fetchError`.
- App context: a key change calls prune, and a prune that rejects does not fail the save.

---

## PR B1 — Mid-week domain math (pure)

### `src/domain/mid-week-review.ts`

This module has no repository access. Put the tuning knobs at the top of the file:

```ts
/** Tuning knobs for mid-week verdicts. Raise to be more forgiving. Documented in docs/reviews-and-goals.md. */
export const MID_WEEK_PACE_TOLERANCE = 0.1;
export const MID_WEEK_LAGGING_THRESHOLD = 0.25;
```

**Pace window:** `buildMidWeekPaceWindow(weekStartDate, asOfDate)` returns
`{ weekStartDate, weekEndDate, asOfDate, dayIndex, completedDays, remainingDays }`.

- `completedDays = clamp(diffDays(asOfDate, weekStartDate), 0, 7)` and
  `remainingDays = 7 - completedDays`. The counts use the **unclamped** `asOfDate`, so
  `weekEndDate + 1` or any later date gives `7` / `0`, and any date before `weekStartDate`
  gives `0` / `7`.
- The returned `asOfDate` is clamped into `[weekStartDate, addDays(weekEndDate, 1)]`.
- `dayIndex` is the local day of the week (`0..6`) of `asOfDate` only when
  `asOfDate <= weekEndDate`. Once the week is over it is `null`, because there is no "today"
  inside the week. Callers that use `dayIndex` must handle `null`.
- Excluding today from `expected` is deliberate. Otherwise every "more" signal reads
  `lagging` at 9 a.m., and today's RescueTime data is partial.
- On Sunday `completedDays === 0`, so the page shows no verdicts that day.

**Signal:** `MidWeekSignal` has these fields:

```
key, category, label, direction ("more" | "less" | "quality"), status,
actual, expected, weekTarget, unit, paceRatio, remaining, perRemainingDay,
daysApplicable, daysWithData, hasFullCoverage, severity, recovery
```

- Keys are stable and namespaced: `metric:pomodoris`, `principle:respectTrc`,
  `habit:discipline` (category `habit`), `rescuetime:<goalId>`, `objective:<id>`,
  `tasks:completion`, `journal:reflections`. PR D's validator matches on these keys.
- Status comes from `shortfall = 1 - paceRatio`:
  - `≤ -tolerance` → `ahead`
  - `≤ tolerance` → `on_pace`
  - `< lagging threshold` → `at_risk`
  - otherwise `lagging`
  - `paceRatio === null` → `unknown`
- The boundaries are inclusive: exactly 10 % over budget is `on_pace`, and exactly 25 %
  short is `lagging`.
- **Floating-point policy.** `shortfall` is rounded to 9 decimal places before any
  comparison: `Math.round((1 - paceRatio) * 1e9) / 1e9`, with the factor exported as
  `MID_WEEK_SHORTFALL_PRECISION`. Without it, `expected = 100, actual = 110` gives
  `paceRatio = 0.8999999999999999` and `shortfall = 0.10000000000000009`, which would turn
  an exact 10 % into `at_risk`. The rounded value also feeds `severity`.
- `paceRatio` depends on direction:
  - "more" and "quality": `expected > 0 ? actual / expected : null`.
  - "less": `expected > 0 ? 2 - actual / expected : null`. This gives no `Infinity`, and
    `ahead` stays reachable.
- Every numeric output is checked with `Number.isFinite`; a non-finite value becomes `null`.
- **An unlogged day is not a failure.** A signal measures only days that have data (see the
  `computeAnsweredDisciplineScore` rationale). This rule has no exceptions; the journal
  signal follows it too.
- **Coverage** is defined per signal in the coverage table below:
  - `daysApplicable` is how many days the signal could have been measured on.
  - `daysWithData` is how many of those actually have data.
  - `hasFullCoverage = daysApplicable > 0 && daysWithData >= daysApplicable`.
  - When coverage is not full, the recovery copy says so.
- **Severity** = `shortfall * (daysApplicable > 0 ? min(daysWithData / daysApplicable, 1) : 0)`,
  so thin coverage ranks lower. `rankMidWeekSignals` sorts by severity descending and breaks ties on
  `key`.
- `paceScore` is the mean of `clamp(paceRatio, 0, 1)` over signals that are not `unknown`.
  It is `null` when every signal is `unknown`.
- Recovery strings are built deterministically with `t(…, { ns: "reviews" })`, for example
  "48 left over 4 days ≈ 12/day".

| Signal | Actual (completed days) | Expected | Notes |
|---|---|---|---|
| `metric:pomodoris` | sum of `resolveMetricValue` over days that have a value | `(pomodoroTarget / 7) * daysWithData` | "more". `weekTarget = pomodoroTarget`, `remaining = max(0, weekTarget - actual)`. |
| `metric:depenseCalorique` | sum over days with a value | `calorieTargetDaily * daysWithData` | "more" |
| `metric:tempsEcranTelephone` | sum over days with a value | `(phoneScreenTargetMinutes / 7) * daysWithData` | "less" |
| `metric:qualiteSommeil` | average over days with a value | `100` | "quality", not pro-rated |
| `principle:*` (14) | answered `true` days | answered days (`!== null`) | `null` is not a miss. `unknown` when no day is answered. |
| `habit:discipline` | average of `computeAnsweredDisciplineScore` | `1` | |
| `tasks:completion` | `tachesRealises` summed | `tachesAjoutes` summed | `paceRatio = added > 0 ? completed/added : (completed > 0 ? 1 : null)`. `remaining = max(0, added - completed)`. |
| `journal:reflections` | completed days with a non-empty `nightReflection` | `daysWithData` from the coverage table | A day with no entry, or one that was never closed, is unlogged and not a miss. |
| `rescuetime:<id>`, `isMore` | `actualHours` (includes today) | `target * completedScheduleDaysInWeek / scheduleDaysInWeek` | Today is excluded; its hours can only help. |
| `rescuetime:<id>`, `!isMore` | `actualHours` | `target * (completedScheduleDays + (dayIndex !== null && isScheduleDay(label, dayIndex) ? 1 : 0)) / scheduleDaysInWeek` | Today is **included** because its minutes are already spent. The extra term applies only when `asOfDate <= weekEndDate`. Once the week is complete the budget is exactly `weeklyTargetHours`, so `expected <= weekTarget` always holds. Document this in a code comment and in the docs. |
| `objective:<id>`, kind `time` | `item.actualHours` | `targetHours * completedDays / 7` | A `null` value or `item.error` gives `unknown`. For kind `manual`: `ahead` if achieved, otherwise `unknown`. |

`weekTarget` is the full-week reference that the `/semaine` card renders against:

| Signal | `weekTarget` |
|---|---|
| `metric:pomodoris` | `pomodoroTarget` |
| `metric:depenseCalorique` | `calorieTargetDaily * 7` |
| `metric:tempsEcranTelephone` | `phoneScreenTargetMinutes` |
| `metric:qualiteSommeil` | `100` |
| `principle:*`, `journal:reflections` | `7` |
| `habit:discipline` | `1` |
| `tasks:completion` | `added` summed over the week |
| `rescuetime:<id>` | `weeklyTargetHours` |
| `objective:<id>` | `targetHours` for kind `time`; `1` for kind `manual` |

It is `null` only when the underlying target is `null`.

Coverage per signal. "Completed days" means the days strictly before `asOfDate` in the week.

| Signal | `daysApplicable` | `daysWithData` |
|---|---|---|
| `metric:*` (pomodoros, calories, screen time, sleep quality) | completed days | completed days where `resolveMetricValue` is non-null |
| `principle:*` | completed days | completed days where the principle is answered (`!== null`) |
| `habit:discipline` | completed days | completed days with at least one answered principle |
| `tasks:completion` | completed days | completed days where `tachesAjoutes` or `tachesRealises` resolves non-null |
| `journal:reflections` | completed days | completed days whose entry has `status === "closed"` or a non-empty `nightReflection` |
| `rescuetime:<id>` | schedule days counted in `expected` (completed schedule days, plus today for a "less" goal while the week is in progress); `scheduleDaysInWeek` once the week is over | equal to `daysApplicable` when the goal is known (RescueTime tracks automatically); `0` when `unknown` |
| `objective:<id>`, kind `time` | completed days | equal to `daysApplicable` when known (automatic); `0` when `unknown` |
| `objective:<id>`, kind `manual` | `1` | `1` when known, otherwise `0` |

With this table, a five-day RescueTime goal has full coverage at the end of the week with
`5/5`. It is never judged against 7.

`buildMidWeekReviewSummary(inputs)` takes these inputs:

- `weekStartDate`, `asOfDate`
- `weekEntries`: 7 decorated entries
- `summary`
- `goalsSnapshot`, `pulseSnapshot` (with `rescuetimeConfigured` / `fetchError`),
  `objectivesSnapshot`

It returns the window plus `paceScore`, `signals`, `lagging`, `ahead`, `unknown`,
`completedDayCount` and `closedDayCount`.

**Snapshot types** (pure, used by B2):

- `MidWeekLaggingSnapshot = { version: 1; asOfDate; completedDays; signals: MidWeekSnapshotSignal[] }`.
  Each `MidWeekSnapshotSignal` holds `key, category, label, direction, status, actual,
  expected, weekTarget, unit, daysApplicable, daysWithData, hasFullCoverage`.
- `buildMidWeekLaggingSnapshot(summary)` keeps the ranked `lagging` and `at_risk` signals,
  capped at 10.
- `parseMidWeekLaggingSnapshot(json)` returns `null` on bad JSON or an unknown `version`.
- `compareMidWeekSnapshot(snapshot, currentSummary)` pairs each snapshot signal with the
  current signal of the same key. The result carries `before`, `after` (`null` when the key
  is gone, e.g. a deleted RescueTime goal) and `recovered`:
  - `null` when `after` is missing, is `unknown`, or lacks `hasFullCoverage`. Only fully
    covered signals claim a verdict either way.
  - Otherwise `true` when the current status is `on_pace` or `ahead`, and `false` when it
    isn't.

### Also in B1

- `src/domain/rescuetime-goals.ts`: add `isScheduleDay(label, dayIndex)` and
  `completedScheduleDaysInWeek(label, completedDays)`. The second is built on the first. It
  uses Sunday = 0 and involves no `Date`.
- Move `computeAnsweredDisciplineScore`, with its comment, from
  `src/domain/insights/anomalies.ts` to `src/domain/daily-entry.ts`. Export it, import it in
  both places, and leave the formula unchanged.

### PR B1 tests (`mid-week-review.test.ts`, plus the extended existing suites)

- **Window:**
  - Sunday `0/7`, Wednesday `3/4`, Saturday `6/1`.
  - `weekEnd + 1` gives `7/0` with `dayIndex === null`; so does any later date.
  - A date before the week gives `0/7`.
  - A non-Sunday week start is normalized.
- **"More":** 24 pomodoros over 3 logged days is `on_pace`. 8 is `lagging`, with
  `remaining = 48` and `perRemainingDay = 12`.
- **Coverage:**
  - A completed day with no value is excluded from `daysWithData`.
  - `metrics.pomodoris = null` with `suggestedMetrics.pomodoris = 8` counts toward the total.
  - Nothing logged gives `unknown`.
- **"Less":** more than 10 % under budget is `ahead`, and `actual = 0` is `ahead` with a
  finite ratio. Exactly 10 % over is `on_pace`, 15 % over is `at_risk`, and far over is
  `lagging`. `remaining` is `0` once the budget is spent.
- **Quality, habits and discipline:**
  - Sleep quality averages only the days with a value.
  - A habit answered `null` is not a miss; `false` is. With no day answered, the habit is
    `unknown`.
  - Discipline uses only answered principles as its denominator.
- **Tasks:** `added = 0 && completed = 0` is `unknown`. Break-even counts are correct.
- **Journal:** only non-empty `nightReflection` values count. On Wednesday, with Monday and
  Tuesday closed with reflections and Sunday having no entry, the result is
  `actual = 2, expected = 2`, `on_pace`, not `2/3`. A closed day with an empty reflection
  is a miss.
- **RescueTime:**
  - A 24x7 "more" goal at half the pro-rated target is `lagging`.
  - A 5-day goal on Wednesday counts 2 completed weekdays.
  - On the same fixture, a "less" goal includes today and a "more" goal does not.
  - A "less" goal with `asOfDate = weekEnd + 1` has `expected === weeklyTargetHours`, not
    `8/7` of it.
  - `weekTarget` is set for every signal category according to the table.
  - An unconfigured key or a `fetchError` gives `unknown` while other signals still compute.
- **Objectives:** `time` objectives are pro-rated. A `manual` objective is `ahead` when
  achieved and `unknown` otherwise. A `null` hours value gives `unknown`.
- **Ranking and thresholds:**
  - A one-day signal ranks below an equally lagging three-day signal; ties break on `key`.
  - `paceScore` is `null` when every signal is `unknown`.
  - Threshold boundaries are asserted against the exported constants.
  - Floating-point boundaries with decimal and integer targets, at both thresholds and in
    both directions. Each is asserted on its exact value:
    - "less", `expected 100, actual 110`: `on_pace`
    - "less", `expected 0.3, actual 0.33`: `on_pace`
    - "less", `expected 7.7, actual 9.625` (25 % over): `lagging`
    - "more", `expected 0.7, actual 0.63`: `on_pace`
    - "more", `expected 0.7, actual 0.525` (25 % short): `lagging`
    - "more", `expected 0.7, actual 0.77` (10 % ahead): `ahead`
- **Coverage per category:** `daysApplicable`, `daysWithData` and `hasFullCoverage` match the
  coverage table. At the end of the week (`asOfDate = weekEnd + 1`):
  - A five-day RescueTime goal is `5/5`, full coverage.
  - A 24x7 goal is `7/7`.
  - Tasks with full data have full coverage.
  - Journal with two closed days and five unlogged days is `2/7`, not full.
  - A time objective is full when known.
  - A manual objective is `1/1` when known.
  - A manual objective is only ever `ahead` or `unknown`, so it never enters
    `buildMidWeekLaggingSnapshot`; its end-of-week recovery test constructs the snapshot
    signal directly. When marked achieved, a manual objective also gets
    `endsOnWeekStartDate` set to the previous Sunday (#172), so it usually drops out of that
    week's items entirely.
- **Empty week:** nothing throws, and no field is `NaN` or `Infinity`.
- **Snapshot:**
  - `buildMidWeekLaggingSnapshot` keeps only `lagging` and `at_risk`, in order, capped at 10.
  - Parsing round-trips; bad JSON and an unknown version give `null`.
  - `compareMidWeekSnapshot` covers recovered, not recovered, a missing key, an `unknown`
    current signal, and a current signal without full coverage (`recovered: null`).
  - End-of-week recovery markers for a five-day RescueTime goal, a 24x7 goal, tasks, the
    journal, a time objective and a manual objective.
- **Existing suites:**
  - `rescuetime-goals.test.ts`: `isScheduleDay` and `completedScheduleDaysInWeek` for 24x7
    and 5-day schedules, 0–7 days.
  - `anomalies.test.ts` stays green, and `daily-entry.test.ts` gets a direct test for the
    moved function.

---

## PR B2 — Page, decisions and weekly mirror

### B2.1 Migration 36 and repository parity

```sql
CREATE TABLE IF NOT EXISTS mid_week_decisions (
  week_start_date TEXT PRIMARY KEY,
  decisions TEXT NOT NULL,
  decided_on_date TEXT NOT NULL,
  lagging_snapshot_json TEXT,
  updated_at TEXT NOT NULL
);
```

- There is one row per week, and the owner can edit it any day of that week.
- `decided_on_date` is the local date of the last save, used for "décidé le mercredi".
- `lagging_snapshot_json` is the `MidWeekLaggingSnapshot` from the most recent save whose
  loads completed (see B2.3 item 9). It is nullable. Saving new text alone never erases or
  weakens it.
- There is no `created_at`; nothing would read it (same as `weekly_reviews`).
- Type: `MidWeekDecisions { weekStartDate; decisions; decidedOnDate; laggingSnapshot: MidWeekLaggingSnapshot | null; updatedAt }`.
  The row mapping parses the snapshot defensively and falls back to `null`.
- `AppRepository` gets `getMidWeekDecisions(weekStartDate)` and
  `saveMidWeekDecisions(record)` in both implementations:
  - `getMidWeekDecisions` resolves `null` **only** when no row exists. A read failure
    rejects; implementations never turn it into `null`, so the page can tell a miss from a
    failure.
  - `saveMidWeekDecisions(input: MidWeekDecisionsSaveInput)`, where
    `MidWeekDecisionsSaveInput = { weekStartDate; decisions; decidedOnDate; updatedAt;
    laggingSnapshot?: MidWeekLaggingSnapshot }`. This is deliberately **not**
    `MidWeekDecisions`, whose `laggingSnapshot` is `MidWeekLaggingSnapshot | null`.
    - There is no way to erase a stored snapshot. An absent or `undefined` `laggingSnapshot`
      binds SQL `NULL` (`laggingSnapshot ? JSON.stringify(laggingSnapshot) : null`), and
      `COALESCE` keeps the stored value.
    SQLite does this with `ON CONFLICT(week_start_date) DO UPDATE SET decisions = …,
    decided_on_date = …, updated_at = …, lagging_snapshot_json =
    COALESCE(excluded.lagging_snapshot_json, mid_week_decisions.lagging_snapshot_json)`
    inside `runExclusive`. An insert without a snapshot stores `NULL`. `MemoryRepository`
    matches this exactly.
  - `weekStartDate` is normalized with `buildWeekDates`, so a Wednesday date maps to its
    Sunday.
  - Timestamps are supplied by the caller.

### B2.2 Shared decorated week loader

Extract the decorated seven-day load into
`loadDecoratedWeekEntries(repository, weekStartDate): Promise<DailyEntry[]>`. The source is
in `src/lib/ai/context/weekly-snapshot.ts`: the spread element
`...weekDates.map((date) => repository.getDailyEntry(date))` of the `Promise.all` at lines
390–397, plus the `createEmptyDailyEntry` fill at lines 399–401.

- Put it in a new `src/lib/storage/week-entries.ts`. It takes a repository, so it doesn't
  belong in `src/domain/`, and two pages import it, so it doesn't belong under `src/lib/ai/`.
- In `resolveWeeklySnapshotInputs`, keep it **inside the existing `Promise.all`** as a
  single element so the loads stay parallel:
  `const [summary, review, historyEntries, tasks, projects, weekEntries] = await Promise.all([…, loadDecoratedWeekEntries(repository, normalized)])`.
- Reuse it in the mid-week page and the `/semaine` card.

**Never use `listDailyEntriesInRange` here.** It skips `decorateEntry` on purpose
(`memory-repository.ts`), which would remove the suggested pomodoro and task metrics. A day
with no entry row stays undecorated and counts as "no data". This differs slightly from
`computeWeeklyReviewSummary`, and the docs should say so.

### B2.3 `src/pages/MidWeekReviewPage.tsx`

- Takes `repository`, `settings` and `calendarDay` from `useAppContext()`, with
  `weekStart = getWeekStartSunday(calendarDay)`. It reloads when `calendarDay` changes
  (local-day reconciliation).
- **Parallel loads**, each guarded with `useLatestRequest` / `useAsyncResource`:
  - `computeWeeklyReviewSummary`
  - `loadDecoratedWeekEntries`
  - `computeAnnualGoalSnapshots(year, calendarDay)`
  - the three RescueTime and objectives services, with
    `{ maxAgeMs: MID_WEEK_RESCUETIME_MAX_AGE_MS }` (15 min, exported at the top of the file)
  - the decisions row: `useAsyncResource(weekStart, (week) =>
    repository.getMidWeekDecisions(week))`, a separate resource with its own `loading` /
    `error` / `reload` (see item 9)
- Entry-derived signals render first; RescueTime and objectives fill in when they load.
- Reuses the existing classes (`page`, `hero`, `SectionCard`, `weekly-overview-grid`,
  `status-card`, `banner`, `empty-copy`, `section-actions`).

Sections:

1. **Hero** (`PageHeader`): date range, `asOfDate`, completed and remaining days.
2. **Coverage line** (only when relevant): "N jours non clôturés — les verdicts portent
   sur M jours". It appears once and does not become 14 habit misses.
3. **Où j'en suis:** `paceScore`, the whole-week score labelled as a projection (never
   shown as the verdict) and the day counts.
4. **À rattraper:** `lagging`, then `at_risk`, each with actual vs expected and the recovery
   line. Shows the top 5, with a "tout afficher" toggle.
5. **Dans le vert:** collapsed `ahead` and `on_pace` signals.
6. **Signaux sans données:** `unknown` signals.
   - A `/parametres` link appears when the RescueTime key is missing.
   - A `cachedAt` notice and an "Actualiser" button that reloads with `maxAgeMs: 0`.
   - A RescueTime failure only affects its own signals; everything else still renders.
7. **Journal de la semaine:** non-empty `morningIntention` / `nightReflection` /
   `tomorrowFocus` for the week so far, newest first.
   - Built with `buildJournalFeed({ dailyEntries, weeklyReviews: [], monthlyReviews: [], kind: "daily", sort: "newerFirst", range: { startDate: weekStart, endDate: asOfDate } })`.
   - Field labels come from `t("editor.<key>", { ns: "history" })`, with a `/journal` link.
8. **Objectifs annuels:** one compact line with the count of
   `!snapshot.measurement.onPace`, up to three titles and a `/objectifs-annuels` link.
9. **Ce que je change**: the editor for this week's decisions.
   - **Gated on the decisions read.** The editor never accepts input before the stored row
     is known. Otherwise, text typed during a slow read could overwrite existing decisions,
     or a late read could replace the draft.
     - While `decisions.loading`: render a disabled, `aria-busy` placeholder instead of
       `PersistedTextarea`.
     - On `decisions.error`: a `role="alert"` banner ("Impossible de charger tes
       décisions") and a "Réessayer" button that calls `decisions.reload()`. No editor, so
       a failed read can never be mistaken for "no decisions yet".
     - Once loaded: `<PersistedTextarea key={weekStart} savedValue={decisions.data?.decisions ?? ""} …>`,
       mounted only now so its initial draft is the stored text. It uses the default 450 ms
       debounce plus the blur and unmount flush.
   - **Acknowledged saves.** `onPersist` returns a promise, and `PersistedTextarea` gains
     acknowledged-save semantics for promise-returning callbacks (B2.3a). The confirmed value
     advances only after the save resolves. A rejected save keeps the text as an unsaved
     draft and raises a visible error with a retry.
   - **One save queue per week.** Saves go through
     `enqueueMidWeekDecisionSave(weekStart, text, task)` in a new module-scoped
     `src/app/mid-week-decision-saves.ts`.
     - It chains `task` on that week's promise. On rejection it records
       `failedDrafts.set(weekStart, { text, error })` and **re-throws**, so
       `PersistedTextarea` keeps the draft dirty. On success it clears that week's entry.
     - It also exports `getFailedMidWeekDraft(weekStart)` and
       `clearFailedMidWeekDraft(weekStart)`.
     - The chain is keyed by week and outlives the page, so saves for one week run strictly
       in order, even across an unmount flush and a remount. Without it, a save still
       waiting for the snapshot could land after a newer one and overwrite newer text with
       older text.
   - **Per-week save context.** A ref holds
     `Map<weekStart, { settled: Promise<void>; complete: boolean; summary: MidWeekReviewSummary | null }>`.
     - A fresh entry replaces any existing one each time a load cycle for that week
       starts: on mount, on a `calendarDay` change, or on the "Actualiser" refresh.
       - `complete` returns to `false`, and `settled` becomes a new pending promise.
       - `summary` is overwritten only when the new cycle's summary lands.
       - So a save during a refresh omits the snapshot patch and keeps the stored
         snapshot, instead of writing a half-refreshed one.
     - `settled` resolves in the loads' `finally`, independently of the request guard, so it
       still resolves after unmount.
     - `summary` is updated as loads land.
     - `complete` becomes `true` only when all of these settled successfully:
       - the entries and the summary
       - goals, pulse and objectives, each with no remaining `fetchError`. A cached
         fallback counts, since it clears `fetchError`. A missing-key state counts, since
         it is the real state.
   - **The task each save runs**, capturing `weekStart` and `calendarDay` at render time:
     1. `const entry = saveContextRef.current.get(weekStart)`, then
        `await Promise.race([entry?.settled ?? Promise.resolve(), delay(MID_WEEK_SNAPSHOT_WAIT_MS)])`.
        `MID_WEEK_SNAPSHOT_WAIT_MS = 2000` is exported next to
        `MID_WEEK_RESCUETIME_MAX_AGE_MS`.
     2. Reads the context again from the ref after the wait, never from closed-over state,
        which is stale by construction after an `await`.
     3. Includes `laggingSnapshot: buildMidWeekLaggingSnapshot(entry.summary)` **only when**
        `entry?.complete && entry.summary?.weekStartDate === weekStart &&
        entry.summary.completedDays > 0`. Otherwise it **omits** `laggingSnapshot`, so the
        stored snapshot is preserved (B2.1).
        - A timeout, a partial load, an external fetch failure, Sunday, and the previous
          week's list shown on Sunday all fall into this case.
        - An earlier complete Wednesday snapshot is therefore never replaced by a partial
          Friday one, nor erased.
     4. `await repository.saveMidWeekDecisions({ weekStartDate: weekStart, decisions: value,
        decidedOnDate: calendarDay, updatedAt: nowIso(), ...snapshotPatch })`.
   - **Failures stay visible and are never silent.**
     - While mounted: a rejected save (debounce, blur or explicit flush) shows a
       `role="alert"` banner ("Décisions non enregistrées") with a "Réessayer" button that
       calls the textarea handle's `flush()`. The draft stays dirty, so the next edit or blur
       also retries. A small status line shows "Enregistrement…" or "Enregistré".
     - After unmount: a save that rejects after the page is gone (the unmount flush) is
       recorded in the same module as `failedDrafts: Map<weekStart, { text, error }>`. On
       the next mount of that week, once the row has loaded, the page restores that text
       with the handle's `setDraft` (marking it dirty) and shows the same banner and retry.
       A successful save for the week clears the entry.
     - The failed-draft store lives in memory. A failure followed by quitting the app
       before revisiting loses that draft; this is recorded under Risks.
   - `PersistedTextarea` skips the save when the text equals the confirmed value, so just
     visiting the page never rewrites the row or its snapshot.
   - The `key={weekStart}` remount sends text typed before midnight to the week it was typed
     in. (`onPersistRef` is refreshed on every render.)
   - The editor shows "dernière mise à jour le {decidedOnDate}" and a `/semaine` link.
   - Nothing reloads the decisions resource after a successful save. A reload sets
     `loading` and clears `data`, which would unmount the editor and drop a draft in
     progress. "dernière mise à jour le {decidedOnDate}" is updated optimistically from the
     save that just succeeded.
10. **Footer links:** `/semaine`, `/journal`, `/next-actions`, `/objectifs-annuels`,
    `/historique`.

**Sunday:** the pace sections are replaced. Implementer's choice: show the previous week's
ranked lagging list (`weekStart - 7`, `asOfDate = weekStart`) labelled "semaine précédente —
à rattraper cette semaine". "Ce que je change" still targets the current week.

### B2.3a `PersistedTextarea` acknowledged saves

Today `flushPersist` and the unmount cleanup advance `lastSavedRef` and clear `dirtyRef`
**before** calling `onPersist`, and ignore its result. A failed save is therefore lost and
never retried. Change it backward-compatibly:

- `onPersist: (value: string) => void | Promise<unknown>`, plus an optional
  `onPersistStateChange?: (state: "saving" | "saved" | "error", error?: unknown) => void`.
- **A callback that returns `void` behaves exactly as today.** Existing callers and tests
  are unchanged.
- **A callback that returns a promise:**
  - The value becomes the confirmed value (`lastSavedRef`) only when the promise
    resolves. The draft stays dirty until then, so a late `savedValue` never overwrites it.
  - At most one save is in flight per instance. A flush during an in-flight save records
    the newest value and sends it after the current one settles; intermediate values are
    coalesced.
  - A flush whose value equals the value already in flight is dropped. Otherwise an
    unchanged blur, or the unmount cleanup during an in-flight save, would issue a second
    identical write, because the `nextValue === lastSavedRef.current` short-circuit no
    longer covers it once `lastSavedRef` stops advancing early.
  - On rejection, the confirmed value doesn't change and `onPersistStateChange("error",
    error)` fires. The next change, blur or `flush()` retries, because the draft still
    differs from the confirmed value.
  - An unmount flush still issues the save. A rejection after unmount still reaches
    `onPersistStateChange` through the ref, which is how the page records failed drafts.
- Tests in `PersistedTextarea.test.tsx`:
  - The existing `void` behavior is unchanged.
  - A resolved promise advances the confirmed value.
  - A rejected debounce save keeps the draft dirty, reports `error`, and retries on blur.
  - A rejected blur save retries on the next `flush()`.
  - A rejected unmount save reports `error` after unmount.
  - A flush during an in-flight save sends only the newest value, after the first settles.
  - A blur or unmount with the same value as the in-flight save issues no second write.
  - A `savedValue` change during an unconfirmed save doesn't replace the draft.

### B2.4 `/semaine` card: "Décisions de mi-semaine" (read-only)

- Loaded in the existing week-load effect for `selectedWeekStart` and reset when the week
  changes.
- If there is no row, show an empty-state line and a `/mi-semaine` link. If the read
  fails, show an error line with a retry, never the empty state.
- If there is a row, show the decisions text and "décidé le {decidedOnDate}". If
  `laggingSnapshot` is present, add a before/after list with one line per snapshot signal:
  - label
  - value when the snapshot was taken: actual / expected, plus status, labelled with the
    snapshot's own `asOfDate`. Not `decidedOnDate`, since a later text-only edit keeps the
    older snapshot.
  - value at the end of the week: actual / `weekTarget`, plus status
  - a recovered or not-recovered marker
- **End-of-week summary:** build it with `buildMidWeekReviewSummary`, with
  `asOfDate = weekEndDate < calendarDay ? addDays(weekEndDate, 1) : calendarDay`:
  - For a past week this gives all 7 days complete.
  - For the current week the after side is labelled "à ce jour".
  - Inputs are data the page already holds for `selectedWeekStart` (`summary`,
    `goalsSnapshot`, `pulseSnapshot`, `standingObjectivesSnapshot`, reusing the
    `snapshot?.weekStartDate === summary.weekStartDate` guard pattern), plus
    `loadDecoratedWeekEntries`.
  - Load the entries and compute this summary **only when `decisions?.laggingSnapshot` is
    non-null**, so plain week navigation doesn't add seven queries.
  - Pair the two lists with `compareMidWeekSnapshot`.
    - A missing key shows `weekly.midWeekDecisions.gone` ("—").
    - An after side that is `unknown` (for example, the RescueTime key was removed since
      Wednesday) shows `weekly.midWeekDecisions.unknown`.
  - **Coverage caveat.** When the after side lacks `hasFullCoverage` (per-signal coverage,
    B1):
    - The line carries `weekly.midWeekDecisions.partialCoverage` ("sur {{withData}} /
      {{applicable}} jours renseignés").
    - `recovered` is `null`, which renders as the neutral marker, not "rattrapé". Only
      fully covered signals claim recovery. So "40/56 · rattrapé" can't appear on a week
      with 5 logged days, while a five-day RescueTime goal at `5/5` still can.
- No textarea and no write path. No interaction with `review.notes` or with accepting a
  synthesis draft; accepting a draft replaces `tempsEtPlan`, which is why the decisions are
  kept out of it.
- Decisions are **not** added to the weekly synthesis snapshot. That would change every
  week's `inputHash`.

### B2.5 Wiring, copy, styles

- `src/App.tsx`: add a `mi-semaine` route after `semaine`.
- `AppShell` nav: add `{ to: "/mi-semaine", labelKey: "midWeek" }`, with
  `nav.json` `"midWeek": "Mi-semaine"`.
- `TodayPage`:
  - The Wednesday block links to `/mi-semaine`.
  - Drop the now-unused `getWeekStartSunday` import, or Biome fails.
  - Rename `today.wednesday.openWeekly` to `openMidWeek` ("Ouvrir le point de mi-semaine").
  - Until PR D ships, the copy says "où tu en es / à rattraper", never "analyse".
- `reviews.json`:
  - A new `midWeek` block: `hero`, `loading`, `sunday`, `pace`, `lagging`, `ahead`,
    `unknown`, `decisions`, `links`, `status.*`, `category.*`, `recovery.*`, `format`,
    `cachedNotice`, `refresh`.
  - A new `weekly.midWeekDecisions.*` block for the card, including `before`, `after`,
    `toDate`, `recovered`, `notRecovered`, `neutral`, `partialCoverage`, `gone` and
    `unknown`.
- `styles.css`: at most a small accent block for lagging and at-risk, with the mobile
  breakpoint.

### B2.6 Docs

- `docs/reviews-and-goals.md`: a new section, "Mid-week check (`/mi-semaine`)". It covers:
  - the pace window and why today is excluded
  - why "less" RescueTime goals include today
  - the answered and has-data denominators
  - coverage-weighted severity
  - the tunable constants and where they live
  - `MID_WEEK_RESCUETIME_MAX_AGE_MS` compared with the weekly page's live pull
  - the journal section
  - the decisions, the Wednesday snapshot, and when the snapshot is replaced vs preserved
  - acknowledged saves and what the owner sees when a save fails
  - the `/semaine` before/after card
  - the difference from `/semaine` figures for days with no entry row

  Also fix line ~24, which still describes the `?date=` link.
- `docs/daily-routines.md`: fix the Wednesday bullet (line ~38).
- `docs/architecture.md`: add a route-catalog row for `/mi-semaine`.
- `docs/storage-and-backups.md`: add the migration 36 row and a `mid_week_decisions` table
  block (including the snapshot-preserving upsert).
- Prepend entries to `docs/logs/` for `reviews-and-goals`, `daily-routines`, `architecture`
  and `storage-and-backups`.
- No new `docs/` page, so `AGENTS.md` / `CLAUDE.md` stay unchanged.

### PR B2 tests

- `migrations/mid-week-decisions.test.ts`: migration 36 exists and contains
  `CREATE TABLE mid_week_decisions`.
- Repository, in the shared contract suite:
  - Round trip with and without a snapshot.
  - A Wednesday date normalizes to its Sunday.
  - An upsert with a snapshot replaces the text, `decidedOnDate`, the snapshot and
    `updatedAt`.
  - An upsert **without** `laggingSnapshot` updates the text and dates and keeps the stored
    snapshot.
  - A first insert without a snapshot stores `null`.
  - A miss returns `null`.
  - A corrupt snapshot JSON reads as `laggingSnapshot: null`.
- `mid-week-decision-saves.test.ts`:
  - Saves for one week run in order even when the first task waits longer.
  - Different weeks don't block each other.
  - A failed draft is recorded and then cleared by a later success.
- `loadDecoratedWeekEntries`: suggested metrics are present, and empty days are filled. The
  weekly snapshot tests stay green.
- `MidWeekReviewPage.test.tsx` (`renderWithApp`, `contextOverrides: { calendarDay }`, seeded
  `MemoryRepository`):
  - On a seeded Wednesday, "À rattraper" shows the expected signal and recovery line; that
    signal is not under "Dans le vert"; the list caps at 5 and expands.
  - Pomodoro sessions and GTD events with **no** explicit metrics: `metric:pomodoris` and
    `tasks:completion` are **not** under "Signaux sans données".
  - On Sunday, the Sunday state renders with no current-week verdicts.
  - With no RescueTime key, entry-derived signals render along with the missing-key banner
    and the `/parametres` link.
  - Journal: only non-empty fields, newest first.
  - Decisions: typing saves through `saveMidWeekDecisions` with
    `decidedOnDate === calendarDay` and a non-null `laggingSnapshot` containing the seeded
    lagging key; nothing calls `saveWeeklyReview`.
  - Deferred read: with a seeded row `X` whose `getMidWeekDecisions` is held pending, the
    editor isn't editable, typing is impossible, and no save happens. When the read
    resolves, the editor shows `X`.
  - Rejected read: no editor and an alert with "Réessayer". The retry loads the row and
    shows the editor.
  - Rejected saves:
    - Debounce: shows the alert and keeps the text; "Réessayer" saves it.
    - Blur: same.
    - Unmount: remounting the same week shows the failed draft, the alert and the retry,
      and a successful retry clears it.
  - Ordering: two quick saves where the first waits on the snapshot leave the row with the
    **newer** text.
  - A save made while an "Actualiser" refresh is in flight keeps the stored snapshot.
  - After a successful save, the decisions resource isn't reloaded, the editor stays
    mounted with the draft, and the "dernière mise à jour" line updates.
  - Snapshot preservation, each starting from a seeded row with a complete Wednesday
    snapshot. A Friday text edit keeps the Wednesday snapshot when:
    - an external load hangs past `MID_WEEK_SNAPSHOT_WAIT_MS` while the entry-derived
      summary is ready
    - no summary is ready
    - RescueTime fails with no cache
    - it is Sunday

    A Friday edit after a complete load replaces it.
  - A seeded row renders its text.
  - Mounting with two different `calendarDay` values targets the right week each time.
  - If the loads never settle, a save still writes the text within
    `MID_WEEK_SNAPSHOT_WAIT_MS` without a snapshot patch. With no prior row, the stored
    snapshot is `null`.
  - Typing, then remounting with a `calendarDay` in the next week, writes the text to the
    **old** week's row without attaching the new week's snapshot.
  - On a Sunday `calendarDay`, a save omits the snapshot patch, so an existing snapshot is
    kept.
- `WeeklyReviewPage.test.tsx`:
  - The seeded decisions render read-only with a `/mi-semaine` link.
  - A seeded snapshot shows before/after lines with recovered and not-recovered markers.
  - A snapshot key missing from the final summary shows "—", and an `unknown` after side
    shows its own label.
  - An after side without full coverage shows the coverage caveat and the neutral marker,
    never "rattrapé". A five-day RescueTime goal at `5/5` that recovered does show
    "rattrapé".
  - The before side is labelled with the snapshot's `asOfDate`, even when `decidedOnDate`
    is later.
  - A failed decisions read shows the error line, not the empty state.
  - With no row, or a row whose snapshot is `null`, the entries are not loaded and no
    before/after list renders.
  - With no row, the empty state renders.
- `TodayPage.test.tsx` (the Wednesday prompt test, around line 178): the link goes to
  `/mi-semaine` and has the new accessible name.

---

## PR C — Mid-week decisions in the journal (optional, not approved)

Ship only on owner confirmation. Dropping it changes nothing in A, B or D.

- Add `listMidWeekDecisionsOverlapping(start, end)` to both repositories, mirroring
  `listWeeklyReviewsOverlapping`.
- `journal-feed.ts`:
  - Add a `midWeek` kind, ranked between `daily` and `weekly`.
  - `toMidWeekItem` sets `sortDate: decidedOnDate`, `href: "/mi-semaine"` and the field
    `decisions`, and drops blank text.
- `JournalPage`:
  - Add the kind option.
  - Add explicit `midWeek` branches to `fieldLabel` and `periodLabel` before the monthly
    fallthrough.
- Update the i18n files and `docs/daily-routines.md`, and add a log entry.
- Tests: feed ordering and filtering; the page's kind filter; overlap boundaries.

---

## PR D — AI steering (`mid_week_steering`)

Display-only, mirroring `goal_pacing`: no proposals, no `ai_proposals`. **No migration**:
`ai_messages.surface` has no `CHECK` constraint.

- **Types:**
  - `AiSurface` gets `"mid_week_steering"`.
  - `MidWeekSteeringResponse { asOfDate; headline; read; focusShift; actions: { signalKey; title; why; effort }[] }`.
  - `MidWeekSteeringResult { message; steering; source; warning? }`.
  - `context/types.ts` `Surface` gets `"midweek"`.
- **`context/mid-week-snapshot.ts`:** `buildMidWeekSnapshot(inputs, scope)` contains:
  - the B1 summary: signals, statuses, ranked lagging
  - titles, gated by `includeStructure`
  - free text, gated by `includeFreeText` (`aiPayloadScope === "full"`): the non-empty
    journal fields for completed days (capped like `buildPastorSnapshot`) **and the week's
    decisions text**

  This is the single place where redaction happens.
- **`proposals/mid-week-steering-*`:**
  - Schema prompt.
  - The snapshot lists `actionableKeys`: the ranked `lagging` and `at_risk` keys.
  - Validator:
    - Every `actions[].signalKey` must be in `actionableKeys`. A green (`ahead` /
      `on_pace`), `unknown` or absent key, or a key repeated across actions, makes the
      response invalid, and it goes through the existing repair-then-fallback path.
    - When `actionableKeys` is empty, only `actions: []` is valid.
  - Local fallback built from `rankMidWeekSignals` and the B1 recovery strings.
- **`mid-week-steering-service.ts`** (`mid_week_steering.v1`), following the `goal_pacing`
  pattern:
  - `scopeKey = weekStartDate`
  - `inputHash` covers the prompt version, scope, snapshot, memory ids and `asOfDate`
  - reads the ok-only cache when AI is configured, and persists `skipped` when it isn't
  - on a provider error or unparseable output, persists `fallback` with the local body
  - reuses `retrieveMemoriesForWeekly`
- **Loader:** rejects a stale `promptVersion` and exposes `asOfDate`, so the panel can label
  a result from an earlier day of the week.
- **Also:**
  - the provider request union and system prompt (see #168)
  - the prompts registry and the `settings.json` label
  - `SURFACE_LABELS`, the typecheck tripwire, and the `coach.json` label
  - `MidWeekSteeringPanel` (modeled on `GoalPacingPanel`)
  - hydrate-then-auto-run on the page, after the RescueTime loads settle
  - **Sunday (`completedDays === 0`): no AI at all.** No hydrate, no auto-run, no provider
    call and no persisted message; the request button is hidden. The panel shows one line
    ("Le coach de mi-semaine reprend lundi"). The deterministic Sunday view (the previous
    week's list) is the only steering shown, so the AI can't cache an empty,
    evidence-free response that contradicts it.
  - optionally, a debug payload-preview option
- **Cost:** a new day or a new decision text changes the hash, costing one call per page
  open. This is intentional and documented.
- **Docs:** `docs/ai-settings-and-privacy.md` (the surface, the hash, the fallback, and the
  inclusion of journal and decisions at `full` scope) and its log.
- **Tests:** mirror the `goal-pacing` suites (validator, fallback, cache hit, cache miss on
  a new `asOfDate`, `skipped`, provider throw, stale version). The snapshot includes the
  decisions only at `full` scope.
  - Validator cases: rejects a green key, an `unknown` key, a key missing from the snapshot
    and a repeated key; accepts only `[]` when nothing is actionable; accepts distinct
    actionable keys.
  - Page, on Sunday: the provider is never called, no `ai_messages` row is written, and the
    panel shows the Sunday line.

---

## Risks accepted

- The freshness window can show RescueTime numbers up to 15 minutes old with no error
  banner. The `cachedAt` notice and "Actualiser" mitigate this. It departs from §1's
  "read only on failure" rule on purpose.
- `scheduleDaysInWeek` guesses the schedule from the goal's name, so pro-rating a 5-day goal
  depends on that label.
- Mid-week figures differ slightly from `/semaine` for days with no entry row. This is
  documented.
- `0.1` / `0.25` are starting guesses, exported and tested against the constants.
- Until PR D ships, the page is deterministic only. That's acceptable because the journal
  section, the `journal:reflections` signal and the saved decisions all ship in B.
- The snapshot records the lagging list as of the **last save whose loads completed**. A
  text-only or incomplete save keeps the previous snapshot. The card labels the before side
  with the snapshot's own `asOfDate`.
- A missing RescueTime key counts as a complete load, because it is the real state. A save
  made after the key was removed therefore replaces a complete Wednesday snapshot with one
  that has no RescueTime signals.
- A failed unmount save for a week that rolls over at midnight stays in `failedDrafts`,
  since the page only restores drafts for the week it mounts with. It is lost when the app
  quits, like the case below.
- The failed-draft store is in memory. A save that fails at unmount, followed by quitting
  the app before revisiting the page, loses that draft. SQLite write failures are rare in a
  local-first app, and every failure while the page is open is visible with a retry.

## Gates

`npm run verify` for every PR (lint, typecheck, test, build). No Rust changes.
