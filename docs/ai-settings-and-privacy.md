# AI, Settings, Relationship Draws, and Privacy

The Settings screen combines several local operational features. AI is optional;
all core tracking, GTD, reviews, and coaching fallbacks work without a network.

## Settings storage

`AppSettings` is serialized as one JSON value in the singleton `app_settings` row.
On every read, the saved object is merged with `defaultAppSettings()`, so newly
added properties receive defaults on older installations.

Default highlights:

| Setting | Default |
|---|---|
| Language | French |
| Storage mode | SQLite |
| AI enabled | No |
| AI base URL | `https://openrouter.ai/api/v1` |
| AI model | `moonshotai/kimi-k2.6` |
| AI payload scope | `full` |
| AI max tokens | `700` |
| AI timeout | `20000` ms |
| AI cost estimate rate | `1` USD / million tokens (approximate) |
| AI memory enabled | Yes |
| AI surface models | `{}` (falls back to `aiModel`) |
| Pulse enabled | Yes |
| Pulse slots (local hours) | `5`, `13`, `20` |
| Pulse OS notifications | Yes (weekdays Mon–Fri, max 2/day, second consecutive stall only) |
| RescueTime API key | Empty |
| Automatic backup | Enabled, 24 hours |
| Relationship draws | Enabled |

The settings object also holds internal timestamps for GTD bootstrap normalizations,
the last backup, and per-category relationship processing.

## Coach modes (`coach_pulse`)

TrackDidia uses a unified **`coach_pulse`** surface with stance-aware structured
JSON output.

| Stance | When | Page |
|---|---|---|
| `open` | First pulse of the day (anchored to first app open) | `/` |
| `steer` | Midday catch-up slot (default 13:00 local) | `/` |
| `wind_down` | Evening catch-up slot (default 20:00 local) | `/` |
| `close` | Evening closure page opens + explicit request | `/fermeture-soir` |

Pulse scheduling is **catch-up, not cron**: evaluated on app startup and every
five minutes while the app is open. Missed slots are recorded as skipped
(`delta_class = idle`) and never backfilled; opening late coalesces to the
latest due slot only.

### Delta gate (before any model call)

Since the previous pulse, a deterministic window classifies movement:

| Class | Meaning | Model call |
|---|---|---|
| `progress` | At least one focus session or completed task | Yes |
| `stall` | No movement, app open ≥ 30 continuous minutes | Yes |
| `unknown` | No movement, app open &lt; 30 minutes | No — local question |
| `idle` | No meaningful app-open time, or weekend no-movement | No |

On **Saturday and Sunday**, no-movement windows downgrade to `idle` (no model
call). Pulses still run and update the Today panel silently.

### Notifications

Pulses are **silent by default** (panel update only). An OS notification fires
only on the **second consecutive weekday `stall`**, respects
`aiPulseMaxNotificationsPerDay`, never fires during an active Pomodoro focus
session, and never fires on weekends.

Settings → Paramètres IA exposes pulse toggles, slot hours, and notification cap.
Pulse slot hours must be **exactly three unique local hours (0–23)**, saved sorted;
invalid input is rejected on save with inline feedback. Extra hours in legacy stored
settings are capped to the first three unique sorted values at scheduling time.

### Local coach

`CoachPulseService` always prepares a deterministic local brief from the insight
engine's top finding with meaningful sample size (`buildLocalCoachPulse`). On Today,
this renders immediately on page load without waiting for RescueTime or OpenRouter.

When AI is disabled or the API key is empty:

- only the local brief renders, from a persisted pulse or the deterministic fallback;
- **Régénérer** stays disabled, and auto-load surfaces show the reason as visible text next to the actions (`disabled.aiOff` / `disabled.missingKey`).

### Auto-load trigger (Today and evening close)

When AI is configured, Today auto-loads the coach on page open:

1. if a scheduled pulse for today is already persisted (`open`/`steer`/`wind_down`, never `close`), that thread is shown;
2. otherwise a fast local brief from snapshot inputs that skip the live RescueTime fetch;
3. then an AI call (cache-first) once the full snapshot is ready.

Scheduled pulses (`open`/`steer`/`wind_down`) also call the model when the window
classifies as `progress` or `stall`.

Evening closure (`/fermeture-soir`) auto-loads the `close` stance on page open:

1. due commitments for today are finalized idempotently, even when AI is off;
2. if a `status = ok` close pulse for today is already persisted (`scopeKey` `YYYY-MM-DD#close`), that thread is shown immediately;
3. then `buildPulse` runs cache-first with `skipRescueTimeFetch`, so a live RescueTime blip cannot bust the input hash. `fallback`/`skipped` rows are not reused; the next open retries. If journal fields, metrics, or memories changed, the hash misses and a new model call runs.

**Régénérer** fetches RescueTime and bypasses the `ai_messages` input-hash cache deliberately.

There is **no** gate requiring the user to write journal text first, and no
**Demander au coach** button on Today or evening close while auto-load is active.

### Structured output and accept-step

The model returns JSON validated against the S1 `coach_pulse` schema (stance-aware).
On invalid JSON: one repair retry, then deterministic local fallback.

Phase 3 proposal types:

| Type | Accept applies |
|---|---|
| `intention_draft` | Saves `morningIntention` immediately, then marks the proposal accepted |
| `tomorrow_focus_draft` | Saves `tomorrowFocus` immediately, then marks the proposal accepted |
| `commitment` | Creates an `ai_memories` row (`kind=commitment`, expires next local day) |
| `memory` | Creates an `ai_memories` row from a distillation candidate |

Accepting `memory` or `commitment` persists the memory row and proposal decision
atomically via `acceptAiMemoryProposal`, using a stable memory id derived from the
proposal id so retries reconcile instead of duplicating.

Proposals are stored in `ai_proposals` with `pending | accepted | dismissed | expired`
status. Draft accepts (`intention_draft`, `tomorrow_focus_draft`) save the journal
field first, then record the proposal decision separately.

### Weekly synthesis (`weekly_synthesis`)

The `/semaine` screen runs the S2 `weekly_synthesis` surface when the review page
opens (event trigger) and on explicit **« Demander au coach »** / **« Régénérer »**.
The service builds a typed weekly snapshot via `buildWeeklySnapshot`, retrieves
memories with weekly-specific kind priority, validates JSON, and persists proposals.

| Type | Accept applies |
|---|---|
| `review_section_draft` | Persists the ritual note on the weekly review, then marks the proposal accepted |
| `weekly_objective` | Creates a standing `WeeklyObjective` row (idempotent atomic accept) |
| `gtd_action` | `scheduleTask`, `moveTask` (`someday_maybe` / `waiting_for`), or `cancelTask` on active tasks only (atomic accept) |

Weekly synthesis messages and proposals persist atomically via `saveCoachPulseEpisode`.
The OpenRouter system prompt includes the full S2 schema (`buildWeeklySynthesisSchemaPrompt`).

When AI is disabled or the API key is empty:

- the deterministic local brief still renders from insight findings;
- the **« Demander au coach »** button is disabled with an explanatory label.

Weekly synthesis cache policy: only `ok` results (and `skipped` while AI remains off) are
sticky cache hits. Persisted `fallback`/`error` episodes are shown as last-resort local
briefs but do not block retries when AI is configured.

### Monthly synthesis (`monthly_synthesis`)

The `/mois` screen runs the S3 `monthly_synthesis` surface when the review page
opens (event trigger) and on explicit **« Demander au coach »** / **« Régénérer »**.
The service builds a typed monthly snapshot via `buildMonthlySnapshot`, retrieves
memories with monthly-specific kind priority, validates JSON, and persists proposals.

| Type | Accept applies |
|---|---|
| `review_section_draft` | Persists the ritual note on the monthly review, then marks the proposal accepted |
| `goal_evaluation` | Writes an `AnnualGoalEvaluation` for the month on the linked annual goal |

Monthly synthesis messages and proposals persist atomically via `saveCoachPulseEpisode`.
The OpenRouter system prompt includes the full S3 schema (`buildMonthlySynthesisSchemaPrompt`),
including allowed section keys, snapshot goal ids, and `score` on a 0–100 scale.

When AI is disabled, the deterministic local brief still renders from month aggregates.

Monthly synthesis cache policy matches weekly: only `ok` results (and `skipped` while AI
remains off) are sticky cache hits. Proposals for unknown `goalId`s are dropped at persist
time. Accepting a `goal_evaluation` for a missing goal dismisses the proposal and shows
**Objectif introuvable, suggestion ignoree.**

Monthly synthesis loading and acceptance are **month-scoped**: changing the selected month
invalidates in-flight loads, hides mismatched results, and rejects accept/dismiss when
the proposal message `scopeKey` does not match the displayed month.

### Goal pacing (`goal_pacing`)

The `/objectifs-annuels` screen runs S4 `goal_pacing` on page open and on explicit
**« Demander au coach »** / **« Régénérer »**. Output is display-only (no proposals).
The snapshot reuses annual goal domain calculations (`progressRatio`,
`computeYearProgressFraction`, `isAnnualGoalOnPace`). `asOfDate` uses local `getTodayDate()`.

The OpenRouter system prompt includes the full S4 schema (`buildGoalPacingSchemaPrompt`).

Pacing auto-runs only when the year is between 2000 and 2100 and the evaluation month
matches `YYYY-MM`. Changing the year clears the on-screen pacing panel until the new
year's result loads.

### Semantic memory (`ai_memories`)

Migration 24 adds durable, human-readable coach memory:

| `kind` | Example | Lifetime |
|---|---|---|
| `pattern` | Correlation distilled from history | Long, decays |
| `preference` | Coaching style preference | Long, decays |
| `context` | Temporary life/work context | `expiresAt` |
| `commitment` | Evening pledge for tomorrow | Resolved on next close |
| `principle` | User-pinned profile in Settings | Permanent until edited |

Retrieval (`src/lib/ai/memory/`) ranks active memories by **pinned → kind relevance →
confidence (with decay) → recency**, caps non-pinned rows at **8** plus all pinned rows,
and injects a compact French block into the `coach_pulse` system prompt when
`aiMemoryEnabled` is true.

Lifecycle is deterministic (no model):

- confidence decays with age; below-threshold rows archive;
- `context` rows archive after `expiresAt`;
- `pattern` rows re-test against `correlations.ts` and may become `contradicted`;
- when fresh correlation evidence supports the same sign and similar magnitude
  (|Δdiff| ≤ 0.2), `lastConfirmedAt` and `evidenceTo` refresh without changing
  confidence; material drift updates detail and bumps confidence;
- commitments resolve on the evening **close** pulse when `expiresAt` matches today,
  using metric/principle values from SQLite (the model is told the outcome, not asked
  to judge). Cached close results still run this finalizer idempotently on replay.

**Distillation cadence (Phase 3 start):** weekly review close proposes up to three
derived `pattern` memories from correlation findings; the marker message and candidate
proposals persist atomically via `saveCoachPulseEpisode`, with deterministic ids and
rebuild when a partial set is detected. Lookup uses `getAiMessageRecord` (any status);
coach-pulse cache lookup remains `status = ok` only. Evening **close** pulses may
propose `memoryCandidates` from the model. Commitments are daily via the accept-step.

Settings → **Profil coach** manages pinned `principle` memories (mission, coaching style,
season of life). These are always retrieved when memory is enabled.

**Privacy:** SQLite backups now include distilled personal statements in `ai_memories`
in addition to the OpenRouter API key already stored in settings.

### Context and redaction

Before any model call, `CoachPulseService` builds a typed daily snapshot via
`buildDailySnapshot`, `WeeklySynthesisService` builds a weekly snapshot via
`buildWeeklySnapshot`, `MonthlySynthesisService` builds a monthly snapshot via
`buildMonthlySnapshot`, and `GoalPacingService` builds an annual snapshot via
`buildGoalPacingSnapshot`. All apply `aiPayloadScope` redaction centrally. Settings
can preview the exact payload per scope when debug mode is enabled (see below).

### Persistence (`ai_messages`, `ai_proposals`, `ai_memories`)

Every coach result is persisted in SQLite (migrations 21–24):

- `ai_messages` stores the structured body, usage (`tokens_prompt`,
  `tokens_completion`, `latency_ms`), model, stance, and an input-hash cache key.
  Regenerations append a new row (migration 23). Cache lookup for coach pulse and weekly
  synthesis returns the latest `status = ok` row for a given hash when AI is configured;
  weekly synthesis also caches `skipped` when AI is off. Non-ok markers (e.g. weekly distill,
  retryable fallback) use `getAiMessageRecord` for display but not as sticky AI cache hits.
- `ai_proposals` stores accept-step rows linked to a message.
- `ai_memories` stores semantic memory rows (`active | archived | contradicted`).

Browser preview uses `MemoryRepository` with the same methods. The old in-memory
`AiCoachService` cache is replaced by this durable store on desktop.

### Cost dashboard (Settings)

Settings → **Cout IA (mois en cours)** aggregates `ai_messages` for the current local
calendar month (`created_at` boundaries in local time):

| Metric | Source |
|---|---|
| Appels enregistres | Row count in the month |
| Jetons entree / sortie | Sum of `tokens_prompt` / `tokens_completion` (null → 0) |
| Cout estime | `(prompt + completion) / 1_000_000 × aiCostPerMillionTokens` (computed in UI via `applyCostEstimate`, not in the repository) |

`aiCostPerMillionTokens` defaults to **1.0** USD per million tokens (prompt +
completion combined). This is a **rough static estimate** — OpenRouter pricing varies
by model. Adjust the rate under **Paramètres IA**; nothing calls external pricing APIs.
Clearing the rate field in the draft hides the estimate instead of showing **0,00 $ US**.

Repository method: `computeAiUsageForMonth(monthKey)` returns token totals only
(`AiUsageTotals` — no `estimatedCostUsd`).

### Coach analytics (Settings)

Settings → **Analytique coach** (read-only, French labels) aggregates `ai_proposals`
joined with parent `ai_messages`:

| View | Description |
|---|---|
| Par surface | Acceptance rate by `coach_pulse`, `weekly_synthesis`, etc. |
| Par type | Acceptance rate by proposal type |
| Par posture | Acceptance rate by pulse stance (`open`, `steer`, …) |
| Tendance de rejet | Dismissal rate over the last 30 local days (all days with at least one decision) |
| Signaux de revision | Surfaces/types/stances below 35% acceptance (≥ 3 decisions) flagged as **Candidat de revision de prompt** |

Pure functions live in `src/lib/ai/analytics/`. No automatic prompt changes — human-readable signals only.

Repository helpers: `listAiProposalsSince(sinceIso)`, `listAiMessagesSince(sinceIso, limit?)`.
When the message cap binds, the **newest** rows are retained (oldest dropped).

Load failures in the analytics section show a visible French error banner; the card
stays mounted.

### Prompt version registry

Prompt versions are centralized per surface in `src/lib/ai/prompts/registry.ts` and
stored on each `ai_messages.prompt_version` row:

| Surface | Version constant |
|---|---|
| `coach_pulse` | `coach_pulse.v1` |
| `weekly_synthesis` | `weekly_synthesis.v1` |
| `monthly_synthesis` | `monthly_synthesis.v1` |
| `goal_pacing` | `goal_pacing.v1` |

The analytics section lists active versions and surfaces low-acceptance areas as
prompt-revision candidates.

## OpenRouter request

The base URL is normalized by removing trailing slashes and accidental
`/chat/completions` or `/responses` suffixes. The provider posts to:

```text
<baseUrl>/chat/completions
```

Structured `coach_pulse` requests include:

- per-surface model: `settings.aiSurfaceModels[surface] ?? settings.aiModel`;
- `max_tokens` from `settings.aiMaxTokens` (default 700);
- `temperature` 0.4;
- `response_format: { type: "json_object" }`;
- a French system prompt with stance context and optional memory block;
- the redacted daily snapshot plus deterministic commitment resolution when applicable.

Transport hardening:

- abortable timeout via `settings.aiTimeoutMs` (default 20 s), mirroring RescueTime;
- one retry with 500 ms backoff on HTTP 429 and 5xx;
- no retry on other 4xx responses;
- usage extracted from the OpenRouter `usage` block and stored on the message row.

Headers include the bearer API key, `HTTP-Referer: https://trackdidia.app`, and
`X-Title: Trackdidia`. The key and request payloads are never logged.

HTTP/provider errors produce a fallback local message plus a visible warning; they do
not block the daily workflow.

## RescueTime request

The weekly review loads **RescueTime Goals** when a non-empty `rescuetimeApiKey`
is stored in app settings. The bundled desktop app reads this key **only** from
SQLite settings (`Paramètres → RescueTime`); it never reads a repo-root `.env` file.

RescueTime HTTP uses dual transport via `fetchRescueTimeJson`:

- **Tauri desktop:** native `rescuetime_http_get` (Rust host) to avoid webview CORS limits.
- **Browser preview / non-Tauri:** browser `fetch()` with `Authorization: Bearer` (same pattern as OpenRouter).

Both paths call the same RescueTime endpoints:

```text
GET https://www.rescuetime.com/api/resource/goals
Authorization: Bearer {rescuetimeApiKey}

GET https://www.rescuetime.com/anapi/data
  ?format=json
  &perspective=rank
  &restrict_kind={overview|productivity|...}
  &restrict_begin={weekStartDate}
  &restrict_end={weekEndDate}
Authorization: Bearer {rescuetimeApiKey}
```

The weekly review also fetches a **productivity pulse** with
`restrict_kind=productivity`, `restrict_source_type=computers`, and no
`restrict_schedule_id` (full-week computer time only, Sunday–Saturday). Browser and
native RescueTime requests use a 20-second abortable timeout.

The key is stored locally in the singleton `app_settings` row, merged with defaults
on read, and included in SQLite backups. It is never logged by the app. You can
change it at any time while the app is running; the weekly review reloads goals
when the saved key changes.

Repo-root `.env` with `RESCUETIME_API_KEY` is optional and supported **only** for
local CLI scripts such as `scripts/rescuetime-goals-score.mjs`.

## Privacy implications

Enabling AI can transmit highly personal information:

- intentions and reflections (when scope is `full`);
- principle responses;
- life metrics;
- task-derived and Pomodoro-derived suggested values;
- insight findings assembled from local history.

The user should treat the configured endpoint/model provider as a data processor.
Changing the base URL may send data and the bearer key to a different service.

Current secret handling:

- the API key is stored in plaintext inside the local SQLite settings JSON;
- the Settings UI masks the field visually but this is not encryption;
- backups contain the key and persisted AI messages/proposals;
- no OS keychain integration exists.

Never add the key or request payloads to debug logs, tests, screenshots, docs, or
committed fixtures.

## Relationship activity draws

When enabled, TrackDidia can generate one children activity and one spouse activity
per local day. Each category has an editable list of candidate activities.

Generation behavior:

1. Skip a category already marked processed for the date.
2. If an active generated task for that category exists, do not create another and
   mark the date processed.
3. Randomly select a non-empty configured activity.
4. Create a manual Next Action in the Personal context.
5. Use a deterministic category/date source external ID.
6. Save the processed date in settings.

This design avoids accumulating a new relationship task while yesterday's task is
still active. Completing or cancelling that task allows a future day's generation.

Generation runs at startup and before current-day/GTD loads; it is not scheduled
while the application is closed.

## Backup settings

The Settings screen displays the environment, absolute database path, backup
directory, last backup, and interval. It can:

- enable/disable automatic backup;
- set a minimum one-hour interval;
- create a manual snapshot in desktop mode.

See [Storage and backups](storage-and-backups.md) for the actual backup mechanism.

## GTD import controls

Settings displays current task/project/context counts and the last import timestamp.
The manual action reruns the bundled `Tasks.json` import, updates the timestamp, and
relies on stable IDs/conflict handling to avoid duplicate rows.

The screen does not accept a file upload and does not connect to Google.

## Debug mode

Debug instrumentation:

- records info/warn/error entries in memory;
- retains the last 200 entries;
- mirrors messages to the browser console;
- captures `window.error` and unhandled promise rejections;
- displays a debug panel when enabled or startup fallback is active.

Debug is always enabled in Vite development. In other builds it can be persisted in
`localStorage` under `trackdidia.debug.enabled`, enabled from Settings, or enabled by
`?debug=1` / `?debug=true`.

Logs are not persisted to SQLite. Even so, avoid passing sensitive values to
`logDebug`; console output can be copied or captured externally.

### AI payload preview

Settings has an `aiPayloadScope` control (`metrics`, `metrics_and_structure`, or
`full`; default `full`) that governs how much detail AI context snapshots include —
`metrics` redacts free-text notes and task/project titles, `metrics_and_structure`
adds titles back, and `full` includes everything.

When debug mode is enabled, Settings also shows a payload-preview panel with controls
for **surface** (`daily` coach snapshot, `weekly` synthesis snapshot, `monthly`
synthesis snapshot, or `annual` goal-pacing snapshot), a reference date or month
(week start normalizes to Sunday for weekly; month uses `YYYY-MM`), and a button
that renders the exact typed snapshot that would be sent to the model — one
collapsible block per scope, built from real repository data. This is a debug-only
affordance; it is hidden when debug mode is off. A single preview action resolves
RescueTime once per surface: weekly previews fetch productivity pulse and Goals score
together via `resolveWeeklyRescueTimeInputs` and reuse the result across all three
scopes; daily previews fetch the week-to-date pulse only. Monthly and annual previews
skip RescueTime. If either weekly resolution fails, the panel shows a non-blocking
warning banner and the preview still renders (with missing RescueTime data) rather
than failing outright.

## Related documentation

- [Architecture](architecture.md)
- [Storage and backups](storage-and-backups.md)
- [Daily routines](daily-routines.md)
- [GTD](gtd.md)
