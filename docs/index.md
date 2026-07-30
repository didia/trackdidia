# TrackDidia Documentation Index

Canonical knowledge base for contributors and coding agents. Start with
[`AGENTS.md`](../AGENTS.md), then use this page to find the detailed subsystem.

Chronological documentation activity is recorded in [`log.md`](log.md).

## Platform

| Page | Scope |
|---|---|
| [architecture.md](architecture.md) | Product shape, stack, route catalog, boot sequence, repository abstraction, data flows |
| [storage-and-backups.md](storage-and-backups.md) | SQLite schema and migrations, app-data paths, settings, backups, recovery constraints |
| [conventions.md](conventions.md) | File placement, implementation contracts, dates, testing, verification workflow |
| [desktop-builds.md](desktop-builds.md) | Local web/Tauri development, native permissions, production builds, release safety |

## Product domains

| Page | Scope |
|---|---|
| [daily-routines.md](daily-routines.md) | Today dashboard, morning/evening rituals, metrics, principles, history |
| [reviews-and-goals.md](reviews-and-goals.md) | Sunday-to-Saturday summaries, monthly ritual, annual goal sources and evaluations |
| [gtd.md](gtd.md) | Buckets, contexts, projects, task lifecycle events, Google Tasks import, daily counts |
| [recurrences-and-pomodoro.md](recurrences-and-pomodoro.md) | Recurrence templates/generation/previews and Pomodoro sessions/segments/notifications |
| [ai-settings-and-privacy.md](ai-settings-and-privacy.md) | Local/AI coaching, OpenRouter request data, relationship draws, debug and settings |

## Source map

| Concern | Primary source |
|---|---|
| Routes | `src/App.tsx` |
| Global startup and settings | `src/app/app-context.tsx` |
| Domain models | `src/domain/types.ts` |
| Daily formulas | `src/domain/daily-entry.ts` |
| Weekly formulas | `src/domain/weekly-review.ts` |
| Monthly formulas | `src/domain/monthly-review.ts` |
| Annual goal sources | `src/domain/annual-goals.ts` |
| Repository API | `src/lib/storage/repository.ts` |
| SQLite schema/migrations | `src/lib/storage/tauri-sqlite-repository.ts` |
| Browser preview storage | `src/lib/storage/memory-repository.ts` |
| Native data paths | `src-tauri/src/main.rs` |
| Desktop configuration | `src-tauri/tauri.conf.json` |

## Reading paths

For a feature change:

```text
AGENTS.md
  -> relevant product page
  -> architecture/conventions
  -> implementation and tests
```

For a data or release change:

```text
AGENTS.md
  -> storage-and-backups
  -> desktop-builds
  -> SQLite migrations / Tauri configuration
```

## Documentation boundaries

- `docs/` describes the current application.
- [`PRD.md`](../PRD.md) is a historical roadmap and may contain unshipped ideas.
- [`README.md`](../README.md) is the short entry point, not the complete technical
  reference.
- `Tasks.json` is a gitignored local Google Tasks export bundled by the current
  source tree; it may contain personal data and must not be copied into docs.
