# Architecture

See also: [changelog](logs/architecture.md).

TrackDidia is a single-user, local-first desktop application for running a personal
daily operating system. Its major loops are:

1. Capture and execute work through GTD and Pomodoro.
2. Open and close each day with an intention, metrics, and principles.
3. Review the week and month.
4. Connect daily/weekly evidence to annual goals.

There is no server, authentication layer, or cloud database in the current product.
The only optional network call is the OpenRouter coach.

## Technology stack

| Layer | Technology |
|---|---|
| UI | React 18 + TypeScript 5.6 (strict) |
| Routing | React Router 6 |
| Web tooling | Vite 5 |
| Desktop host | Tauri 2 + Rust |
| Durable storage | SQLite through a custom single-connection sqlx pool (`src-tauri/src/db.rs`), exposed to the frontend as the `db_connect`/`db_execute`/`db_select` Tauri commands |
| Native notifications | `@tauri-apps/plugin-notification` |
| Tests | Vitest 2 + Testing Library + jsdom |
| Copy | i18next + react-i18next, French-only, one JSON namespace per file under `src/locales/fr/` |
| Optional AI | OpenRouter chat-completions-compatible endpoint |

Styling is a single custom stylesheet in `src/styles.css`; there is no component
framework or external state-management library.

## Repository layout

```text
/
  AGENTS.md
  docs/                         canonical documentation
  README.md                     short developer entry point
  PRD.md                        roadmap/history, not current truth
  quotes.json                   local quote-of-the-day catalog
  verses.json                   curated Bible verse catalog ("Pasteur IA")
  src/
    App.tsx                     route table
    main.tsx                    React entry point
    i18n/                       i18next init and typed namespaces
    locales/fr/                 French UI copy (one JSON file per namespace)
    pages/                      route-level screens
    components/                 reusable UI and task cards
    app/                        provider and orchestration hooks
    domain/                     types and pure business calculations
    lib/
      ai/                       coach input/service/OpenRouter provider
      gtd/                      task filtering, lifecycle events, import
      pastor/                   verse catalog, history, and local pick for "Pasteur IA"
      pomodoro/                 timer state and sound/notification support
      recurring/                recurrence rules and previews
      storage/                  repository API, memory and SQLite adapters
  src-tauri/
    src/main.rs                 native app and storage-path command
    src/db.rs                   single-connection sqlx pool and db_connect/db_execute/db_select commands
    capabilities/default.json   core/notification permissions
    tauri.conf.json             window/build/bundle configuration
```

## Runtime composition

`src/main.tsx` initializes i18next (French-only), installs debug instrumentation,
and mounts `App`. All user-facing copy lives in `src/locales/fr/*.json`. React
screens use `useTranslation`; non-React user-facing strings use `t()` from
`src/i18n`. Runtime language stays French; `AppSettings.language` remains `"fr"`.
There is no language switcher.

`App` wraps all routes in `AppProvider`. The provider constructs the runtime
services shared by the pages:

- an `AppRepository`,
- `AppSettings`,
- `CoachPulseService`,
- the global Pomodoro controller,
- debug state,
- the browser-preview flag.

The application uses React hooks and this context instead of a global store.

`AppShell` owns the persistent navigation, renders a deterministic quote of the day
from `quotes.json` (local-date hash with a built-in fallback), and mounts the
floating Pomodoro timer while a session is running or paused, or while the current
cycle is still idle after a recent completion. The overlay hides on `/pomodoro`,
where the full timer controls already live, and after the usual 25-minute idle
cycle reset.

```text
React page
  -> orchestration hook / AppContext
  -> AppRepository
       -> TauriSqliteRepository (desktop)
       -> MemoryRepository (browser preview or startup fallback)
  -> pure domain/engine functions
```

## Route catalog

All routes render under `AppShell`, which supplies the sidebar, daily quote, and
floating Pomodoro timer. The sidebar's nav list is normally static, but a nav
entry can carry a `flag` naming an `AppSettings` boolean; `AppShell` reads
`settings` from `useAppContext()` and filters that entry out when the flag is
false. `finances` (`/finances`) is the first such conditional entry, gated on
`settings.financeEnabled`.

| Route | Screen | Purpose |
|---|---|---|
| `/` | Today | Daily status, coach messages, Pomodoro/GTD summaries, ritual reminders |
| `/routine-matin` | Morning routine | Intention, morning principles, initial GTD load |
| `/fermeture-soir` | Evening closure | Metrics, all principles, reflection, tomorrow focus |
| `/semaine` | Weekly review | Sunday-Saturday summary and eight-part ritual |
| `/mi-semaine` | Mid-week check | Pro-rated pace of the current week, what to catch up, saved decisions |
| `/mois` | Monthly review | Monthly aggregates, linked weeks/goals, ten-part ritual |
| `/objectifs-annuels` | Annual goals | Targets, data sources, monthly trend/evaluation |
| `/historique` | Daily history | Create/edit/reopen/close any calendar day |
| `/journal` | Journal | Read-only timeline of daily, weekly, and monthly notes |
| `/inbox` | GTD Inbox | Capture and clarify |
| `/next-actions` | Next Actions | Executable work, context/deadline filters |
| `/projects` | Projects | Multi-step outcomes and status management |
| `/pomodoro` | Pomodoro | Focus/break timer, task switching, daily history |
| `/recurrences` | Recurrences | Create, filter, pause/resume/cancel recurring series |
| `/email-triage` | Email triage | Account cards, review queue, disabled-by-default settings |
| `/finances` | Finance overview | Net worth, this month's cash flow, account list with derived balances, 6-month spending trend, top categories, upcoming recurring bills; always registered, redirects to `/` while `financeEnabled` is false |
| `/finances/transactions` | Finance transactions | Paged, filtered transaction list with inline category edit, splits, transfer/exclude toggles, bulk toolbar |
| `/finances/budget` | Finance budget | Month selector, Ready to Assign, envelope grid with inline assignment, overspend policy, quick-assign actions, "Non budgété" band, close/reopen month |
| `/finances/reports` | Finance reports | Category/merchant/person spend with transaction-level drill-down, income-vs-expense trend, month-over-month comparison |
| `/finances/import` | Finance import | CSV file import: decode, profile mapping, preview, account binding, result panel, batch history with undo |
| `/finances/accounts` | Finance accounts | Household members and accounts CRUD, opening/manual balances, reconciliation banner |
| `/finances/review` | Finance review | Pending category-suggestion queue grouped by merchant: accept/correct/dismiss, bulk accept-above-threshold, "Réappliquer les règles" |
| `/finances/rules` | Finance rules | Classification rule CRUD, enable/disable, apply to existing transactions |
| `/references` | References | Non-actionable material |
| `/scheduled` | Scheduled | Day/week planning, deadlines, recurrence previews |
| `/waiting-for` | Waiting For | Work awaiting external action |
| `/someday-maybe` | Someday / Maybe | Deferred possibilities |
| `/parametres` | Settings | AI, debug, relationship draws, backup, GTD import |
| `/waiting-someday` | Redirect | Legacy alias redirected to `/waiting-for` |

`/finances/*` is always registered in `App.tsx` (a `FinanceRoutes` element reads
`settings.financeEnabled` and renders `<Navigate to="/" replace />` instead of
its child routes while the flag is off), so a stale bookmark or deep link never
404s — it just lands on Today. Every finance screen that exists ships a tab in
the shared `FinanceTabs` bar on every `/finances*` page. See
[`docs/finance.md`](finance.md) for what each finance screen does.

See the product pages linked from [`index.md`](index.md) for behavior inside each
screen.

## Boot sequence

`AppProvider` is a thin composition layer. Startup lives in focused modules under
`src/app/`:

| Module | Responsibility |
|---|---|
| `bootstrap.ts` | `bootstrapApplication(repository, { onStage })` (pure startup data sequence) and `runOnceWithSettingsMarker` (idempotent one-time steps) |
| `use-bootstrap.ts` | `useBootstrap()`: `createRepository`, runs `bootstrapApplication`, owns the eight-second timeout and the in-memory fallback |
| `use-pulse-scheduler.ts` | `usePulseScheduler(...)`: startup + five-minute coach pulse evaluation and app-open interval tracking |
| `use-auto-backup-scheduler.ts` | `useAutoBackupScheduler(...)`: startup + hourly automatic-backup check |
| `use-local-day-reconciliation.ts` | Local-day boundary reconciliation and `calendarDay` |

`useBootstrap()` starts with a loading splash and runs:

1. Detect Tauri with `window.__TAURI_INTERNALS__`.
2. In desktop mode, call the native `resolve_storage_paths` command.
3. Create and initialize the SQLite repository; otherwise initialize memory storage.
   SQLite is therefore ready before any settings or GTD read.
4. `bootstrapApplication(repository, { onStage })` then runs, in order:
   1. Load settings.
   2. One-time steps through `runOnceWithSettingsMarker(repository, settings,
      markerKey, work)`. Each is skipped when its settings marker is set; otherwise
      the work runs first and the marker is stamped afterwards (never overwriting an
      existing value), so a failed step is retried on the next boot:
      - legacy `aiMaxTokens` upgrade (`aiMaxTokensUpgradeDoneAt`),
      - move the `Reading` context to References (`gtdReferencesMigrationDoneAt`),
      - move dated work to Scheduled (`gtdScheduledNormalizationDoneAt`).
   3. Log GTD overview counts from the repository.
   4. Call `repository.reconcileDay(today)`: generate due recurring tasks for the
      current local date, promote active Scheduled tasks whose local `scheduledFor`
      date is today or earlier to Next Actions, apply weekly carryover for the most
      recent Sunday (back-filling a missed one), and complete expired Pomodoro sessions.
   5. Generate enabled relationship activity tasks for the current local date.
   6. If `settings.financeEnabled` is true and `settings.financeCategoriesSeededAt`
      is empty, seed the default finance category taxonomy
      (`seedFinanceDefaultCategories()`, idempotent `INSERT OR IGNORE`) and set the
      marker through the same helper. This step is wrapped in its own `try`/`catch`
      — a failure is logged and swallowed, never thrown, so it cannot turn into a
      new way to hit the eight-second timeout below. The same seed-once-on-enable
      also runs from `SettingsPage` when a user flips `financeEnabled` from false
      to true there, so whichever path flips the flag first does the seeding and
      the other is a no-op.
5. Expose the repository and settings to the UI.
6. After a successful bootstrap (not browser preview and not the startup
   fallback), start the email triage coordinator. It still no-ops while the
   feature flag is off, and it probes the OS vault only after that flag is on.
   On desktop, connected Gmail and Microsoft Graph accounts use the live adapter
   when vault credentials exist; Yahoo uses live IMAP on desktop (mock in browser preview).

The startup operation has an eight-second timeout (`BOOTSTRAP_TIMEOUT_MS`). An
exception from any step or the timeout activates a new `MemoryRepository`, shows a
warning banner (the timeout message names the stage in progress), and keeps the UI
usable. Data entered in that fallback is lost when the application reloads. The email
triage coordinator does not start in that fallback path.

Once a repository is available, `AppProvider` starts two schedulers. Both read
changing values (current settings, the running Pomodoro session) through refs, so
their effects restart only when the repository changes — not on every settings write
or Pomodoro tick — and both queue their startup check on a shared serial queue:

- `usePulseScheduler` evaluates the coach pulse at startup and every five minutes,
  skipping a run while a previous one is still in flight.
- `useAutoBackupScheduler` checks at startup and hourly whether an automatic backup
  is due. A single in-flight guard prevents concurrent backup checks. Because the
  settings are read at check time, enabling automatic backup or changing its
  interval takes effect at the next hourly check rather than immediately.

The context value is memoized (`useMemo`) and `updateSettings`/`setDebugEnabled` are
`useCallback`s, so consumers re-render only when a real input changes.

After bootstrap, `AppProvider` keeps `calendarDay` (the current local `YYYY-MM-DD`)
in context. A timeout until the next local midnight, plus window `focus` and
`visibilitychange` when the document becomes visible, call `reconcileDay(today)`
once per repository and day, then republish the new date so already-mounted GTD
and Pomodoro consumers reload without navigation. On the same pass, when
`settings.financeEnabled` is true, `useLocalDayReconciliation` also calls
`snapshotFinanceAccountBalances(today)` so the net-worth history gets one point
per day the app was open; this call is independently try/caught (a failure is
logged as a row count only, never amounts) and never blocks recurrence/promotion
or the eight-second startup timeout above.

### Reads are side-effect free; reconciliation is explicit

Repository reads never write: `listTasks`, `computeDailyTaskStats`,
`getDailyTaskBreakdown`, `computeDailyPomodoroStats`, `getDailyEntry`, and
`listDailyEntries*` no longer generate recurrences, promote Scheduled tasks, write
Sunday carryover, or complete expired Pomodoro sessions. Those time-driven writes
live in `reconcileDay(date, now?)` (shared `reconcileGtdDay` in
`src/lib/gtd/reconcile.ts`, exposed on both repositories). Only time owners call it:

- `AppProvider` bootstrap and `useLocalDayReconciliation` (day boundary);
- explicit refresh after a user write that can make work due today: every
  `useGtdWorkspace` mutation reload, recurrence template save/resume on
  `/recurrences`, and an accepted AI proposal that creates or schedules a task.

The initial `useGtdWorkspace` load, History, Weekly, AI snapshots, and the Pomodoro
refresh (which only settles expired sessions) read without reconciling.

## Repository boundary

`AppRepository` is the persistence contract. It covers daily entries, reviews,
annual goals, settings/backups, GTD entities, recurrence templates, task-derived
statistics, and Pomodoro sessions. Its `emailTriage` property exposes the separate
`EmailTriageStore` contract for the email triage foundation tables. Both repository
implementations construct their matching email store with the same task callbacks.

The two implementations intentionally share pure functions:

- state creation and transitions in `src/domain/`,
- GTD filtering/events in `src/lib/gtd/`,
- recurrence calculation in `src/lib/recurring/`,
- Pomodoro state calculation in `src/lib/pomodoro/`.

This makes browser preview behavior close to desktop behavior, while keeping only
the desktop adapter responsible for SQL and native paths.

## Main data flows

### Daily entry decoration

Persisted daily rows contain explicit metrics and principles. On read, repositories
decorate an entry with suggested values computed from:

- GTD task/event history (`tachesDebut`, `tachesAjoutes`, `tachesRealises`,
  `tachesFin`);
- completed focus sessions (`pomodoris`).

`resolveMetricValue()` returns an explicit user value first, then its suggestion.

Decoration is the repository's job and happens once, purely: `getDailyEntry` and all
three `listDailyEntries*` methods (including `listDailyEntriesInRange`) load tasks,
events, and Pomodoro sessions once and derive suggestions with
`decorateDailyEntries` (`src/lib/storage/decorate-entries.ts`). `saveDailyEntry`
stores the entry as given. Callers must not re-apply `applyDailyTaskStats` /
`applyDailyPomodoroStats` to a repository-returned entry; they only apply them to a
synthesized empty entry (a day with no row) or to a local, unsaved edit.

### Reviews and goals

Weekly summaries are derived from seven decorated daily entries. Monthly summaries
combine the month's existing daily entries with summaries for every overlapping
Sunday-start week. Annual goal snapshots reuse daily data and weekly summaries.

### Task lifecycle

Task writes generate append-only lifecycle events. Those events drive daily added
and completed counts and Sunday carryover. Recurring task generation and Google
import ultimately produce the same `Task` model used by manual work.

### Pomodoro

The global controller polls the countdown locally each second, persists state
transitions through the repository, auto-completes expired sessions, and refreshes
the daily session/task summaries. A focus session can contain several segments when
the selected task changes.

## Native boundary

The Rust host is intentionally small:

- initialize the notification and dialog plugins;
- resolve/create the application data directory;
- choose development versus production database filenames;
- expose `resolve_storage_paths`, `ensure_backup_dir`, and `prune_backups`.

SQLite queries and migrations remain in TypeScript, sent to a single-connection sqlx
pool through the app's own `db_connect`/`db_execute`/`db_select` commands (`src/db.rs`)
rather than a capability-gated SQL plugin. The Tauri capability grants the main window
default core access, notifications, and dialogs.

## Current limitations

- No cloud sync, accounts, or shared data.
- No background recurrence generation while the application is closed.
- Browser preview has no persistence or backups.
- Backup creation exists, but restore is manual and has no UI.
- The AI key is stored in the local SQLite settings JSON rather than an OS keychain.
- Google Tasks import helpers still accept an in-memory payload for tests and tooling,
  but the app no longer ships or requires a bundled `Tasks.json` export.

## Related documentation

- [Storage and backups](storage-and-backups.md)
- [Daily routines](daily-routines.md)
- [Reviews and goals](reviews-and-goals.md)
- [GTD](gtd.md)
- [Recurrences and Pomodoro](recurrences-and-pomodoro.md)
- [AI, settings, and privacy](ai-settings-and-privacy.md)
- [Email triage](email-triage.md)
