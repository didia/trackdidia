# Weekly review: RescueTime cache, compact goal lines, weekly coach cache

Status: approved plan, not implemented. Reviewed by a planner/validator loop
(1 revision round, `PLAN_APPROVED`).

Requests:

1. RescueTime scores in the weekly review are cached; if a pull fails, the last
   successfully pulled scores are used.
2. The weekly RescueTime section is compact: one line per goal (name, score / objective, %).
3. The weekly AI coach output is cached per week; if a new one cannot be generated, the
   latest generated one for that week is shown.

## Findings from the current code

- Weekly synthesis is already persisted as `AiMessage` (`getAiMessage` by input hash,
  `getLatestAiMessage("weekly_synthesis", weekStart, "ok")`, `saveCoachPulseEpisode`).
  The gap is behavioral: on provider error or unparseable JSON, `buildSynthesis` persists a
  `fallback` message with the local synthesis and returns it, and `WeeklyReviewPage`
  overwrites the last-good result it had just loaded. No new table is needed for item 3.
- RescueTime has no persistence (`docs/reviews-and-goals.md` says scores "are not
  persisted"). Item 1 needs a new table: migration id 34 (33 is the current max).
- `WeeklyReviewPage` hides the goals list whenever `fetchError` is set, and the standing
  objectives block has the same `fetchError ? banner : list` pattern. Both must change or a
  cached recovery renders nothing.

## 1. RescueTime snapshot cache

**Migration 34 `create_rescuetime_snapshot_cache`** (append-only, after id 33):

```sql
CREATE TABLE IF NOT EXISTS rescuetime_snapshot_cache (
  week_start_date TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'goals' | 'pulse' | 'objective_seconds'
  credential_fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (week_start_date, kind, credential_fingerprint)
);
```

Repository contract (`src/lib/storage/repository.ts`, implemented in both
`TauriSqliteRepository` and `MemoryRepository`):

- `getRescueTimeSnapshotCache(weekStartDate, kind, credentialFingerprint)` → `{ weekStartDate, kind, credentialFingerprint, payloadJson, fetchedAt } | null`
- `saveRescueTimeSnapshotCache(entry)` → upsert (`ON CONFLICT(week_start_date, kind, credential_fingerprint) DO UPDATE`).
  `fetchedAt` is supplied by the caller (services use `nowIso()`); no clock in the repository.
- `MemoryRepository` uses a `Map` keyed `${weekStartDate}:${kind}:${credentialFingerprint}`; non-persistent.
- Add the types to `src/domain/types.ts`.

**Credential scoping.** Entries belong to the RescueTime account that produced them.

- `credentialFingerprint` is a truncated SHA-256 (Web Crypto, hex, ~16 chars) of the API
  key, computed by a small helper in `src/lib/rescuetime/`. The raw key is never stored,
  logged, or used as a cache key.
- Services compute the fingerprint from the key **captured at the start of the pull** and
  use that same value for the write. Reads use the fingerprint of the *current* key. A late
  write from a superseded key therefore lands under the old fingerprint and can never be
  served for the new key; no invalidation race exists.
- Changing the key in Settings additionally deletes entries whose fingerprint differs from
  the new one (housekeeping via a `pruneRescueTimeSnapshotCache(keepFingerprint)` repository
  method, both implementations). Correctness does not depend on it.

**Payloads** (read defensively; a parse failure is treated as "no cache"):

- `goals`: goal items minus `achievement` (`goalId, title, isMore, actualHours,
  weeklyTargetHours, scheduleLabel`). `achievement` is recomputed on read via the existing
  scoring functions so formula changes apply to cached data.
- `pulse`: `{ pulse: number | null }`. `null` (no tracked time) and `0` are cacheable and
  must be distinguishable from "no cache row".
- `objective_seconds`: `Record<objectiveId, { seconds, fetchedAt }>`. Each value keeps the
  time of the pull that actually produced it; the row-level `fetched_at` is only the last
  write time and is never used to date individual values.

**Write rules**

- Only after a successful pull, in its own `try/catch` so a cache-write failure never fails
  the pull.
- `goals`: write even when the list is empty (the user may have deleted all goals).
- `objective_seconds`: merge freshly resolved ids (stamped with the new `fetchedAt`) into
  the existing cached map (same fingerprint) so a run where one taxonomy group fails does
  not erase good entries for other groups, and retained entries keep their original
  `fetchedAt` (never re-dated).

**Read rules**

- Read the cache only when `rescuetimeConfigured` is true, the live pull failed, and only entries matching the current key's fingerprint.
  Removing the API key shows the missing-key state, never cached numbers.
- Add optional `cachedAt?: string` to `RescueTimeGoalsSnapshot`
  (`src/domain/rescuetime-goals.ts`), `RescueTimeProductivityPulseSnapshot`, and
  `WeeklyObjectivesSnapshot` (`src/domain/types.ts`), threaded through
  `computeRescueTimeGoalsSnapshot` / `buildWeeklyObjectivesSnapshot` options.
- `RescueTimeGoalsService.computeGoalsSnapshot` catch branch: load cache; if present,
  rebuild the snapshot from cached items with `cachedAt` and drop `fetchError`; otherwise
  keep current behavior (`items: []` + `fetchError`).
- `computeProductivityPulse` catch branch: same shape.
- `WeeklyObjectivesService`: per failing kind group, fill `secondsByObjectiveId` from the
  cached map, delete those ids from `errorsByObjectiveId`, set `cachedAt` to the **oldest**
  `fetchedAt` among the entries actually reused (conservative: the notice never claims
  fresher data than the stalest value shown); keep snapshot-level `fetchError` only if at least one objective is still
  unresolved.

**UI (`src/pages/WeeklyReviewPage.tsx`)**

- Goals list renders whenever `items.length > 0`, independent of `fetchError`; the empty
  copy shows only for `items.length === 0 && !fetchError`.
- Standing objectives: render the banner and the list (relax the current `fetchError ? banner : list`, ~line 1071).
- When `cachedAt` is set, show `weekly.rescueGoals.cachedNotice` (`formatTimestamp(cachedAt)`);
  the "Source" status card shows `weekly.rescueGoals.source.cache`.
- Cached values keep feeding `applyWeeklyScoreExternalAxes` and the AI snapshot inputs
  (intentional; keeps `inputHash` stable during an outage). State this in the docs.

## 2. Compact RescueTime goal lines

Replace the `div.weekly-day-grid` / `article.schedule-day-group` block with one line per goal:

```tsx
<ul className="rescue-goal-lines">
  {items.map((item) => (
    <li key={item.goalId}>
      <span className="rescue-goal-lines__title">{item.title}</span>
      <span className="rescue-goal-lines__time">
        {t("weekly.rescueGoals.compactLine", {
          actual: formatHours(item.actualHours),
          target: formatHours(item.weeklyTargetHours),
          direction: item.isMore ? "≥" : "≤",
        })}
      </span>
      <span className="rescue-goal-lines__score">{formatPercent(item.achievement)}</span>
    </li>
  ))}
</ul>
```

- Keep the `≥`/`≤` marker: without it a "less time" goal reading `2.00 h / 1.00 h · 50%` is ambiguous.
- Retire `weekly.rescueGoals.timeLine` and `weekly.rescueGoals.schedule` in
  `src/locales/fr/reviews.json`; drop `direction.more`/`direction.less` only if unused
  (grep first; currently only `WeeklyReviewPage.tsx` ~1051–1060). Add `compactLine`,
  `cachedNotice`, `source.cache`.
- Styles in `src/styles.css` next to `.weekly-day-grid`, including the mobile breakpoint (~line 1676).

## 3. Weekly coach cache (last-good fallback)

In `buildSynthesis` (`src/lib/ai/weekly-synthesis-service.ts`) add:

```ts
const lastGoodResult = async (repository, scopeKey) => {
  const latest = await repository.getLatestAiMessage("weekly_synthesis", scopeKey, "ok");
  if (!latest) return null;
  const result = await cachedResult(repository, latest);
  return result ? { ...result, source: "cache" as const } : null;
};
```

Apply in exactly two places: the unparseable-after-repair branch and the provider-throw catch.

1. Resolve `lastGoodResult`.
2. If it exists: persist the failure record with `repository.saveAiMessage(message)`
   (status `fallback`, local body, no proposals) in its **own `try/catch`** — the write is
   best effort. A rejected write (e.g. full disk) is swallowed (never logging the API key
   or prompt content) and the resolved last-good result is still returned with
   `source: "cache"` and `warning` (parse error / provider message).
3. If not: current behavior unchanged (`persistResult`, `source: "fallback"`).

Explicitly not changed:

- The `!bypassCache` lookup keeps using `getAiMessage` (ok-only), so a failed run never
  suppresses a retry; preserves `weekly-synthesis-service.test.ts` "retries after a
  persisted fallback instead of treating it as cache".
- The `!aiConfigured` path still returns the local `skipped` synthesis (disabling AI shows
  the local guide).
- `weekly-synthesis-loader.ts` is untouched (its `sourceFromMessage` `ok` branch is unreachable).
- Regenerate (`bypassCache`) still calls the provider; if it fails, the last-good result
  shows with the warning line and the `coach.source.cache` badge.

## Tests

- `src/lib/storage/migrations/rescuetime-snapshot-cache.test.ts`: migration 34 exists, name, `CREATE TABLE` in SQL (mirror `weekly-objective-starts-on.test.ts`).
- `memory-repository.test.ts`: round trip, upsert overwrite, miss returns `null`, entries isolated per fingerprint, prune keeps only the given fingerprint.
- `rescuetime-goals-service.test.ts`: cache written on success; fallback with `cachedAt` and no `fetchError` on throw; no cache → current `fetchError` behavior; unconfigured key never reads cache; **A → B key change: a failed pull with key B never returns A's entries, and a slow pull that resolves for key A after the switch does not become visible to B**; pulse `null` and `0` round-trip.
- `weekly-objectives-service.test.ts`: one kind group fails and is served from cache while another succeeds; merge does not erase other entries; **timestamp provenance: category values last fetched Monday stay dated Monday across successive activity refreshes, and `cachedAt` is the oldest reused `fetchedAt`**; residual `fetchError` when an id has no cache entry.
- `weekly-synthesis-service.test.ts`: provider throw with a prior `ok` returns it with `source: "cache"` + warning and persists a proposal-less fallback row; same for unparseable-after-repair; **a rejected `saveAiMessage` during provider failure still returns the last-good result and warning**; no prior `ok` → unchanged `fallback`; existing retry-after-fallback test still passes.
- `WeeklyReviewPage.test.tsx`: replace the `"0.25/1"` assertion with the percent form; one compact line per goal; goals list renders with a cached notice when `cachedAt` is set; standing list renders alongside a partial `fetchError`.

## Docs

- `docs/reviews-and-goals.md`: replace "not persisted" (~line 149) with the cache contract and the compact line format.
- `docs/storage-and-backups.md`: migration 34 row + table bullet.
- `docs/ai-settings-and-privacy.md`: last-good weekly synthesis reuse; RescueTime goal titles are now stored at rest, scoped by a key fingerprint (the API key itself is not); browser-preview cache is in-memory only.
- Prepend entries to `docs/logs/reviews-and-goals.md` and `docs/logs/ai-settings-and-privacy.md`.
- Keep `AGENTS.md` / `CLAUDE.md` byte-identical (no change needed).

## Gates

`npm run verify` (or at minimum `npm run test` and `npm run build`). No Rust changes.

## Watch during implementation

While the provider is down, each weekly-page visit still makes one provider call and writes
one `fallback` row. This is intentional (self-healing). If row volume gets noisy, skip
persisting the failure row when the scope's latest message is already an identical
failure — do not short-circuit the retry.
