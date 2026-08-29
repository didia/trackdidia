# Daily Routines

The daily entry is the bridge between personal reflection and automatically derived
work evidence. One row is identified by a local calendar date.

## Daily lifecycle

`DailyStatus` has three states:

```text
not_started -> morning_done -> closed
```

- Completing the morning sets `morning_done`.
- Closing the evening sets `closed`.
- Reopening a day sets `morning_done` when an intention exists, otherwise
  `not_started`.

The status is a workflow marker, not a validation gate: the code does not require
every metric, principle, or note before a transition.

## Today dashboard (`/`)

The Today screen is the daily control center. It:

- opens the morning and evening screens;
- shows completion, discipline, and task-completion summaries;
- displays local or AI morning/evening coaching;
- reminds the user about the weekly ritual on Sunday;
- reminds the user about the previous month's review on the first Saturday;
- summarizes completed focus sessions and focused time;
- lists tasks added/completed today from the event ledger;
- shows the GTD-derived start/added/completed/remaining counts;
- warns when the app is using temporary browser storage.

The daily entry shown here is decorated at load time with GTD and Pomodoro
suggestions.

## Morning routine (`/routine-matin`)

The morning screen captures:

- `morningIntention`;
- the morning and anytime principles;
- GTD workload values for tasks at start and tasks added.

The intention field saves after a 450 ms debounce and flushes immediately before the
"complete morning" navigation.

Morning/anytime principles:

| Key | UI label |
|---|---|
| `priereDuMatin` | Prière du matin |
| `oxytocineDuMatin` | Oxytocine du matin |
| `avoirLuMesPrincipes` | Avoir lu mes principes |
| `ecriture` | Écriture |
| `apprentissage` | Apprentissage |
| `managedSolitude` | Managed solitude |
| `respectDeVieCommeJesus` | Respect de vie comme Jésus |
| `respectReveil` | Respect réveil |

Principle values are tri-state: `true`, `false`, or `null` (not answered).

### Finalizing yesterday from the morning screen

The morning screen also renders a `PreviousDayReviewCard` above the intention
section. It targets strictly `addDays(getTodayDate(), -1)` (yesterday), not the
last day with data, and never changes yesterday's `DailyStatus`.

The card shows only what is still missing for yesterday:

- manual metrics where `resolveMetricValue` is `null` (`findMissingMetricKeys`);
  auto-suggested metrics (`tachesDebut/Fin/Ajoutes/Realises`, `pomodoris`) are
  never "missing" since they always resolve from `suggestedMetrics`;
- principles still `null` (`findUnansweredPrincipleKeys`); an explicit `false` is
  a real answer and is not re-asked;
- the night reflection, if empty.

The set of missing fields is frozen on first load of yesterday's entry, so a
field does not disappear mid-edit as soon as the user answers it. The card
reuses `useDailyEntry`, `MetricGrid`, `PrincipleChecklist`, and
`PersistedTextarea` (`debounceMs={0}`) exactly as the other daily screens do,
edited as a local draft like `HistoryPage`.

A single "Enregistrer hier" button saves everything at once:

- yesterday's entry is only saved (`useDailyEntry.save`) if at least one missing
  field actually changed, to avoid creating an empty `daily_entries` row for a
  day that was never opened;
- `AppSettings.previousDayReviewDoneDate` is always set to yesterday's date,
  even when nothing changed, so the card does not resurface for that day.

The card hides itself (renders nothing) when `previousDayReviewDoneDate` already
equals yesterday, while loading, or when nothing is missing (auto-hide). No
SQLite migration was needed for the new settings field: `app_settings` is a
JSON blob merged with `defaultAppSettings()` on read.

## Evening closure (`/fermeture-soir`)

The evening screen exposes:

- every daily metric;
- all fourteen principles;
- `nightReflection`;
- `tomorrowFocus`;
- the transition to `closed`.

The journal fields are debounced and flushed before closure.

Evening-specific principles include daily retro, quality time with children, evening
prayer, attention to spouse, TRC, and goals achieved. Anytime and morning principles
remain editable so the full day can be corrected before closure.

## Metrics

| Key | Label | Unit / bounds |
|---|---|---|
| `course` | Course | minutes, min 0 |
| `marche` | Marche | steps, min 0 |
| `depenseCalorique` | Dépense calorique | kcal, min 0 |
| `pushups` | Pushups | repetitions, min 0 |
| `qualiteSommeil` | Qualité du sommeil | 0-100 |
| `tempsEcranTelephone` | Temps d'écran téléphone | minutes, min 0 |
| `pomodoris` | Pomodoris | sessions, min 0 |
| `tachesDebut` | Tâches début | count, min 0 |
| `tachesFin` | Tâches fin | count, min 0 |
| `tachesAjoutes` | Tâches ajoutées | count, min 0 |
| `tachesRealises` | Tâches réalisées | count, min 0 |

The last four metrics and `pomodoris` can be suggested automatically. Explicit
values are stored in `metrics`; automatic values are attached as
`suggestedMetrics` during reads and are not stored in `daily_entries`.

Resolution rule:

```text
explicit metric ?? suggested metric ?? null
```

This lets the user override an engine-derived number without losing the source
suggestion behavior for other days.

## All principles

There are fourteen equally weighted principles:

1. Prière du matin
2. Oxytocine du matin
3. Avoir lu mes principes
4. Écriture
5. Apprentissage
6. Managed solitude
7. Respect de vie comme Jésus
8. Rétro journalier
9. Temps de qualité avec enfants
10. Prière du soir
11. Attention à mon épouse
12. Respect TRC
13. Respect réveil
14. Objectifs atteints

## Daily calculations

### Discipline

```text
true principles / 14
```

`false` and unanswered principles both contribute zero to the numerator.

### Entry completion

Completion is the fraction of answered/filled fields across:

- 11 explicit metrics;
- 14 answered principles (`true` or `false`);
- 3 non-empty notes.

There are 28 fields in total. A suggested metric does not count as an explicitly
completed metric because the calculation reads `entry.metrics`.

### Task completion indicator

The daily dashboard's task-completion calculation is a pacing indicator:

```text
totalAtRisk = tasksAtStart + tasksAdded
expectedPerDay = totalAtRisk / remainingDaysInSundayToSaturdayWeek
taskCompletion = tasksCompleted / expectedPerDay
```

It may exceed 100%. When no tasks are at risk, it is zero.

See [GTD](gtd.md) for how the four source counts are computed.

## History (`/historique`)

History lists up to 120 saved entries. The user can:

- select an existing day;
- create/load an unsaved date;
- edit all three notes, metrics, and principles;
- save changes;
- reopen a day;
- mark a day closed.

Unlike the morning/evening flows, history textareas update local draft state
immediately and persist when the explicit save action is used.

## Creation and persistence

Loading an absent date creates an in-memory empty entry for display. The row becomes
durable only after a save/transition. Every saved entry gets an updated ISO
timestamp.

When loading today's entry, the hook also:

- asks the repository to generate relationship tasks;
- computes task statistics;
- computes completed focus sessions;
- decorates the entry with those suggestions.

## Consumers

Daily entries feed:

- Today summaries and coach prompts;
- weekly day cards and aggregates;
- monthly aggregates;
- annual goal source calculations.

Changes to metric/principle keys must therefore update definitions, empty values,
row serialization compatibility, tests, and every downstream formula that uses the
key.

## Related documentation

- [Reviews and goals](reviews-and-goals.md)
- [GTD](gtd.md)
- [Recurrences and Pomodoro](recurrences-and-pomodoro.md)
- [AI, settings, and privacy](ai-settings-and-privacy.md)
