import type { Database } from "../storage/sqlite-db";
import { loadAliases } from "./alias-store";
import { quoteIdent } from "./capture-install";
import { parseClocks, stampDirtyEntities } from "./capture-stamp";
import type { SyncConflictRow } from "./change-set";
import { issueHlc } from "./clock-store";
import type { SyncConflictResolution } from "./conflicts";
import { bumpChangeCounterSql } from "./domain-counters";
import { SyncApplyError } from "./errors";
import { canonicalJson, jsonDeepEqual } from "./field-clocks";
import { compareHlc } from "./hlc";
import { LIFECYCLE_FIELDS } from "./merge-task";
import { entityIdOf, parseEntityId } from "./entity-id";
import {
  getTableRegistration,
  publishDomainOfEntityType,
  SETTING_ENTITY_TYPE,
  type SyncDomain,
} from "./registry";
import { publishFilterSql } from "./row-filter";
import { rewriteReferences, rewriteSyncRow, type Resolver } from "./reference-rewrite";
import { readTableInfo } from "./table-info";
import { assertDomainAllowedFor, readStoredProfile } from "./profile-guard";
import type { RowRules } from "./merge-row";
import { conflictPayloadIsPublishable } from "./conflict-privacy";
import { isTerminalSessionStatus } from "./row-filter";
import { isCalendarDateKey } from "./recurrence-occurrences";

/** The resolution carries the selected value itself: local/remote is meaningful only to its chooser. */
type Decision =
  | { action: "dismiss" }
  | {
      action: "choose";
      value: Record<string, unknown>;
      local: Record<string, unknown>;
      remote: Record<string, unknown>;
    }
  | { action: "rename"; name: string; row: Record<string, unknown> | null };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseObject = (text: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(text);
  if (!object(parsed)) throw new Error("Conflict value is not a record");
  return parsed;
};

/** Rewrite aliasable ids and references embedded in composite primary keys. */
export const canonicalConflictEntityId = (table: string, id: string, resolve: Resolver): string => {
  if (table === SETTING_ENTITY_TYPE) return id;
  const key = parseEntityId(table, id);
  if (key === null) throw new Error("Invalid conflict entity id");
  const columns = getTableRegistration(table).primaryKey;
  const row: Record<string, unknown> = Object.create(null);
  columns.forEach((column, index) => {
    Object.defineProperty(row, column, {
      value: key[index],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });
  const rewritten = rewriteSyncRow(table, row, resolve) ?? row;
  return entityIdOf(
    table,
    columns.map((column) => rewritten[column]),
  );
};

const readConflict = async (db: Database, id: string): Promise<SyncConflictRow | undefined> =>
  (await db.select<SyncConflictRow[]>("SELECT * FROM sync_conflicts WHERE id = $1", [id]))[0];

/** Stored user decisions rank ahead of the provisional terminal tie-break. */
export const resolvedTerminalStatuses = async (
  db: Database,
  table: string,
): Promise<Map<string, string>> => {
  const rows = await db.select<SyncConflictRow[]>(
    "SELECT * FROM sync_conflicts WHERE entity_type = $1 AND kind = 'terminal_divergence' AND resolution_hlc IS NOT NULL ORDER BY resolution_hlc",
    [table],
  );
  const statuses = new Map<string, string>();
  for (const row of rows) {
    const decision: unknown = JSON.parse(row.resolution as string);
    if (
      object(decision) &&
      decision.action === "choose" &&
      object(decision.value) &&
      typeof decision.value.status === "string"
    )
      statuses.set(row.entity_id, decision.value.status);
  }
  return statuses;
};

export const rulesWithResolvedStatus = (rules: RowRules, status: string | undefined): RowRules => {
  if (status === undefined) return rules;
  return {
    ...rules,
    rank: (a, b) => {
      const chosenA = a.row.status === status;
      const chosenB = b.row.status === status;
      if (chosenA !== chosenB) return chosenA ? 1 : -1;
      return rules.rank?.(a, b) ?? 0;
    },
  };
};

const decisionFor = (conflict: SyncConflictRow, resolution: SyncConflictResolution): Decision => {
  if (resolution.action === "dismiss") {
    if (conflict.kind === "terminal_divergence" || conflict.kind === "name_collision") {
      throw new Error("This conflict requires a decision");
    }
    return { action: "dismiss" };
  }
  if (resolution.action === "rename") {
    if (conflict.kind !== "name_collision" || conflict.entity_type !== "gtd_contexts") {
      throw new Error("This conflict cannot be resolved by renaming");
    }
    const name = resolution.name.trim();
    if (!name) throw new Error("A context name is required");
    const remote = parseObject(conflict.remote_json);
    if (object(remote.row) && remote.row.id !== conflict.entity_id)
      throw new Error("Context row does not match the conflict");
    return { action: "rename", name, row: object(remote.row) ? remote.row : null };
  }
  if (
    resolution.action !== "choose" ||
    (resolution.side !== "local" && resolution.side !== "remote")
  )
    throw new Error("Invalid conflict action");
  if (conflict.kind !== "terminal_divergence")
    throw new Error("This conflict has no terminal choice");
  const local = parseObject(conflict.local_json);
  const remote = parseObject(conflict.remote_json);
  const value = resolution.side === "local" ? local : remote;
  if (conflict.entity_type === "gtd_tasks") {
    const status = value.status ?? value.outcome;
    if (status !== "completed" && status !== "cancelled") throw new Error("Invalid task decision");
    if (Object.hasOwn(value, "outcome")) {
      if (
        typeof value.template_id !== "string" ||
        !isCalendarDateKey(value.due_date) ||
        conflict.entity_id !== `recurring-task:${value.template_id}`
      )
        throw new Error("Ambiguous recurring occurrence");
      if (
        value.task !== null &&
        value.task !== undefined &&
        (!object(value.task) ||
          value.task.id !== conflict.entity_id ||
          value.task.recurrence_due_date !== value.due_date ||
          value.task.status !== status ||
          (status === "completed" && typeof value.task.completed_at !== "string"))
      )
        throw new Error("Invalid recurring occurrence evidence");
    } else if (!LIFECYCLE_FIELDS.every((field) => Object.hasOwn(value, field))) {
      throw new Error("Incomplete task decision");
    } else {
      const nullableString = (item: unknown) => item === null || typeof item === "string";
      if (
        ![
          "inbox",
          "next_action",
          "scheduled",
          "waiting_for",
          "someday_maybe",
          "reference",
          "planned",
        ].includes(String(value.bucket)) ||
        !nullableString(value.completed_at) ||
        !nullableString(value.scheduled_for) ||
        !nullableString(value.project_id) ||
        !(
          value.planned_order === null ||
          (typeof value.planned_order === "number" && Number.isFinite(value.planned_order))
        ) ||
        (status === "completed" && typeof value.completed_at !== "string") ||
        (status === "cancelled" && value.completed_at !== null)
      )
        throw new Error("Invalid task lifecycle tuple");
    }
  } else if (conflict.entity_type === "ai_proposals") {
    if (!["accepted", "dismissed", "expired"].includes(String(value.status)))
      throw new Error("Invalid proposal decision");
    if (
      value.id !== conflict.entity_id ||
      !(value.decided_at === null || typeof value.decided_at === "string") ||
      !(value.applied_entity_id === null || typeof value.applied_entity_id === "string")
    )
      throw new Error("Invalid proposal decision row");
  } else if (conflict.entity_type === "finance_category_suggestions") {
    if (!["accepted", "corrected", "dismissed"].includes(String(value.status)))
      throw new Error("Invalid suggestion decision");
    if (
      value.id !== conflict.entity_id ||
      !(value.decided_at === null || typeof value.decided_at === "string")
    )
      throw new Error("Invalid suggestion decision row");
  } else throw new Error("This terminal conflict cannot be resolved here");
  return { action: "choose", value, local, remote };
};

/** An untrusted resolution must be a valid decision over the conflict the sender supplied. */
const validatedDecision = (conflict: SyncConflictRow): Decision => {
  if (conflict.resolution === null) throw new Error("Missing conflict resolution");
  const value: unknown = JSON.parse(conflict.resolution);
  if (!object(value)) throw new Error("Invalid conflict resolution");
  if (value.action === "dismiss") return decisionFor(conflict, { action: "dismiss" });
  if (value.action === "rename" && typeof value.name === "string") {
    if (value.row !== null && !object(value.row)) throw new Error("Invalid context resolution row");
    const expected = decisionFor(conflict, { action: "rename", name: value.name });
    if (!jsonDeepEqual(value, expected)) throw new Error("Invalid context resolution payload");
    return expected;
  }
  if (
    value.action === "choose" &&
    object(value.value) &&
    object(value.local) &&
    object(value.remote)
  ) {
    const local = parseObject(conflict.local_json);
    const remote = parseObject(conflict.remote_json);
    const evidenceMatches =
      (jsonDeepEqual(value.local, local) && jsonDeepEqual(value.remote, remote)) ||
      (jsonDeepEqual(value.local, remote) && jsonDeepEqual(value.remote, local));
    if (!evidenceMatches) throw new Error("Resolution evidence does not match the conflict");
    for (const side of ["local", "remote"] as const) {
      try {
        const expected = decisionFor(conflict, { action: "choose", side });
        if (expected.action === "choose" && jsonDeepEqual(value.value, expected.value))
          return value as Decision;
      } catch {
        // The other side may still be a valid choice.
      }
    }
  }
  throw new Error("Resolution does not match either conflict value");
};

/** Refuse filtered sidecars unless their owning row is locally eligible, including its parent. */
const assertEligible = async (db: Database, row: SyncConflictRow): Promise<void> => {
  if (row.entity_type === SETTING_ENTITY_TYPE) return;
  const filter = publishFilterSql(row.entity_type);
  if (filter === null) return;
  const key = parseEntityId(row.entity_type, row.entity_id);
  if (key === null) throw new Error("Invalid conflict entity id");
  const info = await readTableInfo(db, row.entity_type);
  const where = info.primaryKey
    .map((column, i) => `${quoteIdent(column)} = $${i + 1}`)
    .join(" AND ");
  const found = await db.select<Record<string, unknown>[]>(
    `SELECT 1 AS present FROM ${quoteIdent(row.entity_type)} WHERE ${where} AND (${filter})`,
    key,
  );
  if (!found.length)
    throw new SyncApplyError("row_filter_violation", "Conflict refers to an excluded row");
};

/** Apply a stored concrete decision. Returns whether a user row changed. */
const applyDecision = async (
  db: Database,
  conflict: SyncConflictRow,
  decision: Decision,
  nowMs: number,
): Promise<boolean> => {
  if (decision.action === "dismiss") return false;
  const aliases = (await loadAliases(db)).index;
  const id = canonicalConflictEntityId(conflict.entity_type, conflict.entity_id, (type, value) =>
    aliases.resolve(type, value),
  );
  const table = conflict.entity_type;
  if (conflict.resolution_hlc !== null) {
    const meta = (
      await db.select<{ deleted_at: string | null }[]>(
        "SELECT deleted_at FROM sync_entity_meta WHERE entity_type = $1 AND entity_id = $2",
        [table, id],
      )
    )[0];
    if (meta?.deleted_at && compareHlc(meta.deleted_at, conflict.resolution_hlc) > 0) return false;
  }
  if (decision.action === "rename") {
    if (table !== "gtd_contexts" || !decision.name.trim())
      throw new Error("Invalid context resolution");
    const rows = await db.select<Record<string, unknown>[]>(
      "SELECT * FROM gtd_contexts WHERE id = $1",
      [id],
    );
    if (rows.length && rows[0]?.name !== decision.name && conflict.resolution_hlc !== null) {
      const meta = (
        await db.select<{ field_clocks_json: string }[]>(
          "SELECT field_clocks_json FROM sync_entity_meta WHERE entity_type = 'gtd_contexts' AND entity_id = $1 AND deleted_at IS NULL",
          [id],
        )
      )[0];
      const nameClock = meta ? parseClocks(meta.field_clocks_json).name : undefined;
      if (nameClock !== undefined && compareHlc(nameClock, conflict.resolution_hlc) > 0)
        return false;
    }
    const holder = await db.select<{ id: string }[]>(
      "SELECT id FROM gtd_contexts WHERE name = $1 AND id <> $2",
      [decision.name, id],
    );
    if (holder.length) throw new Error("Context name is already in use");
    if (!rows.length) {
      const source = decision.row;
      if (!source || typeof source.created_at !== "string" || typeof source.updated_at !== "string")
        throw new Error("The discarded context row is unavailable");
      await db.execute(
        "INSERT INTO gtd_contexts (id, name, created_at, updated_at) VALUES ($1, $2, $3, $4)",
        [id, decision.name, source.created_at, source.updated_at],
      );
    } else {
      if (rows[0]?.name === decision.name) return false;
      await db.execute("UPDATE gtd_contexts SET name = $1 WHERE id = $2", [decision.name, id]);
    }
  } else if (table === "gtd_tasks" && Object.hasOwn(decision.value, "outcome")) {
    const value = decision.value;
    const template = value.template_id;
    const due = value.due_date;
    const outcome = value.outcome;
    if (
      typeof template !== "string" ||
      typeof due !== "string" ||
      (outcome !== "completed" && outcome !== "cancelled") ||
      id !== `recurring-task:${template}`
    )
      throw new Error("Invalid recurring occurrence decision");
    const previous = (
      await db.select<{ outcome: string }[]>(
        "SELECT outcome FROM sync_recurrence_occurrences WHERE template_id = $1 AND due_date = $2",
        [template, due],
      )
    )[0];
    if (!previous) throw new Error("The recurring occurrence no longer exists");
    const tasks = await db.select<Record<string, unknown>[]>(
      "SELECT status, completed_at, recurrence_due_date FROM gtd_tasks WHERE id = $1",
      [id],
    );
    const task = tasks[0];
    let completedAt: unknown = null;
    if (outcome === "completed" && task?.recurrence_due_date === due) {
      const chosenTask = object(value.task) ? value.task : null;
      completedAt =
        chosenTask?.completed_at ?? (task.status === "completed" ? task.completed_at : null);
      if (typeof completedAt !== "string")
        throw new Error("The completed occurrence's timestamp is unavailable");
    }
    const taskChanged =
      task?.recurrence_due_date === due &&
      (task.status !== outcome || task.completed_at !== completedAt);
    if (previous.outcome === outcome && !taskChanged) return false;
    if (previous.outcome !== outcome) {
      const hlc = await issueHlc(db, nowMs);
      const device = (
        await db.select<{ device_id: string }[]>("SELECT device_id FROM sync_identity WHERE id = 1")
      )[0]?.device_id;
      await db.execute(
        "UPDATE sync_recurrence_occurrences SET outcome = $1, outcome_hlc = $2, device_id = $3 WHERE template_id = $4 AND due_date = $5",
        [outcome, hlc, device, template, due],
      );
    }
    if (taskChanged) {
      await db.execute("UPDATE gtd_tasks SET status = $1, completed_at = $2 WHERE id = $3", [
        outcome,
        completedAt,
        id,
      ]);
      await db.execute(
        "INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id, op) VALUES ('gtd_tasks', $1, 'upsert')",
        [id],
      );
      await stampDirtyEntities(db, nowMs);
    }
    return true;
  } else {
    const allowed =
      table === "gtd_tasks"
        ? [...LIFECYCLE_FIELDS]
        : table === "ai_proposals"
          ? ["status", "decided_at", "applied_entity_id"]
          : table === "finance_category_suggestions"
            ? ["status", "decided_at"]
            : [];
    if (!allowed.length) throw new Error("Unsupported conflict resolution");
    const current = (
      await db.select<Record<string, unknown>[]>(
        `SELECT * FROM ${quoteIdent(table)} WHERE id = $1`,
        [id],
      )
    )[0];
    if (!current) throw new Error("The conflicted row no longer exists");
    const rewritten =
      rewriteReferences(table, decision.value, (type, value) => aliases.resolve(type, value)) ??
      decision.value;
    const fields = allowed.filter((field) => Object.hasOwn(rewritten, field));
    if (!fields.includes("status")) throw new Error("Missing terminal status");
    if (fields.every((field) => jsonDeepEqual(current[field] ?? null, rewritten[field] ?? null)))
      return false;
    await db.execute(
      `UPDATE ${quoteIdent(table)} SET ${fields.map((field, index) => `${quoteIdent(field)} = $${index + 1}`).join(", ")} WHERE id = $${fields.length + 1}`,
      [...fields.map((field) => rewritten[field] ?? null), id],
    );
  }
  await db.execute(
    "INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id, op) VALUES ($1, $2, 'upsert')",
    [table, id],
  );
  await stampDirtyEntities(db, nowMs);
  return true;
};

/** Resolve under the repository writer transaction. Never acknowledges an unapplied choice. */
export const resolveConflict = async (
  db: Database,
  id: string,
  resolution: SyncConflictResolution,
  nowMs: number,
): Promise<void> => {
  const conflict = await readConflict(db, id);
  if (!conflict) throw new Error("Conflict not found");
  assertDomainAllowedFor(
    await readStoredProfile(db),
    publishDomainOfEntityType(conflict.entity_type, conflict.entity_id),
  );
  if (conflict.resolution_hlc !== null) throw new Error("Conflict is already resolved");
  const decision = decisionFor(conflict, resolution);
  await applyDecision(db, conflict, decision, nowMs);
  const clock = await issueHlc(db, nowMs);
  await db.execute(
    "UPDATE sync_conflicts SET resolved_at = $1, resolution = $2, resolution_hlc = $3 WHERE id = $4",
    [new Date(nowMs).toISOString(), canonicalJson(decision), clock, id],
  );
  await db.execute(
    bumpChangeCounterSql(
      [publishDomainOfEntityType(conflict.entity_type, conflict.entity_id)],
      "1",
    ),
  );
};

/** Merge a peer's queue by stable id and latest resolution clock. */
export const mergeIncomingConflicts = async (
  db: Database,
  rows: readonly SyncConflictRow[],
  domain: SyncDomain,
  nowMs: number,
): Promise<number> => {
  const aliases = (await loadAliases(db)).index;
  const sessions = rows.some((row) => row.entity_type === "pomodoro_segments")
    ? await db.select<{ id: string; status: string }[]>("SELECT id, status FROM pomodoro_sessions")
    : [];
  const terminalSessions = new Set(
    sessions
      .filter((session) => isTerminalSessionStatus(session.status))
      .map((session) => session.id),
  );
  let changed = 0;
  for (const incoming of rows) {
    if (!conflictPayloadIsPublishable(incoming, terminalSessions)) {
      throw new SyncApplyError(
        "row_filter_violation",
        "Conflict contains a filtered historical value",
      );
    }
    const row = {
      ...incoming,
      entity_id: canonicalConflictEntityId(
        incoming.entity_type,
        incoming.entity_id,
        (type, value) => aliases.resolve(type, value),
      ),
    };
    await assertEligible(db, row);
    if (row.resolution_hlc !== null) validatedDecision(row);
    const previous = await readConflict(db, row.id);
    if (
      previous &&
      (previous.entity_type !== row.entity_type ||
        canonicalConflictEntityId(previous.entity_type, previous.entity_id, (type, value) =>
          aliases.resolve(type, value),
        ) !== row.entity_id ||
        previous.kind !== row.kind)
    )
      throw new Error("Conflicting conflict identity");
    if (!previous) {
      await db.execute(
        `INSERT INTO sync_conflicts (id, entity_type, entity_id, kind, local_json, remote_json, detected_at, resolved_at, resolution, resolution_hlc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          row.id,
          row.entity_type,
          row.entity_id,
          row.kind,
          row.local_json,
          row.remote_json,
          row.detected_at,
          row.resolved_at,
          row.resolution,
          row.resolution_hlc,
        ],
      );
      changed++;
    } else if (
      row.resolution_hlc !== null &&
      (previous.resolution_hlc === null ||
        compareHlc(row.resolution_hlc, previous.resolution_hlc) > 0)
    ) {
      await db.execute(
        "UPDATE sync_conflicts SET resolved_at = $1, resolution = $2, resolution_hlc = $3 WHERE id = $4",
        [row.resolved_at, row.resolution, row.resolution_hlc, row.id],
      );
      changed++;
    } else if (
      row.resolution_hlc !== null &&
      row.resolution_hlc === previous.resolution_hlc &&
      row.resolution !== previous.resolution
    ) {
      throw new Error("A resolution clock identifies different decisions");
    }
  }
  // A later stale bundle can undo a provisional terminal state, so enforce the stored decision again.
  const decided = await db.select<SyncConflictRow[]>(
    "SELECT * FROM sync_conflicts WHERE resolution_hlc IS NOT NULL ORDER BY resolution_hlc",
  );
  const latest = new Map<string, { conflict: SyncConflictRow; decision: Decision }>();
  for (const conflict of decided) {
    if (publishDomainOfEntityType(conflict.entity_type, conflict.entity_id) !== domain) continue;
    const parsed: unknown = JSON.parse(conflict.resolution as string);
    if (!object(parsed) || !["dismiss", "choose", "rename"].includes(String(parsed.action)))
      throw new Error("Invalid conflict resolution");
    const decision = parsed as Decision;
    if (decision.action === "dismiss") continue;
    const entity = canonicalConflictEntityId(
      conflict.entity_type,
      conflict.entity_id,
      (type, value) => aliases.resolve(type, value),
    );
    const occurrence =
      decision.action === "choose" && typeof decision.value.due_date === "string"
        ? decision.value.due_date
        : "";
    const key = JSON.stringify([conflict.entity_type, entity, occurrence]);
    latest.set(key, { conflict, decision });
  }
  for (const { conflict, decision } of latest.values()) {
    if (await applyDecision(db, conflict, decision, nowMs)) changed++;
  }
  return changed;
};
