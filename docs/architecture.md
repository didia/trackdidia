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
  Tasks.json                    local, gitignored Google Tasks export
  quotes.json                   local quote-of-the-day catalog
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
- `AiCoachService`,
- the global Pomodoro controller,
- debug state,
- the browser-preview flag.

The application uses React hooks and this context instead of a global store.

`AppShell` owns the persistent navigation, renders a deterministic quote of the day
from `quotes.json` (local-date hash with a built-in fallback), and mounts the
floating Pomodoro timer whenever a live session exists.

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
floating Pomodoro timer.

| Route | Screen | Purpose |
|---|---|---|
| `/` | Today | Daily status, coach messages, Pomodoro/GTD summaries, ritual reminders |
| `/routine-matin` | Morning routine | Intention, morning principles, initial GTD load |
| `/fermeture-soir` | Evening closure | Metrics, all principles, reflection, tomorrow focus |
| `/semaine` | Weekly review | Sunday-Saturday summary and eight-part ritual |
| `/mois` | Monthly review | Monthly aggregates, linked weeks/goals, ten-part ritual |
| `/objectifs-annuels` | Annual goals | Targets, data sources, monthly trend/evaluation |
| `/historique` | Daily history | Create/edit/reopen/close any calendar day |
| `/inbox` | GTD Inbox | Capture and clarify |
| `/next-actions` | Next Actions | Executable work, context/deadline filters |
| `/projects` | Projects | Multi-step outcomes and status management |
| `/pomodoro` | Pomodoro | Focus/break timer, task switching, daily history |
| `/recurrences` | Recurrences | Create, filter, pause/resume/cancel recurring series |
| `/references` | References | Non-actionable material |
| `/scheduled` | Scheduled | Day/week planning, deadlines, recurrence previews |
| `/waiting-for` | Waiting For | Work awaiting external action |
| `/someday-maybe` | Someday / Maybe | Deferred possibilities |
| `/parametres` | Settings | AI, debug, relationship draws, backup, GTD import |
| `/waiting-someday` | Redirect | Legacy alias redirected to `/waiting-for` |

See the product pages linked from [`index.md`](index.md) for behavior inside each
screen.

## Boot sequence

`AppProvider` starts with a loading splash and runs this sequence:

1. Detect Tauri with `window.__TAURI_INTERNALS__`.
2. In desktop mode, call the native `resolve_storage_paths` command.
3. Create and initialize the SQLite repository; otherwise initialize memory storage.
4. Load settings.
5. Inspect GTD counts and import `Tasks.json` when no import marker exists or both
   task and project counts are zero.
6. Run one-time data normalizations tracked in settings:
   - move the `Reading` context to References,
   - move dated work to Scheduled,
   - collapse imported Google recurring task instances.
7. Generate due recurring tasks for the current local date.
8. Generate enabled relationship activity tasks for the current local date.
9. Expose the repository and settings to the UI.

The startup operation has an eight-second timeout. An exception or timeout activates
a new `MemoryRepository`, shows a warning banner, and keeps the UI usable. Data
entered in that fallback is lost when the application reloads.

## Repository boundary

`AppRepository` is the persistence contract. It covers daily entries, reviews,
annual goals, settings/backups, GTD entities, recurrence templates, task-derived
statistics, and Pomodoro sessions.

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
- `Tasks.json` is a build-time local import, not a live Google Tasks connection.

## Related documentation

- [Storage and backups](storage-and-backups.md)
- [Daily routines](daily-routines.md)
- [Reviews and goals](reviews-and-goals.md)
- [GTD](gtd.md)
- [Recurrences and Pomodoro](recurrences-and-pomodoro.md)
- [AI, settings, and privacy](ai-settings-and-privacy.md)
