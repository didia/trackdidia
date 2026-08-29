# Reviews and Annual Goals

TrackDidia turns daily evidence into three higher-level loops:

- Sunday-to-Saturday weekly reviews;
- calendar-month reviews;
- annual goal snapshots with monthly evaluations.

Review records store ritual notes/checklists and open/closed state. Numeric summaries
are computed on demand and are not persisted.

## Weekly review (`/semaine`)

### Calendar model

The business week always begins Sunday and ends Saturday. Any selected date is
normalized to its Sunday with `getWeekStartSunday()`.

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

Notes and checklist changes persist immediately. Closing does not require all
sections to be checked.

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

1. **RescueTime Goals** (read-only): enabled goals from the RescueTime API feed optional RescueTime score axes on the weekly overview. Manage goals in RescueTime; configure the API key under **Parametres → RescueTime**.
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
under **Parametres → RescueTime** (stored in SQLite, same as OpenRouter). Time data
comes from the Analytic Data API and labeled project times (projects and clients).
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

Accepting a section draft **prefills** the textarea only. Results are cached in
`ai_messages` keyed by `(surface, monthKey, input_hash)`.

### Annual goal pacing

Opening `/objectifs-annuels` triggers the S4 `goal_pacing` surface for the selected year.
The panel is **informational only** — it compares each goal's progress ratio to the
expected year-to-date fraction (from `computeYearProgressFraction`) and surfaces gap,
required weekly behaviour, risk level, and recommendations. No accept-step.

Results are cached in `ai_messages` keyed by `(surface, year, input_hash)`.

## Monthly review (`/mois`)

### Calendar model

Monthly reviews use a `YYYY-MM` key and the calendar month's first/last day.
The Today screen prompts on the first Saturday of a month and the Monthly screen
initially selects the previous month on that day; otherwise it selects the current
month.

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

The screen also loads annual goal snapshots for the selected year and displays the
selected month's point for each goal.

## Annual goals (`/objectifs-annuels`)

### Goal model

An annual goal contains:

- title and description;
- dimension: physical, spiritual, social, intellectual, or global;
- optional numeric target and unit;
- optional automatic source ID;
- optional manual current value;
- monthly evaluations keyed by `YYYY-MM`;
- created/updated timestamps.

Deleting a goal is a hard delete in the current local database.

### Progress

For an automatic goal:

```text
currentValue = source calculation over selected year
progressRatio = currentValue / targetValue
```

The ratio is `null` when the target is absent/non-positive or current value is
missing. It is not capped at 100%.

For a manual goal, `manualCurrentValue` supplies the current value. Manual goals do
not automatically populate the 12 monthly progress points.

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
