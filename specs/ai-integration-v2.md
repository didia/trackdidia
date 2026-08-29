# Spec — AI Integration v2

**Status:** phases 0–6 implemented (see `docs/ai-settings-and-privacy.md` and `docs/log.md`).
**Scope boundary:** this file is roadmap/history, not the live behavior catalog.
Per [`AGENTS.md`](../AGENTS.md), `docs/` describes shipped behavior only. Move facts
into the relevant `docs/` page **as each phase ships**, and append to
[`docs/log.md`](../docs/log.md) at that point — not before.

---

## 1. Why

TrackDidia tracks a personal operating system: 11 daily metrics, 14 principles, a full
GTD workspace with lifecycle events, Pomodoro sessions with per-task attribution,
RescueTime goals and productivity pulse, Sunday–Saturday reviews, monthly rituals, and
annual goals with monthly evaluations.

The AI sees almost none of it.

### Current behavior (verified in code)

| Aspect | Today |
|---|---|
| Call sites | Two, both in [`TodayPage.tsx`](../src/pages/TodayPage.tsx) (`:68`, `:100`) |
| Output | One free-text French paragraph |
| Trigger | Only fires if the user already wrote text ([`coach-input.ts:24`](../src/lib/ai/coach-input.ts)) |
| Payload | `JSON.stringify({ today: DailyEntry, recentEntries: 7 })` — raw keys, no labels, units, targets or trends |
| Persistence | In-memory `Map` in `AiCoachService`; lost on reload |
| Plumbing | No timeout, no `max_tokens`, no temperature, no retry, no usage recording |
| Surfaces | Weekly, monthly, annual, GTD, Pomodoro, RescueTime: none |

Three consequences drive this spec:

1. **The coach cannot help you start.** It is gated on the user having already done the
   reflective work. It reacts; it never initiates.
2. **The coach has no memory.** Every call is a cold start. It cannot follow up on
   yesterday's commitment, cannot notice a three-week pattern, cannot learn what advice
   the user acts on versus ignores.
3. **The coach only speaks at the bookends.** Morning and evening. A day that stalls at
   11:00 is not noticed until the post-mortem, when nothing can be done about it.

### Decisions taken

| Date | Decision | Choice |
|---|---|---|
| 2026-08-28 | Focus | Memory layer + deepen daily coach + weekly/monthly/annual copilot |
| 2026-08-28 | Write access | AI proposes; nothing persists until the user accepts |
| 2026-08-28 | Provider | Stay on OpenRouter, add scoped payload control |
| 2026-08-28 | Trigger | Explicit button, result persisted in SQLite |
| 2026-08-29 | Coach shape | **One continuous coach, not two.** Slot-aware stances, running on a pulse through the day (§6) rather than only at the bookends |
| 2026-08-29 | Pulse scheduling | **Catch-up, not cron.** Evaluated on app open and on an interval tick; coalesce to the current slot and never backfill missed ones (§6.2) |
| 2026-08-29 | Pulse cost control | **Deterministic delta gate before any model call.** `idle` never reaches the provider; a stall is arithmetic, not inference (§6.3) |
| 2026-08-29 | Notifications | **Silent by default.** OS notification only on a second consecutive stall, capped at 2/day; the model gets no vote on interrupting (§6.4) |
| 2026-08-29 | Day boundaries | First slot anchors to **first app open**, not the 05:00 clock; 20:00 is `wind_down`; the true `close` is **event-triggered** (§6.2) |
| 2026-08-29 | Stall definition | **Binary movement.** A window moved if at least one Pomodoro focus session *or* at least one task was completed. No pace target, no per-slot quota (§6.3) |
| 2026-08-29 | Pulse density | **Three slots**, not five: `open`, one midday `steer`, `wind_down` (§6.1) |
| 2026-08-29 | Notification band | **Weekdays only.** No OS notification fires Saturday or Sunday; weekend pulses still run and update the panel silently (§6.4) |

---

## 2. Architecture

Six layers, strictly ordered. Each is independently testable; only layer 4 touches the
network.

```text
1. src/domain/insights/       deterministic computation   (pure, offline, free)
2. src/lib/ai/memory/         durable facts + retrieval   (SQLite)
3. src/lib/ai/context/        snapshot assembly + redaction
4. src/lib/ai/provider        OpenRouter transport
5. src/lib/ai/pulse/          scheduling, delta gate, notification policy
6. src/lib/ai/proposals/      structured output -> accept-step -> repository writes
```

### Guiding principle

**Compute deterministically, narrate with AI.**

Streaks, trends, correlations, GTD health, anomalies **and stall detection** are
calculated in pure TypeScript. The model receives *findings*, not raw rows, and its job is
to select, prioritise and phrase them. This follows the existing convention in
[`AGENTS.md`](../AGENTS.md) ("put deterministic rules in pure functions and test them
directly") and has four payoffs: the numbers are always right, the prompt is small, the
**local fallback becomes genuinely useful** instead of three canned sentences, and the
pulse (§6) can decide whether calling the model is worth it *before* spending a token.

---

## 3. Layer 1 — Deterministic insight engine

New directory `src/domain/insights/`. Pure functions, no repository access, fully unit
tested with fixtures.

| Module | Produces |
|---|---|
| `streaks.ts` | Per principle: current streak, longest streak, days since last `true`, 28-day rate |
| `trends.ts` | Per metric: 7-day and 28-day trailing average, delta, direction; weekly-score trajectory |
| `correlations.ts` | Difference of mean discipline on days a principle is `true` vs `false`, with sample size |
| `gtd-health.ts` | Inbox backlog, projects with no next action, next actions untouched > N days, aging waiting-for, overdue deadlines, scheduled-vs-completed ratio |
| `focus.ts` | Pomodoro totals, task concentration (share of focus in top task), focus vs RescueTime pulse alignment |
| `anomalies.ts` | Today / this week versus personal baseline, with a minimum-sample floor |
| `movement.ts` | **Window movement**: completed focus sessions and completed tasks since the last pulse, plus how much of the window the app was open — feeds the pulse delta gate (§6.3) |

Rules:

- **Minimum sample guards.** No correlation reported below a configured `n` (start at 10
  days). Below the floor, the finding is omitted, not weakened.
- **Observation, never causation.** Output wording and types say "associated with". The
  prompt instructs the same. A discipline app that tells you a false cause is worse than
  one that says nothing.
- Every finding carries `{ id, severity, evidenceWindow, sampleSize, value }` so the
  prompt can be assembled mechanically and the local fallback can render the top finding
  without a model.

**Deliverable of this layer alone:** a better offline coach, before any prompt changes.

---

## 4. Layer 2 — Memory

This is the substantive new capability. Three tiers, only two of which are new.

### Tier 1 — Raw history

Already in SQLite. Not memory; it is data, reached by aggregation. Unchanged.

### Tier 2 — Episodic memory (`ai_messages`)

Every AI output is persisted with its inputs and outcome. Enables continuity
("hier tu t'étais engagé à…"), history, cost accounting, and a feedback signal on which
advice the user actually acts on.

### Tier 3 — Semantic memory (`ai_memories`)

Durable, compact, human-readable statements distilled about the user.

| `kind` | Example | Lifetime |
|---|---|---|
| `pattern` | "Les jours sans prière du matin, la discipline moyenne baisse de 28% (n=34)" | Long, decays |
| `preference` | "Préfère un conseil unique et concret plutôt qu'une liste" | Long |
| `context` | "Charge de travail élevée jusqu'à fin octobre 2026" | Has `expiresAt` |
| `commitment` | "S'engage à 8 pomodoros demain" | Short; resolved next evening |
| `principle` | User-pinned: mission, saison de vie, style de coaching voulu | Permanent until edited |

Columns: `id, kind, statement, detail, confidence, source, status, evidence_from,
evidence_to, created_at, last_confirmed_at, expires_at, pinned`.

- `source`: `ai_extracted | user_pinned | derived` (`derived` = written directly by the
  insight engine, no model involved).
- `status`: `active | archived | contradicted`.

#### Lifecycle

**Write.** After the evening close, and after each weekly/monthly review, a distillation
pass proposes memory candidates. **They are proposals** — the user accepts or dismisses
each one (§7). A hallucinated "fact" must never become permanent silently.

**Read.** Retrieval selects the top *N* relevant memories per surface, ranked by
`pinned > kind relevance > confidence > recency`, capped by a token budget, and injected
as a compact block in the system prompt. Pinned user-profile memories are always
included.

**Decay and contradiction.** Deterministic, no model:

- Confidence decays with age; a memory not confirmed within its window drops below the
  retrieval threshold and is archived.
- `pattern` memories are re-tested against fresh data by `correlations.ts`. A memory the
  data now contradicts is marked `contradicted` and surfaced for review rather than
  silently deleted.
- `context` memories expire on `expiresAt`.

#### Commitments — the highest-value loop

A commitment made in the evening is retrieved the next morning, **carried through the
day's pulses**, and closed out the next evening:

```text
Evening D      -> close stance proposes commitment "8 pomodoros demain"
                  user accepts -> ai_memories row, kind=commitment, expires D+1
Open   D+1     -> retrieval injects it; the opening pulse restates it
Steer  D+1     -> the midday pulse checks it against live data: 2/8 at 13:00 is a
                  deterministic finding, not a model judgement
Close  D+1     -> outcome recorded -> memory archived with result
```

Where a commitment maps to a tracked metric or principle, **resolve it deterministically
and tell the model the answer.** Do not ask the model to judge whether the user hit 8
pomodoros when the database knows.

#### User profile (pinned memory)

A Settings section where the user writes durable context by hand: mission, current season
of life, what coaching style works, what to never bring up. Cheap to build, and the single
largest quality lever in the whole spec. Stored as `pinned` memories, always retrieved.

---

## 5. Layer 3 — Context builder and payload scope

New directory `src/lib/ai/context/`. Turns repository data + insight findings + retrieved
memories into a typed, labelled, compact snapshot per surface.

What changes versus today's raw dump:

- Metrics carry their **label, unit, target and delta versus trailing average** (from
  [`definitions.ts`](../src/domain/definitions.ts) and `trends.ts`), not bare keys.
- Principles carry **label, timing and streak**, not `respectTrc: null`.
- GTD, Pomodoro and RescueTime state appear at all.
- Findings replace row dumps; recent-entry arrays shrink to aggregates plus the current day.

### Scoped payload control

New setting `aiPayloadScope`:

| Scope | Sends |
|---|---|
| `metrics` | Numbers, scores, aggregates, principle booleans, findings. **No free text, no titles.** |
| `metrics_and_structure` | + task titles, project names, contexts, objective titles |
| `full` (default) | + notes, reflections, review section notes, memories |

Redaction is applied **centrally in the context builder**, once, so no surface can leak by
forgetting. A `previewPayload(surface, scope)` function renders the exact bytes that would
be sent, exposed in Settings behind the existing debug affordance. Tests assert, per scope,
that forbidden fields are absent.

Settings additions need **no migration** — `AppSettings` is a JSON blob merged with
`defaultAppSettings()` on read:

```ts
aiPayloadScope: "metrics" | "metrics_and_structure" | "full";  // default "full"
aiSurfaceModels: Partial<Record<AiSurface, string>>;           // default {}
aiMaxTokens: number;              // default 700
aiTimeoutMs: number;              // default 20000
aiMemoryEnabled: boolean;         // default true
aiPulseEnabled: boolean;          // default true
aiPulseSlots: number[];           // default [5, 13, 20] (local hours; first anchors to first open)
aiPulseNotifyEnabled: boolean;    // default true
aiPulseNotifyDays: number[];      // default [1, 2, 3, 4, 5] (Mon–Fri; 0 = Sunday)
aiPulseMaxNotificationsPerDay: number;  // default 2
```

---

## 6. Layer 5 — The continuous coach (pulse)

**Replaces the two separate morning/evening coaches with one coach that runs through the
day.** One surface, one memory thread, one panel; the *stance* adapts to the slot.

### 6.1 Stances

| Stance | When | Job |
|---|---|---|
| `open` | First pulse of the day | Set intention, name up to 3 priorities, restate any open commitment |
| `steer` | 13:00 | One concrete correction while the afternoon is still fully available |
| `wind_down` | 20:00 | What is still open, what can realistically land, what to let go |
| `close` | **Event-triggered**, not clock-triggered | Debrief, tomorrow's focus, commitment, memory candidates |

### 6.2 Scheduling — catch-up, not cron

`AGENTS.md` lists background scheduling while the app is closed as an explicit product
boundary, and this spec does not change that. The pulse is therefore a **catch-up
model**, reusing the interval pattern already established for auto-backup in
[`app-context.tsx:122`](../src/app/app-context.tsx):

- Default slots: `05, 13, 20` local hours, configurable — `open`, one midday `steer`,
  `wind_down`. One midday steer is a deliberate density choice: enough to catch a stalled
  morning while the afternoon is still fully available, few enough that each pulse is
  worth reading.
- On app open **and** on an in-app interval tick, resolve the current slot. If that slot
  has no persisted pulse for today, run it.
- **Coalesce, never backfill.** Opening the laptop at 16:00 produces one pulse for the
  13:00 slot — not a queue of stale ones for every slot since morning. Missed slots are recorded as missed (useful
  signal in itself) and never generated retroactively.
- **The first slot anchors to first open, not the clock.** An 05:00 pulse can fire before
  the user is awake and would be stale by the time it is read. The `open` stance runs at
  the later of the 05:00 slot and the first app open of the day.
- **The `close` stance is event-triggered**, when the user opens the evening closure page.
  Retro journalier, prière du soir and `nightReflection` routinely land after 20:00, so a
  clock-triggered close would consistently fire before the day is actually done. The
  20:00 slot is `wind_down`, not `close`.

### 6.3 The delta gate — why this does not get expensive

Before any model call, compute a `PulseWindow` since the last pulse from data already in
SQLite, via `movement.ts`: completed Pomodoro focus sessions, completed tasks, and how much
of the window the app was actually open.

**Movement is binary.** The window moved if **at least one focus session was completed, or
at least one task was completed.** No pace target, no per-slot quota — a rule with no
tuning knob cannot drift out of calibration, and both inputs are already recorded reliably.

| Class | Meaning | Model call |
|---|---|---|
| `progress` | At least one focus session or one completed task | **Yes** — reinforce, and steer on what is left |
| `stall` | No movement, app open for a meaningful part of the window | **Yes** — this is the case the pulse exists for |
| `unknown` | No movement, but the app was barely open — cannot distinguish working-offline from stalled | **No** — render a local question |
| `idle` | Outside the active band, or the previous pulse was minutes ago | **No** — panel keeps the last pulse |

Three consequences:

- **A stall is arithmetic, not inference.** Zero focus sessions and zero completed tasks is
  a database query. The model is *told* the classification; it is never asked to derive it.
- **`unknown` prevents the worst failure mode.** A day worked with the app closed is not a
  stalled day, and asserting otherwise is exactly the thing that makes a coach lose
  credibility. Rather than assert, the local panel asks — and that question costs nothing.
- **Cost tracks activity.** Only `progress` and `stall` reach the provider, and the
  `input_hash` cache in `ai_messages` absorbs repeats. Three slots a day is the upper
  bound; a real day rarely reaches it.

**The gate is binary; the narration is not.** The magnitudes — how many focus sessions, how
many tasks, which ones — still go into the context for `progress` windows. One task cleared
in eight hours passes the gate, but the model sees the count and can say so. Keeping the
*gate* simple and the *context* rich preserves the cheap decision (call or don't) without
throwing away signal for the expensive one (what to say).

### 6.4 Notification policy — deterministic, and quiet by default

The largest risk in this whole feature is notification fatigue: five nudges a day and all
five get ignored within a week. So:

- **Pulses are silent by default.** They update a persistent coach panel; the user reads
  it when they look.
- An OS notification (via the existing `sendNotification` in
  [`sound.ts:349`](../src/lib/pomodoro/sound.ts)) fires only on the **second consecutive
  `stall`**, or when a configured threshold is crossed.
- **Weekdays only.** No notification fires on Saturday or Sunday, whatever the
  classification. Weekend pulses still run and still update the panel — the day is
  observed, it is simply never allowed to interrupt. Configurable via `aiPulseNotifyDays`.
- Hard cap: `aiPulseMaxNotificationsPerDay`, default 2. With three slots and a weekday-only
  band this is close to unreachable by construction — which is the intent; it stays as a
  backstop.
- **The model gets no vote on interrupting the user.** Escalation is decided by the
  deterministic classification. A model asked "is this important enough to interrupt?"
  answers yes essentially always.
- Never notify during an active Pomodoro focus session.

---

## 7. Layer 6 — Structured output and the accept-step

### Surfaces and schemas

Five surfaces, each with a versioned prompt and a JSON schema.

**S1 `coach_pulse`** — Today page. One schema, stance-dependent fields.

```ts
{
  stance: "open" | "steer" | "wind_down" | "close";
  headline: string;                 // one line, always present
  read: string;                     // what the data says since the last pulse
  move: { what: string; why: string; horizon: "now" | "today" | "tomorrow" } | null;

  // stance: open
  priorities?: Array<{ taskId: string | null; title: string; why: string }>;  // <= 3
  intentionDraft?: string;

  // stance: open | steer | wind_down
  commitmentCheck?: { commitment: string; progress: string; question: string } | null;

  // stance: close
  wins?: string[];
  frictionPoint?: { what: string; why: string; adjustment: string };
  principleToRecover?: PrincipleKey | null;
  tomorrowFocusDraft?: string;
  commitment?: { statement: string; metricKey: MetricKey | null; target: number | null } | null;
  memoryCandidates?: Array<{ kind: MemoryKind; statement: string; confidence: number }>;
}
```

**S2 `weekly_synthesis`** — Weekly review page

```ts
{
  headline: string;
  scoreExplanation: string;
  strongestAxis: string;
  weakestAxes: string[];                                       // exactly 2
  sectionDrafts: Partial<Record<WeeklyRitualSectionKey, string>>;
  nextWeekObjectives: Array<Pick<WeeklyObjective,
    "title" | "kind" | "targetHours" | "rescuetimeKind" | "rescuetimeThing">>;  // <= 5
  gtdActions: Array<{ taskId: string; action: "schedule" | "defer" | "delegate" | "drop"; reason: string }>;
}
```

**S3 `monthly_synthesis`** — Monthly review page

```ts
{
  headline: string;
  weekPattern: string;
  sectionDrafts: Partial<Record<MonthlyReviewSectionKey, string>>;
  goalEvaluationDrafts: Array<{ goalId: string; score: number | null;
    trend: AnnualGoalTrend | null; notes: string; blockers: string }>;
}
```

**S4 `goal_pacing`** — Annual goals page

```ts
{ goals: Array<{ goalId: string; onPace: boolean; gap: string;
    requiredWeeklyBehaviour: string; riskLevel: "low" | "medium" | "high";
    recommendation: string }> }
```

**S5 `memory_distill`** — invoked from weekly and monthly rituals; proposes
`ai_memories` rows.

### Validation

Hand-written TypeScript validators — the repo has no runtime validation dependency and
this spec does not add one. Validation is **stance-aware**: a `close` response missing
`tomorrowFocusDraft` is invalid; an `open` response missing it is not. On invalid JSON:
one repair retry with the validation error appended, then fall back to the deterministic
local message. **A malformed model response must never break a ritual.**

### The accept-step

Every write goes through `ai_proposals`. Nothing mutates the repository until the user
clicks accept.

| Proposal type | Accept applies |
|---|---|
| `intention_draft` | Prefills `morningIntention` (editable, not saved until the user saves) |
| `tomorrow_focus_draft` | Prefills `tomorrowFocus` |
| `priority_task` | `scheduleTask` for today, or `moveTask` to `next_action` |
| `review_section_draft` | Fills the weekly/monthly note textarea for that section key |
| `weekly_objective` | Creates a `WeeklyObjective` row |
| `goal_evaluation` | Writes an `AnnualGoalEvaluation` for the month |
| `memory` | Inserts an `ai_memories` row |

Each proposal records `pending | accepted | dismissed | expired` plus `decided_at`. This
audit trail is also the **feedback signal**: a stance or surface whose proposals are
consistently dismissed is one whose prompt needs work, and that is measurable without
guessing.

---

## 8. Storage

Append-only migrations starting at **21** (20 is the last shipped). Both
`TauriSqliteRepository` and `MemoryRepository` must implement every new method — the
parity contract in [`AGENTS.md`](../AGENTS.md) is not optional.

**Migration 21 — `ai_messages`**

```text
id, surface, scope_key, stance, kind, input_hash, prompt_version, model,
status (ok|fallback|error|skipped), body_json, body_text,
delta_class (progress|stall|unknown|idle), notified,
tokens_prompt, tokens_completion, latency_ms, created_at
UNIQUE (surface, scope_key, input_hash)
```

`scope_key` is the date for daily surfaces (`2026-08-29#12` for a pulse slot),
`weekStartDate`, or `monthKey`. The unique index is the persistent cache: identical inputs
return the stored row instead of re-billing.

`status = skipped` records an `idle` or `unknown` pulse with no model call — cheap, and it
keeps the pulse history honest about what was and was not evaluated. **No separate pulse table
is needed**: last-pulse time and the delta baseline derive from
`max(created_at) WHERE surface = 'coach_pulse'`.

**Migration 22 — `ai_proposals`**

```text
id, message_id, type, payload_json,
status (pending|accepted|dismissed|expired), applied_entity_id, decided_at, created_at
INDEX (message_id), INDEX (status)
```

**Migration 23 — `ai_memories`**

```text
id, kind, statement, detail, confidence, source, status,
evidence_from, evidence_to, created_at, last_confirmed_at, expires_at, pinned
INDEX (status, kind), INDEX (expires_at)
```

New repository methods:

```ts
getAiMessage(surface: AiSurface, scopeKey: string, inputHash: string): Promise<AiMessage | null>;
saveAiMessage(message: AiMessage): Promise<AiMessage>;
listAiMessages(surface?: AiSurface, limit?: number): Promise<AiMessage[]>;
listAiMessagesForDate(date: string): Promise<AiMessage[]>;   // the day's pulse thread
listAiProposals(messageId: string): Promise<AiProposal[]>;
decideAiProposal(id: string, status: "accepted" | "dismissed", appliedEntityId?: string): Promise<AiProposal>;
listAiMemories(filters?: AiMemoryFilters): Promise<AiMemory[]>;
saveAiMemory(memory: AiMemory): Promise<AiMemory>;
archiveAiMemory(id: string, reason: "expired" | "contradicted" | "resolved"): Promise<void>;
```

Backups already use `VACUUM INTO` on the whole database, so memory is covered with no
change. Note in `docs/ai-settings-and-privacy.md` when this ships: **backups now contain
distilled personal statements** in addition to the API key.

---

## 9. Provider hardening

[`OpenRouterProvider`](../src/lib/ai/openrouter-provider.ts) currently has no timeout,
which is a real hang risk — the RescueTime client already got a 20s abortable timeout and
the AI path did not. This matters more once calls fire unattended on a pulse.

- 20s abortable timeout via `AbortController`, mirroring `fetchRescueTimeJson`.
- Send `max_tokens` and `temperature`; request `response_format: { type: "json_object" }`
  for structured surfaces.
- One retry with backoff on 429 and 5xx. No retry on 4xx.
- Per-surface model resolution: `settings.aiSurfaceModels[surface] ?? settings.aiModel`.
  A cheap fast model for pulses, a stronger one for monthly synthesis and goal pacing.
- Record `usage` into `ai_messages`; surface a simple monthly token/cost total in Settings.
- Existing rule stands: never log the key or the payload.

---

## 10. Triggering

Remove the "must have written text first" gate entirely. Three triggers, one path:

1. **Pulse** — slot due and not yet run, evaluated on app open and on interval tick (§6.2).
2. **Explicit** — a **« Demander au coach »** button on every surface.
3. **Event** — the `close` stance when the evening closure page opens; weekly/monthly
   synthesis when those reviews open.

All three run the same path: build context → retrieve memory → classify delta → check
`ai_messages` for a matching `input_hash` → call only on miss → validate → persist →
render → apply notification policy.

A **« Régénérer »** action bypasses the cache deliberately. When AI is off or the key is
empty, the button is disabled with an explanatory label and the deterministic local brief
renders regardless, always.

---

## 11. Phasing

Each phase ships independently and leaves the app in a working state.

| Phase | Content | Value on its own |
|---|---|---|
| **0** | Insight engine (incl. `movement.ts`), context builder, redaction, payload preview | Local coach becomes substantive; zero network change |
| **1** | Provider hardening, `ai_messages`, explicit trigger, structured `coach_pulse` for `open`/`close` stances + prefill accept-step | The daily coach becomes actually useful |
| **2** | Pulse scheduling, delta gate, `steer`/`wind_down` stances, notification policy | The coach catches stalls while the day can still change |
| **3** | `ai_memories`, user profile, commitment loop carried across pulses, distillation | Continuity — the coach remembers |
| **4** | S2 weekly copilot: section drafts + next-week objectives + GTD actions | The Sunday ritual gets faster and sharper |
| **5** | S3 monthly synthesis + S4 goal pacing | Month and year close with evidence |
| **6** | Proposal-acceptance analytics, prompt tuning, cost dashboard | Measured improvement instead of vibes |

Phase 1 ships the merged coach at parity with today's two-coach behavior (bookends only);
phase 2 turns on the pulse. That ordering means the risky part — unattended calls and
notifications — lands on top of an already-proven path.

---

## 12. Non-goals

Explicitly out of scope for v2; revisit after phase 6:

- Conversational chat with tool-calling over the repository
- **Scheduling while the app is closed.** The pulse is catch-up on open, not cron
- Local model support (Ollama / LM Studio) — `aiBaseUrl` already permits it informally,
  but it is not a supported, tested mode here
- Cloud sync, accounts, encrypted key storage, OS keychain
- Any AI write that applies without an explicit accept
- Embeddings or vector search — memory is small, human-readable and retrieved by rules

---

## 13. Testing

Per [`AGENTS.md`](../AGENTS.md), calculations get pure engine tests and screens get
Testing Library.

- **Insight engine:** fixture-based unit tests per module; explicit cases for the minimum
  sample floor and for empty/sparse history.
- **Pulse:** slot resolution across timezone/DST boundaries; coalescing (open at 16:00
  yields exactly one pulse, for the 13:00 slot); first-slot anchoring to first open;
  movement detection from focus sessions and completed tasks; classification for each of
  the four classes; `idle` and `unknown` produce no provider call.
- **Notification policy:** silent by default, fires only on second consecutive stall,
  daily cap respected, suppressed during an active focus session, and fully suppressed on
  Saturday and Sunday while the underlying pulse still runs and persists.
- **Context builder:** snapshot test per surface × per scope, asserting that
  scope-forbidden fields are absent.
- **Validators:** valid, malformed, partial, stance-specific requirements, repair-retry.
- **Memory:** retrieval ranking, decay, contradiction detection, commitment resolution
  against a real metric, expiry boundaries.
- **Coach service:** fake provider — cache hit, persisted hit, validation failure
  fallback, timeout fallback, AI-disabled path.
- **Pages:** proposal renders, accept applies the right repository call, dismiss records
  the decision, error state never blocks the ritual.
- **Storage:** migration row-mapping tests; `MemoryRepository`/`TauriSqliteRepository`
  parity for all new methods.

Verification before any phase is called complete: `npm run test` then `npm run build`.

---

## 14. Open questions

1. **The `unknown` threshold.** How much of a window must the app have been open before
   "no movement" reads as a stall rather than as no data? First cut: 30 continuous minutes.
   This is the one number the binary movement rule did not eliminate, and it decides how
   often the coach accuses you of stalling on a day you worked offline. Tune from real
   usage in phase 2.
2. **Weekend classification, and the ritual exception.** Suppressing weekend notifications
   leaves two things unresolved. First, a Saturday with no focus session and no completed
   task still classifies as `stall` — spending a call and writing "tu n'as pas avancé" into
   the panel for a day of rest. Recommend downgrading weekend no-movement to `idle`: no
   call, no message. Second, Sunday and the first Saturday of the month are *working* days
   in this system — the weekly and monthly rituals live there, and `isFirstSaturdayOfMonth`
   already exists in [`monthly-review.ts`](../src/domain/monthly-review.ts) — so a blanket
   weekend band also removes the one weekend nudge worth having: the ritual is not done.
   Recommend a narrow carve-out notifying only for an unstarted ritual on those two days.
3. **Distillation cadence.** Proposing memories after *every* evening may be noisy.
   Weekly-only is calmer but slower to learn. Suggested start: weekly, plus commitments
   which are always daily.
4. **Retrieval budget.** How many memories per prompt before it dilutes? Start at 8 plus
   all pinned, and tune with the phase-6 acceptance data.
5. **Correlation floor.** `n = 10` is a guess. Worth setting from the real history size
   once phase 0 can report it.
6. **Language of stored memory.** French statements match the UI, but mixing languages in
   the prompt can degrade smaller models. Recommend French throughout, since every
   existing prompt and output is already French.
