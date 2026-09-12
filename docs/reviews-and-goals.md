# Reviews and Annual Goals

See also: [changelog](logs/reviews-and-goals.md).

TrackDidia turns daily evidence into three higher-level loops:

- Sunday-to-Saturday weekly reviews;
- calendar-month reviews;
- annual goal snapshots with monthly evaluations.

Review records store ritual notes/checklists and open/closed state. Numeric summaries
are computed on demand and are not persisted.

## Weekly review (`/semaine`)

### Calendar model

The business week always begins Sunday and ends Saturday. Any selected date is
normalized to its Sunday with `getWeekStartSunday()`. A `?date=YYYY-MM-DD` query
opens that week on load.

Reading daily, weekly, and monthly notes together lives on
[`/journal`](daily-routines.md#journal). That page is read-only;
`/semaine` remains the editor.

When a weekly summary is requested, the repository constructs all seven days.
Missing days become empty daily entries for that calculation. This means weekly
averages and rates intentionally include zero-valued empty days in several axes.

### Stored review

`WeeklyReview` contains:

- `weekStartDate`;
- `weekEndDate`;
- `status`: `draft` or `closed`;
- eight note fields;
- eight completion booleans;
- `updatedAt`.

The eight ritual sections are:

1. Bilan
2. Budget
3. Temps et plan
4. Collecte
5. Calendrier
6. GTD
7. Alignement
8. Dimanche

Notes and checklist changes persist immediately, including when leaving the
page. Saves are serialized so the latest draft wins if several writes overlap.
Closing does not require all sections to be checked.

### Daily inputs

Each day contributes:

- sleep quality;
- whether TRC is exactly `true`;
- phone screen minutes;
- Pomodoro count;
- calorie expenditure;
- discipline fraction;
- tasks added;
- tasks completed.

Explicit daily metrics override suggested GTD/Pomodoro values.

### Weekly aggregate formulas

| Output | Formula |
|---|---|
| Sleep average | Average of non-null sleep values |
| TRC | `true` days / 7 |
| Screen time | Sum of daily minutes |
| Pomodoris | Sum of daily sessions |
| Discipline | Average of seven daily discipline fractions |
| Tasks added/completed | Sum of daily values |
| Task completion rate | Completed / added; zero when added is zero |
| Calorie average | Mean of seven daily values (null → 0) |
| Physical activity axis | `(calorieAverage * 100) / 3800`, lower-clamped |

The automatic score has **seven local axes** (used by monthly and annual summaries):

1. Sleep quality against 100.
2. TRC percentage against 100.
3. Phone screen axis, where 840 weekly minutes is 100, zero minutes is 200, and
   1,680 minutes is zero (lower-clamped, not upper-clamped).
4. Focus time (Pomodoro) axis, where 56 weekly sessions is 100.
5. Discipline percentage against 100.
6. Task completion percentage against 100.
7. Physical activity axis against 3,800 kcal/day average.

Each axis is passed through `scoreAgainstTarget(value, 100)`. Values through the
target scale linearly from zero to one; above-target performance continues at half
the rate. Repository `weeklyScore` is the mean of those seven normalized axis values
and can therefore exceed `1` (100%).

On `/semaine`, two optional **RescueTime axes** overlay the score when data is
available (non-null):

8. RescueTime Goals score (`0–1` from enabled goals).
9. Computer productivity pulse (`0–100`, time-weighted from Analytic Data).

`applyWeeklyScoreExternalAxes()` recomputes the displayed weekly score as the mean
of the seven local axes plus each non-null RescueTime axis. Stale RescueTime
snapshots from a different week are ignored until the matching week loads. Monthly
`weeklyScoreAverage` and annual `weekly_weekly_score` use the seven-axis local score
only (calories included; RescueTime excluded).

### Weekly objectives

The `/semaine` screen tracks **two distinct objective systems**:

1. **RescueTime Goals** (read-only): enabled goals from the RescueTime API feed optional RescueTime score axes on the weekly overview. Manage goals in RescueTime; configure the API key under **Paramètres → RescueTime**.
2. **Standing objectives** (`weekly_objectives`): durable TrackDidia objectives the coach can propose via `weekly_objective` accept-step. The page lists them with a per-week score, lets you toggle manual achievement (`saveWeeklyObjectiveResult`), and delete objectives. Time-based objectives score against RescueTime Analytic Data when configured.

RescueTime Goals remain the optional weekly-score axis described below. Standing objectives use `WeeklyObjectivesService.computeWeeklyObjectivesSnapshot()` and are separate from RescueTime Goals.

### RescueTime Goals (weekly score axis)

The `/semaine` screen loads **enabled RescueTime Goals** and a **productivity pulse**
from the Analytic Data API for the selected Sunday–Saturday week. These scores feed
the optional RescueTime axes above; they are not persisted and are not part of the
repository weekly summary.

Each goal is worth at most **1 point**:

| Direction | Achievement |
|---|---|
| More time | `min(actualHours / weeklyTargetHours, 1)` |
| Less time | `1` when under the weekly cap; otherwise `weeklyTargetHours / actualHours` |

Weekly target hours come from the goal's daily `amount_seconds` multiplied by the
number of days implied by the goal schedule (`7` for 24x7, `5` for working/weekday
schedules).

```text
score = sum(achievement) / count(goals)
```

When there are no enabled goals, the score displays `—` (null), not `0%`.

### Computer productivity pulse

The weekly pulse uses Analytic Data with `restrict_kind=productivity` (no
`restrict_schedule_id`):

```text
GET anapi/data?format=json&perspective=rank&restrict_kind=productivity
  &restrict_begin={Sunday}&restrict_end={Saturday}
```

RescueTime productivity levels (`-2`..`+2`) are time-weighted:

```text
mean = sum(productivityLevel * seconds) / sum(seconds)
pulse = ((mean + 2) / 4) * 100
```

When there is no tracked computer time (`sum(seconds) === 0`), the pulse is `null`
and excluded from the displayed weekly score. A real `0` pulse is included.

Goals are read-only in TrackDidia — manage them in RescueTime. Configure the API key
under **Paramètres → RescueTime** (stored in SQLite, same as OpenRouter). Time data
comes from the Analytic Data API (`restrict_kind` from the goal's `taxonomy_name`:
overview, category, activity, or productivity) and labeled project times (projects
and clients). Project and client goals count **reviewed** timesheet blocks only:
RescueTime marks unconfirmed autocompletions with `extra.draft: true`, and those
suggestions are excluded so TrackDidia matches Goals and default Timesheets reports.
RescueTime's overview taxonomy advertises `search_name: "category"`;
TrackDidia prefers `taxonomy_name` so overview goals such as Personal match overview
rank data, not subcategory rows.

Schedule windows such as “Evening family time” are not filtered yet; v1 uses full-week
totals with a documented approximation.

### Weekly coach synthesis

Opening `/semaine` triggers the `weekly_synthesis` AI surface for the selected week
(Sunday start). The coach panel shows a headline, score explanation, strongest/weakest
axes, and accept-step proposals:

- section note drafts for the eight ritual blocks;
- up to five suggested standing objectives for next week;
- GTD actions (`schedule`, `defer`, `delegate`, `drop`) on **active** tasks only.

Synthesis loading and acceptance are **week-scoped**: changing the selected week
invalidates in-flight loads, hides mismatched results, and rejects accept/dismiss when
the proposal message `scopeKey` does not match the displayed week.

Accepting a section draft **persists the note** on the weekly review immediately (the
textarea is also prefilled). Accepting an objective creates a row in `weekly_objectives`
via an idempotent atomic accept. GTD accepts are atomic and skip terminal tasks.

Successful AI results (`status = ok`) cache on `(surface, weekStartDate, input_hash)`.
`skipped` rows cache while AI is off. `fallback` and `error` rows are retryable and
are not treated as sticky cache hits when AI is configured. Regenerating always appends
a new message episode.

When AI is off, the local deterministic brief still renders from weekly insight findings.

### Monthly coach synthesis

Opening `/mois` triggers the `monthly_synthesis` AI surface for the selected month.
The coach panel shows a headline, a week-pattern read, and accept-step proposals:

- section note drafts for the ten ritual blocks;
- `goal_evaluation` rows that write an `AnnualGoalEvaluation` for the month when accepted.

Synthesis loading and acceptance are **month-scoped**: changing the selected month
invalidates in-flight loads, hides mismatched results, and rejects accept/dismiss when
the proposal message `scopeKey` does not match the displayed month.

Accepting a section draft **persists the note** on the monthly review immediately (the
textarea is also prefilled). Accepting a `goal_evaluation`
for a goal that no longer exists dismisses the proposal with a short notice. Results are
cached in `ai_messages` keyed by `(surface, monthKey, input_hash)`.

### Annual goal pacing

Opening `/objectifs-annuels` triggers the S4 `goal_pacing` surface for the selected year
when the year is between 2000 and 2100 and the evaluation month is a valid `YYYY-MM`
value. Changing the year clears the pacing panel until the new year's result loads.
The panel is **informational only** — no accept-step. Only `active` goals are sent to
the AI payload; `paused` and `abandoned` goals do not generate coaching.

The pacing expectation is per measurement type (`computeAnnualGoalExpectedRatio`):

- **numeric / cumulative** — the year-to-date fraction elapsed (from
  `computeYearProgressFraction`), or, when the goal has a `deadline`, the fraction
  elapsed from January 1 to the deadline instead.
- **recurring** — always `1`. Adherence is expected to be 100% from week one; it is
  never graded against how much of the calendar year has passed.
- **binary** — the deadline/year fraction compared against the *milestone* completion
  ratio, when the goal has milestones. Without milestones there is nothing to
  interpolate between "not done" and "done", so no percentage is manufactured: the
  expectation is `null` and the goal is only reported off-pace once its deadline (if
  any) has passed and it is still not achieved.

Goals marked on pace use the same tolerance as `ANNUAL_GOAL_PACE_TOLERANCE` (0.1);
local fallback risk levels align with that band so on-pace goals are never labeled
medium risk. A brand-new recurring goal with `periodsElapsed === 0` is a special case
of this: `onPace` is `true` (nothing has been due yet), and the local fallback's
`riskLevelFor` reports `"low"` to match, so the card never shows a contradictory
"on pace" / "medium risk" pairing.

Results are cached in `ai_messages` keyed by `(surface, year, input_hash)`; the prompt
version (`goal_pacing.v2`) changed when per-type measurement fields were added, so any
cached v1 result is never reused against the new payload shape. This applies to the
page-load fast path too: `loadLatestGoalPacing` (`src/lib/ai/goal-pacing-loader.ts`)
hydrates the newest `ok` row by `(surface, scopeKey, status)` only, so it separately
rejects a stored row whose `promptVersion` does not match the current prompt version,
falling through to a fresh `runPacing` instead of rendering a stale-shaped result.

## Monthly review (`/mois`)

### Calendar model

Monthly reviews use a `YYYY-MM` key and the calendar month's first/last day.
The Today screen prompts on the first Saturday of a month and the Monthly screen
initially selects the previous month on that day; otherwise it selects the current
month. A `?month=YYYY-MM` query opens that month on load.

Reading those notes together with daily and weekly journals lives on
[`/journal`](daily-routines.md#journal). `/mois` remains the editor.

Weeks are included when their Sunday start is on or before the month end, beginning
with the Sunday containing the first day. Therefore a month covers four to six
Sunday-start weeks, including boundary weeks.

### Stored review

`MonthlyReview` stores:

- month key/start/end;
- `draft` or `closed` status;
- ten note fields;
- ten completion booleans;
- update timestamp.

The sections are:

1. Bilan
2. Journaux
3. Finances
4. Temps
5. Progression des objectifs
6. Mission et objectifs
7. Nettoyage des listes
8. Calendrier
9. Gros projets
10. Développement personnel

### Monthly summary

Daily aggregates use only saved entries whose date is inside the selected month.
Unlike weekly summaries, missing dates are not synthesized for the monthly daily
average.

The summary reports:

- days tracked;
- overlapping weeks covered;
- closed weekly reviews;
- sleep average over non-null values;
- TRC true days / tracked days;
- total screen minutes;
- total Pomodoris;
- average daily discipline;
- completed / added tasks;
- average weekly score across every overlapping week summary;
- per-week review status and number of non-empty note sections.

Because overlapping weekly summaries synthesize missing days, `weeklyScoreAverage`
may include boundary days and empty days outside the month. This is current behavior.

The screen also loads annual goal snapshots for the selected year and displays a
per-measurement-type readout for each goal (achieved/milestones for binary,
current/target/month for numeric, running total for cumulative, this-period/adherence/
streak for recurring) alongside the month's evaluation. This is a read-only summary
with its own JSX and `reviews` locale keys — it does not reuse the editable
`AnnualGoalFields` form from `/objectifs-annuels` (that component only makes sense for
an editable card), but its cumulative/recurring readouts are interpolated through the
same `t(...)` value-and-fallback shape as the `/objectifs-annuels` card so the two
pages report identical numbers for identical goal data. Coverage for all four
measurement types lives in `src/pages/MonthlyReviewPage.test.tsx`.

## Annual goals (`/objectifs-annuels`)

### Goal model

An annual goal contains:

- title and description;
- dimension: physical, spiritual, social, intellectual, or global;
- `measurementType`: `binary`, `numeric`, `cumulative`, or `recurring` (defaults to
  `numeric`);
- `status`: `active`, `paused`, `achieved`, or `abandoned` (defaults to `active`);
  for a **binary** goal, `status === "achieved"` *is* the achievement flag — there is
  no separate boolean, so there is exactly one source of truth;
- optional `deadline` (local `YYYY-MM-DD`) that narrows the pacing expectation when
  set, for any measurement type;
- optional numeric target and unit;
- optional automatic source ID;
- optional manual current value;
- `startingValue` and `direction` (numeric only) — see below;
- `cadenceTarget`, `cadencePeriod` (`week` or `month`, defaults to `week`), and an
  optional `principleKey` binding (recurring only);
- `progressLog`: a `{ periodKey: amount }` map shared by cumulative and recurring
  goals — `YYYY-MM` keys for cumulative and month-cadence recurring goals, Sunday
  week-start `YYYY-MM-DD` keys for week-cadence recurring goals;
- `milestones`: an ordered checklist (`id`, `title`, `completedAt`, `sortOrder`)
  available to **any** measurement type — a binary "get a new job" goal keeps binary
  measurement and carries `CV ready → applications → interviews → offer` as
  milestones rather than becoming a fifth type;
- monthly evaluations keyed by `YYYY-MM`;
- created/updated timestamps.

**`sourceId`/`manualCurrentValue` scoping** — `sourceId` only drives **numeric** and
**cumulative** goals; the source selector is hidden in the UI for binary and recurring
goals, and any legacy value is ignored for those types. `manualCurrentValue` is only
read by **numeric** goals; for cumulative goals the progress log supersedes it.

Every goal created before these fields existed backfills to `measurementType:
"numeric"` with `startingValue: null`, which reproduces the pre-existing
`currentValue / targetValue` math exactly (see Progress below).

**Switching measurement type clears the other types' fields.** Changing the
measurement-type select on `/objectifs-annuels` runs
`resetAnnualGoalMeasurementFields` (`src/domain/annual-goals.ts`), which nulls out the
fields that belong only to the type being left (e.g. switching a numeric goal to
binary clears `sourceId`, `startingValue`, `direction`, `manualCurrentValue`,
`targetValue`, and `unit`) so stale cross-type data cannot linger invisibly, resurface
if the user switches back, or leak into the AI goal-pacing payload. `title`,
`dimension`, `description`, `status`, `deadline`, and `milestones` are cross-cutting
and are never touched by this reset. `progressLog` is cleared when switching to
`binary` or `numeric` (neither type reads it); cumulative and recurring intentionally
keep it as-is when switching between each other, since stale entries are simply
ignored by the other type's key format.

Each goal card buffers field edits in local `draft` state until "Enregistrer" is
clicked (see `AnnualGoalFields`/`AnnualGoalCard` in `AnnualGoalsPage.tsx`). Milestone
and cumulative/recurring log actions on the same card build their patch off that same
`draft` — not the (possibly stale) saved goal — so checking off a milestone or logging
a period never silently discards an unsaved field edit in progress on the card.

Deleting a goal is a hard delete in the current local database. The goals list on
`/objectifs-annuels` defaults to showing only `active` goals, with a toggle to show
every status.

### Progress

Progress math is per measurement type (`computeAnnualGoalMeasurement`,
`src/domain/annual-goal-measurement.ts`):

**Binary** — `currentValue`/`progressRatio` are `1` when `status === "achieved"`,
else `0`. Milestone completion is reported separately as `milestoneProgressRatio` and
is never folded into `progressRatio`: a binary goal is not "60% done" because 3 of 5
milestones are ticked.

**Numeric** —

```text
startingValue set and startingValue !== targetValue:
  progressRatio = (currentValue - startingValue) / (targetValue - startingValue)
  floored at 0, uncapped above 1

startingValue null (or startingValue === targetValue), direction "increase" (default):
  progressRatio = currentValue / targetValue      # byte-identical to the legacy formula
startingValue null (or startingValue === targetValue), direction "decrease":
  progressRatio = targetValue / currentValue      # e.g. a screen-time goal reads correctly
```

`direction` is explicit when set; otherwise it is inferred as `decrease` when
`targetValue < startingValue`, else `increase`. The ratio is `null` when the target or
current value is absent, or non-positive where required by the formula above.

The no-baseline `decrease` fallback (`targetValue / currentValue`) is undefined at
`targetValue === 0` (a "reduce X to 0" goal, e.g. "0 cigarettes/day", with no
`startingValue` set). That case is handled explicitly instead: `progressRatio` is `1`
once `currentValue <= 0` (goal achieved), else `null` (no honest percentage can be
stated without a baseline to interpolate from) — never `0`, which would misreport an
in-progress goal as having made no progress at all.

**Cumulative** — `currentValue` is the source's value when `sourceId` is set, else the
sum of `progressLog` entries whose month key falls in the selected year.
`progressRatio = currentValue / targetValue`. The 12-month `monthlyProgress` row is a
**running total** (month *N* = sum of increments through month *N*), including for
source-backed goals whose registry source normally reports each month independently
(e.g. `daily_pomodoris_sum`). This is the first time manual (no-`sourceId`) goals
populate the 12-month row at all.

**Recurring** — never "finished"; the goal is measured by adherence to a cadence
(e.g. "≥3×/week") rather than a target total:

- Period keys are enumerated for the whole year: all Sunday week-starts overlapping
  the year for `cadencePeriod: "week"`, or the 12 month keys for `"month"`.
- Per-period count is `progressLog[periodKey]` when present; else, when
  `principleKey` is set, the number of `true` days for that principle inside the
  period; else the period is "not logged".
- A period is *met* when its count is `>= cadenceTarget` (a `null` or non-positive
  `cadenceTarget` means no period can ever be met).
- `periodsElapsed` counts periods whose end date is on or before the reference date,
  **excluding** the in-progress current period. `adherenceRatio = periodsMet /
  periodsElapsed` (`null` when nothing has elapsed yet); `progressRatio =
  adherenceRatio`. This denominator is "elapsed periods", the recurring analogue of
  `computePrincipleRate`'s "all saved entries" denominator below — a missed week counts
  against you, unlike the answered-only denominator used by `rate28d` in
  [`src/domain/insights/streaks.ts`](../src/domain/insights/streaks.ts).
- `currentStreak` counts consecutive met periods back from the most recent elapsed
  period, **skipping a trailing unlogged period** rather than breaking on it — this
  mirrors `StreakFinding.currentStreak`'s "not logged yet" ≠ "failed" semantics. A
  period that was explicitly logged as a miss still breaks the streak, even if it is
  trailing.
- The in-progress period is exposed separately as `currentPeriodKey`/
  `currentPeriodCount` (e.g. for a "This week: 3/3" readout) and is not counted in
  `periodsElapsed`.

### Automatic source registry

| Source ID | Current/month calculation |
|---|---|
| `weekly_sleep_average` | Mean weekly sleep average |
| `weekly_respect_trc` | Mean weekly TRC percentage |
| `weekly_weekly_score` | Mean weekly score converted to percent |
| `weekly_discipline` | Mean weekly discipline percent |
| `weekly_tasks_completion_rate` | Mean weekly task completion percent |
| `daily_depense_calorique_avg` | Mean daily calorie expenditure |
| `daily_qualite_sommeil_avg` | Mean daily sleep quality |
| `daily_temps_ecran_avg` | Mean daily phone screen minutes |
| `daily_pomodoris_sum` | Sum of daily Pomodoris |
| `daily_pomodoris_avg` | Mean daily Pomodoris |
| `daily_respect_trc_rate` | TRC true entries / saved entries |
| `daily_respect_reveil_rate` | Wake-time true entries / saved entries |
| `daily_priere_du_matin_rate` | Morning-prayer true entries / saved entries |
| `daily_priere_du_soir_rate` | Evening-prayer true entries / saved entries |
| `daily_objectifs_atteints_rate` | Goals-achieved true entries / saved entries |

Daily principle rates use all saved entries in the selected period as the
denominator; `false` and `null` are both not respected.

Weekly sources include a week in a month when its start or end is in that month, or
when it spans the first day. Annual snapshots include weeks whose start or end is in
the selected year.

### Monthly evaluations

Evaluations are qualitative/manual and separate from the automatic progress series:

- numeric score (unbounded by the domain model);
- trend: up, steady, or down;
- notes;
- blockers.

Changing an evaluation rewrites the goal's `evaluations_json` and update timestamp.

## Cross-domain dependencies

```text
Daily metrics/principles
  -> weekly summaries
       -> monthly weekly overview
       -> weekly-sourced annual goals
  -> monthly daily overview
  -> daily-sourced annual goals

Weekly/monthly review notes
  -> ritual history only
  -> do not change numeric goal progress
```

When modifying a formula, update pure domain tests and document whether historical
views will recalculate differently. There are no stored summary snapshots to
preserve the old formula.

## Related documentation

- [Daily routines](daily-routines.md)
- [GTD](gtd.md)
- [Storage and backups](storage-and-backups.md)
