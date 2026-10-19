# Spec: GTD + Pomodoro work coach (deterministic health engine, Claude through the LLM bridge)

**Status:** draft, awaiting review (not approved, nothing implemented).
**Scope:** add coaching for GTD and Pomodoro that works on an employer-managed work laptop. It has
three layers, cheapest and safest first:

1. a deterministic, no-AI **GTD health** engine shown in the app on every laptop;
2. new **read-only MCP tools** on the existing LLM bridge, so the user's own Claude client can coach
   from that data;
3. shipped **MCP prompts** that turn Claude into the GTD/Pomodoro coach (daily plan, weekly GTD
   review, stalled projects, inbox clarification).

There is no OpenRouter call, no new API key and no new network path. Work data reaches a model only
through the Claude client the user connects to the bridge.

## Context

The user will run TrackDidia on an employer-managed work laptop. The draft multi-laptop sync spec
(`specs/todo/multi-laptop-sync.md`, still under review in
[didia/trackdidia#240](https://github.com/didia/trackdidia/pull/240) on branch
`claude/trackdidia-multi-laptop-sync-fcd2ee`; see its "Work profile" section) gives that laptop a
`work` profile. That profile holds the **entire GTD list and Pomodoro history** with no
work/personal split, and **no** daily routines, reviews, journals, goals, AI coach data or finance.
On a `work` device the built-in OpenRouter coach is off and its settings are hidden, so there is no
coaching on that laptop today.

What exists already, verified against the code:

| Piece | Where | What it gives this spec |
|---|---|---|
| LLM bridge (local MCP over loopback HTTP) | [`src-tauri/src/llm_bridge.rs`](../../src-tauri/src/llm_bridge.rs), [`src/app/use-llm-bridge.ts`](../../src/app/use-llm-bridge.ts), [`src/lib/llm-bridge/handler.ts`](../../src/lib/llm-bridge/handler.ts), [`src/lib/llm-bridge/tools.ts`](../../src/lib/llm-bridge/tools.ts) | Authenticated transport to Claude Desktop / Claude Code. Rust answers `initialize`/`ping` and forwards only `tools/list` and `tools/call` to `handleBridgeRequest`. It advertises `capabilities.tools` only, and `SERVER_INSTRUCTIONS` is a Rust constant. |
| Bridge tools today | `LLM_BRIDGE_TOOLS` | `list_projects`, `list_contexts`, `list_tasks` (active only, ≤ 200, notes cut to 500 chars), `add_tasks` (Inbox by default, `clientId` idempotency), `create_project`. The tool surface is append-only: nothing completes, moves, edits or deletes. |
| GTD health findings | [`src/domain/insights/gtd-health.ts`](../../src/domain/insights/gtd-health.ts) (`computeGtdHealthFindings`) | Six pure findings: `inbox_backlog`, `projects_without_next_action`, `stale_next_actions` (by `updatedAt`, > 7 days), `aging_waiting_for` (by `updatedAt`, > 14 days), `overdue_deadlines`, `scheduled_vs_completed_ratio`. **Only used inside AI snapshots** (`daily-snapshot.ts`, `weekly-snapshot.ts`, `weekly-synthesis-service.ts`). Nothing renders it in the app. |
| Focus findings | [`src/domain/insights/focus.ts`](../../src/domain/insights/focus.ts) (`computeFocusFindings`) | Single-day totals and project concentration. No cross-day fragmentation or cancel ratio. |
| Deterministic local coach brief | `buildLocalCoachPulse` in [`src/lib/ai/proposals/coach-pulse-fallback.ts`](../../src/lib/ai/proposals/coach-pulse-fallback.ts), called by [`src/lib/ai/coach-pulse-service.ts`](../../src/lib/ai/coach-pulse-service.ts) | Precedent for "top finding with meaningful evidence, no model". Lives in the personal-domain coach and depends on daily entries, so the work profile cannot use it. |
| Next Action age | [`src/lib/gtd/next-action-age.ts`](../../src/lib/gtd/next-action-age.ts) (`nextActionAgeDays`) | Ledger-based "in Next Actions since N days", already shown on Next Actions cards. |
| Daily task stats | `buildDailyTaskStats(tasks, events, date)` in [`src/lib/gtd/engine.ts`](../../src/lib/gtd/engine.ts) | Pure per-day `tasksAtStart/Added/Completed/Remaining` over already-loaded tasks and events. |
| Pomodoro reads | `listPomodoroSessions(date)`, `listPomodoroTaskSummaries(date, now?)`, `computeDailyPomodoroStats(date)` on `AppRepository` | **Per-day only**. No range read. |
| Accept-step proposals | `acceptAiProposal` and `ai_proposals` | User-controlled application of AI suggestions. Proposals need an `ai_messages` row, and both tables are in the sync spec's `personal` domain. |

Gaps this spec closes: the health findings are invisible unless the OpenRouter coach is on; the
bridge cannot read Pomodoro history, task activity or health; nothing turns a connected Claude into
a coach.

## Decisions

| Decision | Choice |
|---|---|
| Model provider for the work coach | **The user's own Claude client** (Claude Desktop or Claude Code on the employer-approved account) connected to the existing LLM bridge. No OpenRouter call on any path in this spec; no new API key; the work profile keeps AI off. |
| Layering | Deterministic engine first (works with no model), then read-only bridge tools, then shipped MCP prompts. Each layer is shippable alone. |
| Health engine home | **Extend** `src/domain/insights/gtd-health.ts`; add `src/domain/insights/focus-quality.ts` for cross-day Pomodoro findings. A pure assembler `buildGtdHealthReport` lives in `src/lib/gtd/health-report.ts`. No second "health" implementation. |
| Backward compatibility of AI snapshots | `computeGtdHealthFindings(tasks, projects, now)` keeps its signature and **byte-identical output** for current callers. New inputs (`events`, sessions) are optional; current AI snapshot builders do not pass them, so OpenRouter payloads and input hashes do not change. A golden test pins this. |
| Where the health shows | A new `/gtd-health` page ("Santé GTD") on every profile, plus a one-line top-finding strip on Next Actions. The `work` profile's route set gains `/gtd-health`. |
| New bridge tools | Four read-only tools: `get_gtd_health`, `get_pomodoro_stats`, `list_pomodoro_sessions`, `get_task_activity`. Plus an optional `context` filter and an `ageDays` field on `list_tasks`. Exact contracts below. |
| New bridge write tools | **None in v1.** A coach suggestion that should become work is captured with the existing `add_tasks` into the **Inbox** (optionally attached to the project), with a `coach:`-prefixed `clientId`. Clarifying, moving and completing stay user actions in the app. A GTD-domain suggestion queue is an open question, not v1. |
| `ai_proposals` for bridge suggestions | **Not used.** It needs an `ai_messages` row and is `personal`-domain data, which a `work` database must never hold (sync spec, work profile rules). |
| Privacy filter | A **user-set, device-local** setting `llmBridgeExcludedContextIds` (default empty) hides tasks, projects and Pomodoro titles carrying those contexts from every bridge read. It is not a tool argument, because an argument is chosen by the model. |
| Personal-domain data on the bridge | Never exposed by any tool on any profile. The bridge may only call an allowlist of GTD/Pomodoro repository methods, and a test enforces it. |
| Repository changes | One new method, `listPomodoroSessionsBetween(startDate, endDate)`, in both `TauriSqliteRepository` and `MemoryRepository`, with a contract test. No migration. |
| MCP prompts | Shipped by the app: Rust advertises `capabilities.prompts` and forwards `prompts/list` and `prompts/get`; prompt bodies are static TypeScript, contain no user data and instruct Claude which tools to call. |
| Thresholds | Named constants in `src/domain/insights/constants.ts`. Not user-configurable in v1. |
| Language | In-app copy is French via i18n like the rest of the UI. Bridge outputs carry stable machine fields (`kind`, numbers, ids) plus the French `label`; prompt text is English (it addresses the model) and asks Claude to answer in the user's language. |

## Layer 1: deterministic GTD health engine

### Inputs

```ts
interface GtdHealthInput {
  tasks: Task[];                       // all tasks, any status (completed/cancelled needed for ratios)
  projects: Project[];
  contexts: TaskContext[];
  events?: TaskEvent[];                // optional: enables ledger-based ages
  sessions?: PomodoroSessionDetails[]; // optional: enables focus-quality findings
  now: string;                         // ISO instant; tests control "now"
  windowDays?: number;                 // focus/activity window, default HEALTH_WINDOW_DAYS (14)
}
```

A non-pure loader, `loadGtdHealthInput(repository, now)` in `src/lib/gtd/health-input.ts`, reads
`listTasks({ includeCompleted: true })`, `listProjects()`, `listContexts()`, `listTaskEvents()` and
`listPomodoroSessionsBetween(today - windowDays + 1, today)`. It never calls `reconcileDay`: reads
do not write, as elsewhere in the GTD engine. The page and the bridge share the loader.

### Findings

Existing kinds keep their current definition and severity on the **legacy path**
(`computeGtdHealthFindings(tasks, projects, now)`). The **report path** (`buildGtdHealthReport`,
which always passes `events`) applies the refinements below. Kinds marked **new** exist only on the
report path. All are computed over **active** tasks unless stated, with local calendar dates from
`src/lib/date.ts`.

| Kind | Rule | Severity | Constant(s) |
|---|---|---|---|
| `inbox_backlog` (existing) | Count of active Inbox tasks. Legacy path: unchanged (`watch` when > 0). Report path: `watch` only above `INBOX_BACKLOG_WATCH` (new constant, 10), else `info` | see rule | `INBOX_BACKLOG_WATCH` |
| `inbox_aging` **new** | Active Inbox tasks whose `createdAt` local date is more than `INBOX_AGING_DAYS` (2) days old. A task that left the Inbox has a different bucket, so `createdAt` is the right clock here. Value = count; items sorted oldest first with `ageDays` | `watch` when ≥ 1 item is older than 7 days, `info` otherwise | `INBOX_AGING_DAYS` |
| `projects_without_next_action` (existing) | Active projects with no active Next Action **and** no active Planned task. The Planned queue auto-promotes, so a project with a Planned queue only appears when it is truly empty (see note below) | `watch` | — |
| `stale_next_actions` (existing, refined) | Next Actions older than `STALE_NEXT_ACTION_DAYS` (7). **With `events`**: age = `nextActionAgeDays` (the same clock as the Next Actions card). **Without `events`**: today's `updatedAt` rule, unchanged | `watch` | `STALE_NEXT_ACTION_DAYS` |
| `aging_waiting_for` (existing, extended items) | Unchanged rule (`updatedAt` older than 14 days; the model has no follow-up date and no bucket-change event). Each item now carries `hasDeadline`; items without one are listed first as "no follow-up date" | `watch` | `AGING_WAITING_FOR_DAYS` |
| `overdue_deadlines` (existing) | Unchanged | `watch` | — |
| `deadline_cluster` **new** | Any `DEADLINE_CLUSTER_SPAN_DAYS` (3) consecutive local days within the next `DEADLINE_LOOKAHEAD_DAYS` (14) holding ≥ `DEADLINE_CLUSTER_MIN` (4) active deadlines. Reports the densest window: `from`, `to`, count, items | `watch` | the three constants |
| `scheduled_overload` **new** | Any local day in the next 7 with ≥ `SCHEDULED_DAY_MAX` (6) active `scheduled` tasks dated that day (`isTaskScheduledForDate`). Planned tasks that reuse `scheduledFor` are excluded, as on the Scheduled screen. Reports each overloaded day | `watch` | `SCHEDULED_DAY_MAX` |
| `scheduled_vs_completed_ratio` (existing) | Unchanged | `info` | — |
| `focus_fragmentation` **new** (needs `sessions`) | Over completed focus sessions in the window: mean **activity switches per focus**. Per session, take its positive-duration segments ordered by `startedAt` (zero-duration paused-retarget placeholders are dropped, as in task summaries), map each to an **activity identity** (`task:<taskId>`, else `manual:<trimmed, lower-cased title>`), and count adjacent pairs whose identities differ. Segment boundaries alone are not switches: pause then resume on the same task opens a new segment (`pauseSession`/`resumeSession` in `src/lib/pomodoro/engine.ts`) and counts 0. `watch` when the mean is ≥ `FOCUS_SWITCHES_WATCH` (1.0) over ≥ `MIN_FOCUS_SAMPLE` (8) sessions | `watch` / `info` | `FOCUS_SWITCHES_WATCH`, `MIN_FOCUS_SAMPLE` |
| `focus_cancel_ratio` **new** (needs `sessions`) | cancelled ÷ (completed + cancelled) **focus** sessions in the window. `watch` when ≥ `FOCUS_CANCEL_WATCH` (0.3) with ≥ `MIN_FOCUS_SAMPLE` sessions | `watch` / `info` | `FOCUS_CANCEL_WATCH` |
| `focus_off_list` **new** (needs `sessions`) | Share of focus minutes on manual (free-form) segments rather than GTD tasks. `info` only: a signal that work is happening outside the list, never a judgement | `info` | — |

Note on `projects_without_next_action`: the current implementation ignores Planned. In practice
the repository's auto-promotion keeps a Planned-queue project supplied with a Next Action, but a
project whose only remaining tasks are Waiting For or Scheduled is still correctly flagged. The
Planned exclusion is a **behavioural change to an existing kind**. To keep AI snapshots
byte-identical it applies only on the report path. See open question 3.

Findings below their sample threshold are still returned, with `severity: "info"` and
`sampleSize`, so a UI or model can say "not enough data yet" instead of inventing a trend. This
mirrors `hasMeaningfulEvidence` in the local coach.

### Report

`buildGtdHealthReport(input): GtdHealthReport` (pure) wraps the findings with what a UI or model
needs:

```ts
interface GtdHealthReport {
  generatedAt: string;                 // input.now
  window: { from: string; to: string; days: number };
  counts: {                            // active tasks per bucket + active projects
    inbox: number; nextAction: number; scheduled: number; waitingFor: number;
    somedayMaybe: number; reference: number; planned: number; activeProjects: number;
  };
  findings: GtdHealthReportFinding[];  // ordered: watch before info before positive, then |value| desc
  top: GtdHealthReportFinding | null;  // first finding with meaningful evidence, as pickTopFinding does
}

interface GtdHealthReportFinding {
  kind: GtdHealthFindingKind | FocusQualityFindingKind;
  severity: "watch" | "info" | "positive";
  value: number;
  threshold: number | null;
  sampleSize: number;
  meaningful: boolean;
  label: string;                       // French, from the `insights` i18n namespace
  items: GtdHealthItem[];              // full list; callers truncate
}

type GtdHealthItem =
  | { type: "task"; id: string; title: string; bucket: TaskBucket; projectId: string | null;
      contextIds: string[]; ageDays?: number; deadline?: string | null; scheduledDate?: string | null;
      hasDeadline?: boolean }
  | { type: "project"; id: string; title: string; contextIds: string[] }
  | { type: "day"; date: string; count: number; taskIds: string[] };
```

`computeGtdHealthFindings(tasks, projects, now)` becomes a projection of the same internals that
returns today's six kinds with today's fields. The existing `gtd-health.test.ts` plus a new golden
test over a fixed fixture assert its output is unchanged.

### In-app surfaces

- **`/gtd-health` page** (`src/pages/GtdHealthPage.tsx`, nav label "Santé GTD"): the report, one
  card per finding with `watch` first. Each item links to its bucket route (or `/projects`) and
  opens the task card there. A collapsed "Pas assez de données" group holds findings that are not
  meaningful. It loads on open and on the existing GTD reload signal (`gtd-external-change.ts`,
  local-day rollover). It never writes.
- **Next Actions strip**: when `top` is a `watch` finding, one line above the list (label + "Voir"
  link to `/gtd-health`). Hidden otherwise. No modal, no notification.
- **Today (personal profile)** is unchanged. The OpenRouter coach keeps its own snapshot path.
  Showing the report on Today is out of scope.
- **Work profile**: `/gtd-health` joins the work route set from the sync spec. The strip works the
  same. No AI copy appears.

Keep the components thin: the page renders `GtdHealthReport` and holds no rules.

## Layer 2: read-only bridge tools

All new tools live in `src/lib/llm-bridge/tools.ts` (or a sibling `coach-tools.ts` re-exported into
`LLM_BRIDGE_TOOLS` if `tools.ts` grows too large). They follow the existing conventions: validation
errors on arguments are tool-level `isError: true` results so the model can correct itself, unknown
tools and non-object arguments are JSON-RPC `-32602`, and `mutated` is always `false`. Dates are
local `YYYY-MM-DD`. Each response states the filter in effect (see [Privacy](#privacy)).

Common shapes:

```ts
interface BridgeFilterInfo {
  excludedContexts: string[];   // names, from llmBridgeExcludedContextIds
  hiddenTaskCount: number;      // active tasks omitted by the filter (count only, never titles)
}
```

### `get_gtd_health`

Description for the model: "Deterministic GTD health check of the user's TrackDidia list: inbox
backlog and age, projects without a next action, stale next actions, aging waiting-for items,
deadline clusters, scheduled overload, and Pomodoro focus quality over the last N days. Read-only.
Start a coaching session with this."

| Input | Type | Default | Rule |
|---|---|---|---|
| `windowDays` | integer | 14 | 7–28; drives the focus findings |
| `itemLimit` | integer | 10 | 0–50 items per finding; 0 returns counts only |

Output:

```json
{
  "generatedAt": "2026-10-16T14:02:11.000Z",
  "window": { "from": "2026-10-03", "to": "2026-10-16", "days": 14 },
  "filter": { "excludedContexts": ["Personal"], "hiddenTaskCount": 6 },
  "counts": { "inbox": 12, "nextAction": 31, "scheduled": 4, "waitingFor": 7,
              "somedayMaybe": 40, "reference": 22, "planned": 9, "activeProjects": 11 },
  "top": "projects_without_next_action",
  "findings": [
    { "kind": "projects_without_next_action", "severity": "watch", "value": 2,
      "threshold": 0, "sampleSize": 11, "meaningful": true,
      "label": "2 projets actifs sans action suivante",
      "items": [{ "type": "project", "id": "project:…", "title": "Q4 vendor review", "contexts": ["Work"] }],
      "truncated": false }
  ]
}
```

Task items carry `id`, `title`, `bucket`, `project` (title), `contexts` (names), and the
kind-specific `ageDays`, `deadline`, `scheduledDate` or `hasDeadline`. **Notes are never included**
(use `list_tasks` when needed). The report is computed over the filtered view, so hidden tasks never
appear as items and do not count toward findings.

### `get_pomodoro_stats`

Description: "Pomodoro focus statistics for a local date range (max 31 days): completed and
cancelled focus sessions, focus minutes, task switches per focus, and where the time went (by task
and by project). Read-only."

| Input | Type | Default | Rule |
|---|---|---|---|
| `from` | `YYYY-MM-DD` | `to − 6` | ≤ `to` |
| `to` | `YYYY-MM-DD` | today | ≤ today; span ≤ 31 days |
| `top` | integer | 15 | 1–50 rows in `byTask` / `byProject` |

Output:

```json
{
  "from": "2026-10-10", "to": "2026-10-16",
  "filter": { "excludedContexts": [], "hiddenTaskCount": 0 },
  "totals": { "completedFocus": 23, "cancelledFocus": 4, "focusMinutes": 611,
              "switchesPerFocus": 0.6, "offListMinutes": 50 },
  "days": [{ "date": "2026-10-16", "completedFocus": 3, "cancelledFocus": 1,
             "focusMinutes": 81, "switches": 2 }],
  "byTask": [{ "taskId": "…", "title": "Draft rollout plan", "project": "Q4 rollout",
               "minutes": 125, "sessions": 5 }],
  "byProject": [{ "projectId": "…", "title": "Q4 rollout", "minutes": 240, "sessions": 10 }],
  "current": { "kind": "focus", "status": "running", "startedAt": "…", "endsAt": "…",
               "title": "Draft rollout plan" }
}
```

- `focusMinutes` sums positive-duration segment wall-clock time of **completed and cancelled** focus
  sessions, capped at `now` for open segments, like `listPomodoroTaskSummaries`. `completedFocus`
  counts only completed sessions, matching `completedFocusSessions`.
- `switches` (per day) and `switchesPerFocus` use the `focus_fragmentation` definition: changes of
  activity identity between consecutive positive-duration segments, so a same-task pause/resume is
  not a switch.
- Rows for a task under an excluded context are merged into one `{ "title": "(masqué)" }` row, so
  totals stay honest without revealing titles. Manual segment titles are returned as typed, because
  they carry no context (see [Privacy](#privacy)).
- `current` is the active session from `getPomodoroState()` (null when none), with the same masking.
- Aggregation is a pure function, `summarizePomodoroRange(sessions, tasks, projects, range, now)` in
  `src/lib/pomodoro/`, shared with the focus-quality findings so the numbers cannot drift.

### `list_pomodoro_sessions`

Description: "Pomodoro session history for a local date range (max 7 days), newest first, with the
task or activity worked on in each segment. Read-only."

| Input | Type | Default | Rule |
|---|---|---|---|
| `from` / `to` | `YYYY-MM-DD` | today / today | span ≤ 7 days, `to` ≤ today |
| `kind` | `focus` \| `break` \| `all` | `focus` | |
| `limit` | integer | 100 | 1–200 sessions |

Output: `{ from, to, filter, total, returned, sessions: [{ id, kind, status, date, startedAt,
endedAt, minutes, segments: [{ title, taskId, project, startedAt, endedAt, minutes }] }] }`.
Zero-duration placeholder segments are dropped. Segments on excluded tasks get title `"(masqué)"`
and `taskId: null`.

### `get_task_activity`

Description: "What happened in the GTD list over a local date range (max 31 days): per-day tasks at
start, added, completed and remaining (the same numbers as TrackDidia's daily metrics), plus the
tasks completed in the range. Read-only."

| Input | Type | Default | Rule |
|---|---|---|---|
| `from` | `YYYY-MM-DD` | `to − 6` | ≤ `to` |
| `to` | `YYYY-MM-DD` | today | ≤ today; span ≤ 31 days |
| `completedLimit` | integer | 50 | 0–200 |

Output:

```json
{
  "from": "2026-10-10", "to": "2026-10-16",
  "filter": { "excludedContexts": [], "hiddenTaskCount": 0 },
  "days": [{ "date": "2026-10-16", "tasksAtStart": 14, "tasksAdded": 3,
             "tasksCompleted": 5, "tasksRemaining": 12 }],
  "totals": { "added": 19, "completed": 24, "captured": 31, "cancelled": 3 },
  "completed": [{ "id": "…", "title": "Send vendor shortlist", "project": "Q4 vendor review",
                  "completedAt": "2026-10-16T10:12:00.000Z" }],
  "completedTruncated": false
}
```

- `days` comes from `buildDailyTaskStats(tasks, events, date)` per date over one load of tasks and
  events, so it equals the Today breakdown and suggested metrics. A pure helper
  `buildTaskActivityRange(tasks, events, from, to)` in `src/lib/gtd/` owns it.
- `captured` = `task_created` events in the range. `cancelled` = tasks with `status = cancelled`
  whose `updatedAt` local date is in the range. There is no cancel event, so this is labelled
  approximate in the tool description.
- **Daily stats are computed over the unfiltered list** (they are the user's real metrics). Only the
  `completed` titles are filtered. The response says so, so a model does not expect the two to
  reconcile when contexts are excluded. See open question 5.

### `list_tasks` additions

Backward-compatible additions to the existing tool:

| Input | Effect |
|---|---|
| `context` | Context name or id; matches the task's stored contexts **or** contexts inherited from its project when the task has none (same rule as the Next Actions context filter). Unknown context is a tool error pointing to `list_contexts`. |
| `order` | `newest` (default, today's behaviour: `createdAt` descending) or `oldest` (`createdAt` ascending). Ties break on `id`. The order is applied to the **whole filtered set before** `offset`/`limit`, so `order: "oldest"` always starts at the true oldest task, however large the bucket. |
| `offset` | Integer ≥ 0, default 0. Skips that many tasks of the ordered set. |

The response gains `offset` and `nextOffset` (`offset + returned`, or `null` when nothing is left),
beside the existing `total` and `returned`, so a client can walk a backlog larger than 200. Offsets
are positional, not cursors. With `order: "oldest"` a traversal is stable against new captures,
which sort to the end, but a task clarified out of the bucket mid-walk shifts later pages by one.
The tool description says so, and `clarify_inbox` works one page at a time.

Each returned task gains `ageDays`: for Next Actions `nextActionAgeDays`, for Inbox days since
`createdAt`, otherwise days since `updatedAt`. It also gains `project` (title) and `contexts`
(names) beside the existing ids, so the model needs fewer follow-up calls.

### Repository change

```ts
// AppRepository
listPomodoroSessionsBetween(startDate: string, endDate: string): Promise<PomodoroSessionDetails[]>;
```

Inclusive local dates on the session's `date` column, ordered by `startedAt`, with segments and the
same `activeTaskId`/`activeLabel`/`taskIds` derivation as `listPomodoroSessions`. Implemented in
`TauriSqliteRepository` (one query on `pomodoro_sessions.date BETWEEN ? AND ?` plus a segment
fetch) and `MemoryRepository`. `listPomodoroSessions(date)` may delegate to it. A contract test in
`repository.contract.ts` runs against both. No schema change; if a date index is missing on
`pomodoro_sessions`, adding it is a separate append-only migration and not required for
correctness.

### Bridge read allowlist

The new tools and the existing `list_*` tools may call only:

`listTasks`, `listProjects`, `listContexts`, `listTaskEvents`, `listPomodoroSessionsBetween`,
`getPomodoroState`, `getSettings` (to read `llmBridgeExcludedContextIds` only).

The write tools additionally use what they use today (`createTask`, `createProject`,
`reconcileDay`, and so on). A test wraps a repository in a `Proxy` that throws on any other method
and exercises every read tool, so a later change cannot quietly read daily entries, reviews, goals,
AI rows, memories or finance through the bridge.

### Server instructions

`SERVER_INSTRUCTIONS` in `llm_bridge.rs` gains one sentence: "For coaching, start with
get_gtd_health; suggestions the user accepts are added with add_tasks to the Inbox." It stays short,
because clients show it in every session.

## Layer 3: shipped coaching prompts

### Transport

- Rust: `initialize` advertises `"prompts": { "listChanged": false }` beside `tools`, and the router
  forwards `"prompts/list" | "prompts/get"` like the tool methods. The existing Rust unit tests gain
  a case for each.
- TypeScript: `src/lib/llm-bridge/prompts.ts` exports `LLM_BRIDGE_PROMPTS` (name, description,
  arguments) and `getBridgePrompt(name, args)`, which returns
  `{ description, messages: [{ role: "user", content: { type: "text", text } }] }`.
  `handleBridgeRequest` handles both methods. Unknown prompt → `-32602`.
- The stdio adapter already forwards every JSON-RPC line unchanged; no change needed.
- Claude Code exposes these as `/mcp__trackdidia__<name>`; Claude Desktop lists them in its prompt
  picker.

### Prompts

Prompt bodies are **static text plus validated arguments**. They embed **no user data**. They tell
Claude which tools to call, so the data flow stays visible as tool calls the user can inspect.

| Prompt | Arguments | What it asks Claude to do |
|---|---|---|
| `daily_plan` | `focusBlocks` (optional int, 1–16), `constraints` (optional string ≤ 500, e.g. "meetings 10–12") | Call `get_gtd_health`, `list_tasks` (Next Actions, Scheduled for today), `get_pomodoro_stats` for the last 7 days. Propose an ordered plan of at most `focusBlocks` Pomodoros drawn **only from existing tasks**, flag deadlines today/tomorrow, and name one inbox or stalled-project fix. Do not add tasks unless the user says yes. |
| `weekly_gtd_review` | none | Walk the GTD weekly review in order: inbox to zero (clarify suggestions), Next Actions staleness, Waiting For follow-ups, projects without next actions, Someday/Maybe skim, the coming two weeks of deadlines and Scheduled. Use `get_task_activity` and `get_pomodoro_stats` for the past week. One question at a time; summarise decisions at the end. |
| `unstick_projects` | `limit` (optional int, 1–10, default 3) | From `projects_without_next_action` and stale Next Actions, propose one concrete, verb-first next action per project and, on the user's approval, capture each with `add_tasks` (bucket `inbox`, `project` set, `clientId` `coach:project:<projectId>:<YYYY-MM-DD>`). |
| `clarify_inbox` | `limit` (optional int, 1–40, default 15) | `list_tasks` with `bucket: "inbox"`, `order: "oldest"`, `limit` (the oldest captures, not a re-sorted newest page). It offers the next page with `nextOffset` when the user wants to continue. For each item suggest the GTD decision (trash / reference / someday / next action with context / project / waiting for / schedule) as a table. **Tell the user to apply decisions in TrackDidia**: the bridge cannot move or edit tasks. |

Shared rules every prompt text includes (the `COACH_RULES` constant):

- answer in the user's language;
- base every statement on tool output; say "not enough data" when a finding is not `meaningful`;
- the list contains personal tasks too, so do not comment on or speculate about them beyond what the
  user asks;
- never claim to have changed a task; the only write is `add_tasks` to the Inbox, after an explicit
  yes;
- Pomodoro numbers describe activity, not worth. No moralising.

### Fallback without prompts

For a client that ignores MCP prompts, `docs/llm-bridge.md` documents a short paragraph the user can
paste into a Claude Project's instructions with the same rules. The paragraph is a copy of the
`COACH_RULES` constant in `prompts.ts`, and the doc says so; the constant is canonical.

## Write tools: why none in v1

Considered:

| Candidate | Verdict |
|---|---|
| `propose_next_action(projectId, title)` | Not needed: `add_tasks` with `bucket: "inbox"` and `project` already lands a suggested action attached to its project. That is legal today (only `planned` requires a project; `scheduledDate` requires `scheduled`). The user clarifies it like any capture. |
| `clarify_inbox_item(taskId, decision)` that moves or edits | Rejected for v1. It breaks the bridge's append-only stance and would let a model reshape the user's list, including personal tasks, from an employer account. |
| Suggestions queued as `ai_proposals` with in-app accept | Rejected. It needs an `ai_messages` row, and both tables are `personal`-domain, which the work database must not contain. |
| A new GTD-domain suggestion queue (`gtd_suggestions` table, in-app accept that reuses the pure mutation helpers) | Plausible later (open question 1). It needs a migration, a sync-registry entry in the `gtd` domain and a UI. Revisit after the user has used `clarify_inbox` for a while. |

The `coach:` `clientId` prefix makes coach captures idempotent per day and recognisable
(`sourceExternalId` `llm:coach:…`), so a later report can count how many were accepted, meaning
moved out of the Inbox. This adds no tracking table.

## Privacy

What goes where:

| Data | Leaves the machine? | To whom |
|---|---|---|
| Health report, task titles, project titles, context names, Pomodoro titles and minutes, task activity | Only when a connected client calls a tool | The client's model provider: on the work laptop, **the employer's Claude account** |
| Task and project notes | Only through `list_tasks` / `list_projects` (truncated to 500 chars), never through the new tools | Same |
| Daily entries, reviews, journals, goals, objectives, AI messages/proposals/memories, finance, settings, secrets | **Never** through the bridge, on any profile | — |

Statements the docs must carry:

1. **The work laptop's GTD list includes personal tasks** (the user chose not to split), and so do
   relationship-draw tasks (children/spouse activities in the `Personal` context; see the sync
   spec's open question 6). Anything a coaching session reads is visible to the employer's Claude
   account under the employer's retention and admin policies.
2. The bridge is a data-processor relationship, as with OpenRouter. The difference is who chose the
   provider: here it is the client the user configured, not TrackDidia.
3. Prompts contain no data; tool calls are the only data path, and Claude clients show each call.

**Context exclusion** (`llmBridgeExcludedContextIds: string[]`, default `[]`, in the settings JSON,
repaired by `normalizeAppSettings`, no migration). The control lives in Settings →
"Connexion LLM (MCP)": "Contextes masqués au client LLM".

- A task is hidden when its **effective** contexts (stored, or inherited from its project when the
  task has none) intersect the set. A project is hidden when its contexts intersect the set; its
  tasks are then hidden too, whatever their own contexts.
- Hidden tasks and projects disappear from `list_tasks`, `list_projects` and every new tool's items.
  `list_contexts` omits excluded contexts. Responses carry `filter.hiddenTaskCount`, a count only, so
  the model knows the view is partial without learning its contents.
- Pomodoro rows on hidden tasks are aggregated as `"(masqué)"`. Manual free-form segment titles
  cannot be classified and are returned as typed. The Settings help text says so.
- **Write responses are filtered too.** The rule is that no response field read from a stored row
  may describe a hidden task or project. Fields that only echo the model's own input are exempt. This
  changes existing write tools only while the exclusion set is non-empty:
  - `add_tasks` **duplicate replay**: idempotency still uses the full, unfiltered lookup, so no
    second task is ever created. When the matched task is hidden (it may have been retagged or
    renamed in the app since capture), the outcome is `{ "status": "duplicate", "hidden": true }`
    with no `taskId`, `title` or `bucket`. Today the duplicate branch runs before context
    validation and returns the stored title, so this is an explicit new check, not a side effect of
    filtering `list_contexts`;
  - `add_tasks` `project`: a hidden project does not resolve. The task is created without a project
    and carries the existing "no active project" warning, so its existence is not confirmed;
  - `add_tasks` with an excluded context name fails as "Unknown context", because the write lookup
    uses the filtered context list;
  - `create_project` whose title matches a hidden active project returns
    `{ "created": false, "hidden": true }` with no `id`. It does not create a second project.
  The filter is one helper (`isHiddenFromBridge(row, exclusion)`) used by read and write paths alike.
- Default empty matches the user's "no split" choice. On a `work` profile, Settings shows a one-time
  hint suggesting `Personal` (open question 2), but does not pre-fill it.
- In the sync spec's settings registry this key is **`device`**: an exclusion chosen for the work
  laptop must not change what a personal laptop's bridge shows, or the reverse.

This is a convenience boundary, not a guarantee. It depends on contexts being set. It is documented
as "keeps tagged personal tasks out of the client's view", not as confidentiality.

## Interaction with the multi-laptop sync work profile

- **Everything this spec reads is `gtd`-domain**: tasks, projects, contexts, task events, Pomodoro
  sessions and segments. A `work` database has all of it, so all three layers work there unchanged.
- **Nothing this spec writes is new data.** The engine and tools are read-only; coach captures are
  ordinary tasks created through `add_tasks`, `gtd`-domain, synced like any capture. No new table, so
  no registry entry is needed. The registry test from the sync spec keeps passing.
- **Route set**: add `/gtd-health` to the work profile's route list. Next Actions (the work index)
  shows the strip.
- **Settings registry**: classify `llmBridgeExcludedContextIds` as `device`, alongside the existing
  `llmBridgeEnabled`/`llmBridgePort`/`llmBridgeToken` (secrets and per-device transport).
- **Pomodoro sync semantics**: the sync spec publishes only terminal sessions. On a personal laptop,
  `get_pomodoro_stats` therefore includes the work laptop's completed and cancelled sessions after a
  pull, but `current` only ever shows a timer running on *this* laptop. The tool description says
  "on this computer" for `current`.
- **Opposite direction**: work tasks synced to a personal laptop are visible to whatever client is
  connected to *that* laptop's bridge, and to the OpenRouter coach under the sync spec's open question
  2. This spec does not change that. The per-device exclusion lets the personal laptop hide a `Work`
  context from its own client if wanted.
- **Ordering**: this spec does **not** depend on sync shipping. Layers 1–3 are useful on a single
  laptop today. The two work-profile bullets (route set, registry class) are applied by whichever
  spec ships second.

## Phases

Each phase is independently shippable and changes no existing OpenRouter payload.

1. **Health engine + page.** Extend `gtd-health.ts` (new kinds, optional `events`), add
   `focus-quality.ts`, `buildGtdHealthReport`, `summarizePomodoroRange`,
   `listPomodoroSessionsBetween` (both repositories + contract test), `loadGtdHealthInput`,
   `/gtd-health` page, Next Actions strip, nav entry, i18n. Golden test proving
   `computeGtdHealthFindings` output is unchanged.
2. **Bridge read tools.** `get_gtd_health`, `get_pomodoro_stats`, `list_pomodoro_sessions`,
   `get_task_activity`, `list_tasks` additions (`context`, `order`, `offset`, enriched fields),
   `llmBridgeExcludedContextIds` setting + Settings UI + filtering of read **and** write responses
   (`add_tasks` duplicates and hidden projects, `create_project`), read allowlist test, updated `SERVER_INSTRUCTIONS`.
3. **MCP prompts.** Rust `capabilities.prompts` and forwarding, `prompts.ts`, handler cases, Claude
   Project fallback paragraph in the docs.
4. *(Optional, after use)* GTD-domain suggestion queue with in-app accept (open question 1), and
   ledger events for Waiting For entry if follow-up tracking proves valuable (open question 4).

## Verification

Pure engine tests (`*.test.ts` next to each module):

- `gtd-health.test.ts`: each new kind at, below and above its threshold. Local-date boundaries
  (an Inbox task created 23:30 local the day before counts as 1 day, not 0, regardless of the UTC
  date). `stale_next_actions` uses `nextActionAgeDays` when `events` are supplied and `updatedAt`
  otherwise. Planned exclusion only on the report path. **Golden test**: a fixed fixture through
  `computeGtdHealthFindings(tasks, projects, now)` deep-equals a stored snapshot of today's output.
- `focus-quality.test.ts` and `summarizePomodoroRange` tests: zero-duration placeholders ignored;
  a focus paused and resumed on the same task (two positive segments, same `taskId`) counts **0**
  switches, and eight such focuses produce no `watch`; task A → B → A counts 2; manual titles
  `"Email"` and `" email"` are one activity; a paused retarget A → B then resume counts 1; cancelled sessions count toward minutes but not `completedFocus`; open
  segments capped at `now`; manual titles grouped case-insensitively like task summaries; masking
  merges hidden-task rows into one; below `MIN_FOCUS_SAMPLE` the finding is not `meaningful`.
- `deadline_cluster` / `scheduled_overload`: Sunday-to-Saturday week crossing, DST-change day
  (local-date helpers only), Planned tasks with `scheduledFor` excluded.
- `buildTaskActivityRange`: per-day numbers equal `buildDailyTaskStats` for each date. The range
  limit is enforced.
- `buildGtdHealthReport`: ordering, `top` selection matches `pickTopFinding` semantics, counts per
  bucket.

Repository:

- `repository.contract.ts`: `listPomodoroSessionsBetween` returns the same sessions as concatenating
  `listPomodoroSessions` per day, for both implementations, including an empty range and a range
  with a running session.

Bridge handler tests (`tools.test.ts` style, `MemoryRepository`):

- `tools/list` includes the four new tools with valid JSON schemas; `additionalProperties: false`.
- Each tool: defaults, bounds (`windowDays` 6 and 29 rejected, span > 31 / > 7 rejected, `to` in the
  future rejected, malformed dates rejected) as `isError` results; `mutated` is false; output
  matches the documented shape.
- Exclusion: with `Personal` excluded, a task tagged `Personal`, a task inheriting it from its
  project, and a project tagged `Personal` never appear in any tool's output. `hiddenTaskCount` is
  right. Pomodoro rows show `"(masqué)"`. `list_contexts` omits it. `add_tasks` with it fails as
  unknown.
- **Replay after exclusion**: capture a task with `clientId: "c1"`, then tag it `Personal`, rename it
  to a sentinel and exclude `Personal`. Replaying `c1` creates nothing and returns
  `{ status: "duplicate", hidden: true }`, and the sentinel title and the task id appear nowhere in
  the response. The same holds for `create_project` with a hidden project's title, and for
  `add_tasks` naming a hidden project (task created unattached, warning only). With an empty
  exclusion set, both tools return exactly today's output.
- **Allowlist**: a `Proxy` repository that throws on non-allowlisted methods passes every read tool;
  seeding daily entries, reviews, goals, AI memories and finance rows in `MemoryRepository` and
  scanning all read-tool outputs for their sentinel strings finds none.
- `list_tasks` additions: `context` matches inherited contexts; `ageDays` agrees with the Next
  Actions card helper. **Backlog larger than the cap**: with 201 Inbox tasks, `order: "oldest"`,
  `limit: 200` includes the oldest task and returns `nextOffset: 200`; `offset: 200` returns the last
  one with `nextOffset: null`; omitting `order` keeps today's newest-first output byte for byte.
- Prompts: `prompts/list` shape; `prompts/get` for each prompt with and without arguments; argument
  bounds; the rendered text contains no repository data (the handler test passes a repository that
  throws on any call).
- Rust: `initialize` advertises `prompts`; `prompts/list` and `prompts/get` are forwarded; other
  methods still return `-32601`.

UI (Testing Library with `src/test/test-utils.tsx`): `/gtd-health` renders findings with `watch`
first and links to the right routes; the Next Actions strip shows only for a meaningful `watch` top
finding; Settings saves and restores the excluded contexts.

Manual (desktop build, not browser preview): connect Claude Code with the copied command, run
`/mcp__trackdidia__daily_plan`, and confirm each tool call and the absence of excluded tasks.

Before reporting each phase complete: `npm run test` and `npm run build` (prefer `npm run
verify:all`, since Rust changes in Phase 3 also need `cargo check` and `cargo clippy -- -D warnings`).

## Documentation (required by `AGENTS.md`)

- [`docs/llm-bridge.md`](../../docs/llm-bridge.md): new tools table rows and contracts (Phase 2),
  `list_tasks` additions (ordering and pagination), exclusion setting and its effect on
  `add_tasks`/`create_project` responses, read allowlist, prompts section and the Claude Project
  fallback (Phase 3). Update **Limitations** (prompts no longer missing) and the **Security model**
  bullet "Anything the client reads… is visible to its model provider" with the work-laptop
  statement. Add `prompts.ts` and the health modules to the source map. Log rows in
  [`docs/logs/llm-bridge.md`](../../docs/logs/llm-bridge.md).
- [`docs/gtd.md`](../../docs/gtd.md): a "GTD health" section (findings, thresholds, the
  `/gtd-health` page, the Next Actions strip), linked from "Screen behavior". Log in [`docs/logs/gtd.md`](../../docs/logs/gtd.md).
- [`docs/recurrences-and-pomodoro.md`](../../docs/recurrences-and-pomodoro.md): range reads,
  fragmentation and cancel-ratio definitions under "Daily reporting". Log in
  [`docs/logs/recurrences-and-pomodoro.md`](../../docs/logs/recurrences-and-pomodoro.md).
- [`docs/ai-settings-and-privacy.md`](../../docs/ai-settings-and-privacy.md): extend "LLM bridge
  (optional)" and "Privacy implications" with the employer-account statement, the excluded-contexts
  setting and the never-exposed list. Under "Local coach", note that the GTD health engine is the
  no-model coach for GTD/Pomodoro and is independent of `aiEnabled`. Under "Context and redaction",
  state that AI snapshots still call the legacy `computeGtdHealthFindings` path. Log in
  [`docs/logs/ai-settings-and-privacy.md`](../../docs/logs/ai-settings-and-privacy.md).
- [`docs/architecture.md`](../../docs/architecture.md): the new route. Log in
  [`docs/logs/architecture.md`](../../docs/logs/architecture.md).
- No new canonical page: the bridge, GTD and privacy pages already own these facts. No change to the
  `AGENTS.md`/`CLAUDE.md` quick-reference table unless the LLM bridge row's summary ("add
  tasks/projects") is updated to mention coaching reads; if it is, edit both files identically
  (`cmp AGENTS.md CLAUDE.md`).
- Move this spec to `specs/done/` only after the phases it claims have shipped with tests and docs.

## Risks, ranked

1. **Personal tasks reaching the employer's Claude account.** Inherent to the user's "no split"
   choice. Mitigated by stating it plainly, the device-local context exclusion, notes kept out of the
   new tools, and prompts that tell the model not to dwell on personal items. Residual: untagged
   personal tasks and manual Pomodoro titles.
2. **Scope creep into personal-domain data.** A future "helpful" tool reading daily entries or goals
   through the bridge. Mitigated by the allowlist `Proxy` test and the sentinel-scan test.
3. **Silently changing OpenRouter payloads.** Editing `gtd-health.ts` could change AI snapshot
   content and input hashes. Mitigated by the optional-input design and the golden test. Any
   intentional change goes through the prompt version registry.
4. **Nagging instead of coaching.** Too many `watch` findings make the page noise. Mitigated by
   conservative thresholds, a single strip line, no notifications, and `meaningful` gating. Tune the
   constants after two weeks of real data.
5. **Proxy-based ages are wrong.** `aging_waiting_for` and `cancelled` counts rely on `updatedAt`,
   which any edit bumps. The tool descriptions and docs label them approximate. Open question 4 holds
   the real fix.
6. **Bridge latency on large histories.** `get_task_activity` loads all tasks and events once (as
   daily stats already do). It is bounded to 31 days of per-day computation and well under the
   25-second transport timeout on the current data size. Measure on the real database in Phase 2.
7. **Client behaviour outside our control.** MCP prompt support differs between clients. The Claude
   Project fallback covers clients without it.

## Open questions

1. **A GTD-domain suggestion queue?** Should Claude be able to propose *changes* (clarify, move,
   schedule) that the user accepts in TrackDidia, via a new `gtd_suggestions` table in the `gtd` sync
   domain? Or is "Inbox capture + clarify in the app" enough? Recommendation: wait for real use of
   `clarify_inbox`.
2. **Default exclusion on the work profile.** Keep it empty (the user's "no split" choice), or
   pre-fill `Personal` on a `work` device, which would also hide relationship-draw tasks from the
   employer's Claude?
3. **Planned and `projects_without_next_action`.** Adopt the Planned-aware rule in the AI snapshot
   path as well, with a prompt-version bump, so there is one definition everywhere?
4. **Waiting For follow-up.** Add a `task_moved_to_waiting_for` ledger event (ignored by
   `buildDailyTaskStats`) and an optional follow-up date, so `aging_waiting_for` measures time in
   the bucket instead of time since last edit? That is a schema-adjacent change with its own spec.
5. **Filtered daily stats.** With contexts excluded, should `get_task_activity.days` also be
   recomputed over the filtered list? That would differ from the app's metrics but match the
   filtered titles.
6. **Thresholds.** Are the proposed defaults (Inbox 10, Inbox age 2 days, stale 7 days, Scheduled 6
   per day, 4 deadlines in 3 days, cancel ratio 0.3, 1 switch per focus) right for this user's list
   size, or should they be settings from day one?
7. **Employer policy on MCP.** Does the employer's Claude deployment allow local MCP servers (Claude
   Desktop config or `claude mcp add`)? If MCP is blocked on the work laptop, layers 2–3 do not apply
   there, and layer 1 is the whole work coach.
