import type { ForeignKeyEdge } from "./apply-references";
import { orderByReferences } from "./apply-references";
import type {
  SyncAlias,
  SyncChangeSet,
  SyncEntity,
  SyncRecurrenceClear,
  SyncRecurrenceOccurrence,
  SyncRow,
  SyncSettingEntry,
} from "./change-set";
import { entityIdOf } from "./entity-id";
import { getOwn } from "./field-clocks";
import { tableOrder } from "./merge-strategies";
import { getTableRegistration, TABLE_REGISTRY } from "./registry";
import {
  Groups,
  groupKeysOf,
  detachableUnits,
  NATURAL_KEY_PREFIX,
  QUEUE_KEY_PREFIX,
  sidecarTemplateIds,
  subOrderOf,
} from "./split-groups";

/**
 * Splits a large change set into an ordered list of smaller ones whose sequential application is
 * equivalent to applying the whole set once (`applyChunked`, `apply-chunked.ts`). Pure: nothing here
 * reads a database, so the plan is a function of the set and the limits alone.
 *
 * Why it can be done above the repository. `applySyncBundle` merges ONE change set atomically; every
 * merge rule is a join over what the database already holds, so a prefix of the pieces leaves the
 * database in a state a smaller bundle could have produced (every prefix is valid). What a join cannot
 * see is the other entities of the SAME call, so the splitter keeps together the entities that rules
 * read together and keeps the order of the ones that one call applies in a fixed order
 * (`split-groups.ts`).
 *
 * Order. Pieces follow the order `mergeAll` itself applies tables in:
 * 1. the aliases, by entity type in registry order, in slices;
 * 2. entity groups and grow-only-union rows, table by table in `orderByReferences` order: registry
 *    order, tasks last, a parent table before a child table, so a child never lands in an earlier
 *    chunk than its parent (the apply SKIPS a child whose parent is unknown). A group that spans
 *    tables is placed at its LAST table; inside one table the pieces follow `subOrderOf`;
 * 3. the settings, with the last chunk.
 *
 * Aliases first and settings last are CONVENTIONS, not requirements: one call already learns the
 * aliases before it merges any entity and applies the settings after them (`mergeAll`), so a mutation
 * that puts the settings in the first chunk, or lets an alias slice share a chunk with entities, does
 * not change any result. They are kept because a chunk that only learns aliases is cheap to reason
 * about and because the settings are the last thing a user sees change.
 *
 * The header (`deviceId`, `domain`, `schemaVersion`, `hlcHigh`) of every chunk is the original's:
 * `hlcHigh` stays an upper bound of every clock the chunk carries, and absorbing it again is a no-op
 * for the local clock.
 *
 * What stays whole, and the bound. A group is kept in one chunk (a group above `maxEntities` gets a
 * chunk of its own), up to `maxGroupEntities`; a larger group is cut into consecutive slices by id (a
 * template's sidecar rows beyond `maxSidecarRows` go in slices of their own before the entities).
 * `ChangeSetPlan.largestGroup`, `oversizedGroups` and `cutGroups` report it. The worst chunk is
 * therefore about `maxGroupEntities` entities (1,500 tasks measured at 1,619 statements), not the size
 * of the largest project.
 */

export interface ApplyLimits {
  /** Entities one chunk may hold (a group larger than this gets a chunk of its own, up to the cap below). */
  maxEntities: number;
  /** Rows of grow-only-union tables one chunk may hold. */
  maxUnionRows: number;
  /** Alias rows one chunk may hold. */
  maxAliases: number;
  /** Recurrence sidecar rows (occurrences and clear watermarks) one chunk may hold. */
  maxSidecarRows: number;
  /**
   * Hard cap on one group (see `split-groups.ts`): a group of more entities than this is cut into
   * consecutive slices by id, with the residual the module comment of `split-groups.ts` declares. It is
   * the worst-case chunk: groups up to this size are kept whole in a chunk of their own.
   */
  maxGroupEntities: number;
}

/**
 * Chosen from the measurements in `docs/storage-and-backups.md` (chunked apply): about these sizes
 * keep one writer slot well under the 15-second watchdog, with the per-statement cost of the Tauri
 * IPC counted.
 */
export const DEFAULT_APPLY_LIMITS: ApplyLimits = {
  maxEntities: 400,
  maxUnionRows: 4_000,
  maxAliases: 400,
  maxSidecarRows: 2_000,
  maxGroupEntities: 1_500,
};

export const resolveApplyLimits = (limits: Partial<ApplyLimits> | undefined): ApplyLimits => {
  const resolved = { ...DEFAULT_APPLY_LIMITS, ...limits };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`Invalid apply limit ${name}: expected a positive integer`);
    }
  }
  return resolved;
};

/**
 * The declared foreign keys between synced tables, from the registry (the pure twin of
 * `readForeignKeyEdges`, which reads them from the database; `registry.test.ts` checks that the two
 * agree on a migrated schema).
 */
export const declaredForeignKeyEdges = (): ForeignKeyEdge[] =>
  TABLE_REGISTRY.flatMap((entry) =>
    entry.references
      .filter((reference) => reference.kind === "foreign-key")
      .map((reference) => ({
        childTable: entry.table,
        childColumn: reference.column,
        parentTable: reference.table,
        parentColumn: getTableRegistration(reference.table).primaryKey[0] as string,
        onDelete: "CASCADE",
      })),
  );

export interface ChangeSetPlan {
  /** The chunks in the order to apply them; `[changeSet]` itself when it fits one chunk. */
  chunks: SyncChangeSet[];
  /** Entities of the largest group before the cap. */
  largestGroup: number;
  /** Groups that alone exceed a limit and therefore got a chunk of their own. */
  oversizedGroups: number;
  /** Groups above `maxGroupEntities` that were cut into slices. */
  cutGroups: number;
}

interface Piece {
  position: number;
  sortKey: string;
  /** Order among the pieces of one table position (`subOrderOf`). */
  sub: number;
  /** The piece holds a task, and a task of a project's queue. */
  hasTask: boolean;
  hasQueue: boolean;
  entities: SyncEntity[];
  unionRows: { table: string; row: SyncRow }[];
  aliases: SyncAlias[];
  occurrences: SyncRecurrenceOccurrence[];
  clears: SyncRecurrenceClear[];
  settings: SyncSettingEntry[];
}

const piece = (position: number, sortKey: string, parts: Partial<Piece> = {}): Piece => ({
  position,
  sortKey,
  sub: 1,
  hasTask: false,
  hasQueue: false,
  entities: [],
  unionRows: [],
  aliases: [],
  occurrences: [],
  clears: [],
  settings: [],
  ...parts,
});

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compareEntities = (a: SyncEntity, b: SyncEntity): number =>
  compareText(`${a.table}\u0000${a.entityId}`, `${b.table}\u0000${b.entityId}`);

const rank = (table: string): number => tableOrder(table) + (table === "gtd_tasks" ? 1000 : 0);

const sidecarRows = (changeSet: SyncChangeSet): number =>
  changeSet.recurrence.occurrences.length + changeSet.recurrence.clears.length;

const unionRowCount = (changeSet: SyncChangeSet): number =>
  Object.values(changeSet.unionRows).reduce((sum, rows) => sum + rows.length, 0);

const fitsOneChunk = (changeSet: SyncChangeSet, limits: ApplyLimits): boolean =>
  changeSet.entities.length <= limits.maxEntities &&
  unionRowCount(changeSet) <= limits.maxUnionRows &&
  changeSet.aliases.length <= limits.maxAliases &&
  sidecarRows(changeSet) <= limits.maxSidecarRows;

class ChunkBuilder {
  entities: SyncEntity[] = [];
  unionRows: Record<string, SyncRow[]> = {};
  unionCount = 0;
  aliases: SyncAlias[] = [];
  occurrences: SyncRecurrenceOccurrence[] = [];
  clears: SyncRecurrenceClear[] = [];
  settings: SyncSettingEntry[] = [];

  get empty(): boolean {
    return (
      this.entities.length === 0 &&
      this.unionCount === 0 &&
      this.aliases.length === 0 &&
      this.occurrences.length + this.clears.length === 0 &&
      this.settings.length === 0
    );
  }

  overflows(next: Piece, limits: ApplyLimits): boolean {
    return (
      (this.entities.length > 0 &&
        this.entities.length + next.entities.length > limits.maxEntities) ||
      (this.unionCount > 0 && this.unionCount + next.unionRows.length > limits.maxUnionRows) ||
      (this.aliases.length > 0 && this.aliases.length + next.aliases.length > limits.maxAliases) ||
      (this.occurrences.length + this.clears.length > 0 &&
        this.occurrences.length +
          this.clears.length +
          next.occurrences.length +
          next.clears.length >
          limits.maxSidecarRows)
    );
  }

  add(next: Piece): void {
    this.entities.push(...next.entities);
    for (const { table, row } of next.unionRows) {
      (this.unionRows[table] ??= []).push(row);
    }
    this.unionCount += next.unionRows.length;
    this.aliases.push(...next.aliases);
    this.occurrences.push(...next.occurrences);
    this.clears.push(...next.clears);
    this.settings.push(...next.settings);
  }

  build(header: SyncChangeSet): SyncChangeSet {
    return {
      formatVersion: header.formatVersion,
      deviceId: header.deviceId,
      domain: header.domain,
      schemaVersion: header.schemaVersion,
      hlcHigh: header.hlcHigh,
      entities: this.entities,
      unionRows: this.unionRows,
      settings: this.settings,
      recurrence: { occurrences: this.occurrences, clears: this.clears },
      aliases: this.aliases,
    };
  }
}

/** Positions of the tables of one set, in the order `mergeAll` would apply them. */
const tablePositions = (changeSet: SyncChangeSet): Map<string, number> => {
  const entityTables = new Set(changeSet.entities.map((entity) => entity.table));
  if (sidecarRows(changeSet) > 0) {
    // Sidecars make the apply visit the task and template tables even with no entity of theirs.
    entityTables.add("gtd_tasks");
    entityTables.add("recurring_task_templates");
  }
  const unionTables = Object.keys(changeSet.unionRows);
  const order = orderByReferences(
    [
      ...[...entityTables].sort((a, b) => rank(a) - rank(b)),
      ...[...unionTables].sort((a, b) => tableOrder(a) - tableOrder(b)),
    ],
    declaredForeignKeyEdges(),
  );
  return new Map(order.map((table, index) => [table, index]));
};

const idOfRow = (table: string, row: SyncRow): string =>
  entityIdOf(
    table,
    getTableRegistration(table).primaryKey.map((column) => getOwn(row, column)),
  );

/**
 * Cuts a group, but only where cutting is safe:
 * - the DETACHABLE entities (tasks tied to the group only by their project's queue) go in slices of
 *   `maxGroupEntities`, in id order, before the rest;
 * - everything else (the CORE: a template with its instance, anything tied by a natural key) stays in
 *   ONE slice, the last, together with the sidecar rows, so the recompute that follows them sees every
 *   row and every task of the group was merged first;
 * - occurrence rows beyond `maxSidecarRows` go in slices of their own before the core (they are joins);
 * - groups with no detachable entity (transactions with splits, objectives with results, sessions
 *   with segments, account snapshots) are never passed here for their entities: they stay whole.
 */
const cutGroup = (
  group: Piece,
  limits: ApplyLimits,
  pad: (n: number) => string,
  keysOf: (entity: SyncEntity) => readonly string[],
): Piece[] => {
  const keyOf = (id: string, part: number): string =>
    `${pad(group.position)}\u0000${group.sub}\u0000${id}\u0000${pad(part)}`;
  const slices: Piece[] = [];
  const firstId = group.entities[0]?.entityId ?? group.occurrences[0]?.template_id ?? "";
  const overflow = Math.max(0, group.occurrences.length - limits.maxSidecarRows);
  for (let start = 0; start < overflow; start += limits.maxSidecarRows) {
    slices.push(
      piece(group.position, keyOf(firstId, slices.length), {
        sub: group.sub,
        occurrences: group.occurrences.slice(
          start,
          Math.min(overflow, start + limits.maxSidecarRows),
        ),
      }),
    );
  }
  const { detachable, core } =
    group.entities.length > limits.maxGroupEntities
      ? detachableUnits(group.entities, keysOf)
      : { detachable: [], core: group.entities };
  // Whole units are packed into slices of at most `maxGroupEntities` (a unit that is larger than the
  // cap alone gets a slice of its own); a unit is never split.
  const packed: SyncEntity[][] = [];
  let open: SyncEntity[] = [];
  for (const unit of detachable) {
    if (open.length > 0 && open.length + unit.length > limits.maxGroupEntities) {
      packed.push(open);
      open = [];
    }
    open.push(...unit);
  }
  if (open.length > 0) packed.push(open);
  for (const entities of packed) {
    entities.sort(compareEntities);
    slices.push(
      piece(group.position, keyOf(firstId, slices.length), {
        sub: group.sub,
        entities,
      }),
    );
  }
  slices.push(
    piece(group.position, keyOf(firstId, slices.length), {
      sub: group.sub,
      entities: core,
      occurrences: group.occurrences.slice(overflow),
      clears: group.clears,
    }),
  );
  return slices.filter(
    (slice) => slice.entities.length + slice.occurrences.length + slice.clears.length > 0,
  );
};

export const planChangeSet = (
  changeSet: SyncChangeSet,
  limitsInput?: Partial<ApplyLimits>,
): ChangeSetPlan => {
  const limits = resolveApplyLimits(limitsInput);
  if (fitsOneChunk(changeSet, limits)) {
    return {
      chunks: [changeSet],
      largestGroup: changeSet.entities.length,
      oversizedGroups: 0,
      cutGroups: 0,
    };
  }
  const positions = tablePositions(changeSet);
  const pad = (n: number): string => String(n).padStart(6, "0");
  const lastTablePosition = positions.size;

  // ---- Groups of entities that must stay together -------------------------------------------
  const groups = new Groups();
  const rawKeys = changeSet.entities.map((entity) => groupKeysOf(entity));
  // A natural key that no other entity of the set shares ties nothing: it must not make its task
  // inseparable from the rest of the project's queue (imported tasks each carry their own external id).
  const keyCounts = new Map<string, number>();
  for (const keys of rawKeys) {
    for (const key of keys)
      if (key.startsWith(NATURAL_KEY_PREFIX)) {
        keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
      }
  }
  const keysOf = rawKeys.map((keys) =>
    keys.filter((key) => !key.startsWith(NATURAL_KEY_PREFIX) || (keyCounts.get(key) ?? 0) > 1),
  );
  const keysByEntity = new Map(
    changeSet.entities.map((entity, index) => [entity, keysOf[index] as string[]]),
  );
  for (const keys of keysOf) groups.join(keys);
  const sidecarTemplates = sidecarTemplateIds(changeSet);
  for (const id of sidecarTemplates) groups.join([`template:${id}`]);

  const pieces = new Map<string, Piece>();
  const solo: Piece[] = [];
  const ensure = (representative: string): Piece => {
    let found = pieces.get(representative);
    if (found === undefined) {
      found = piece(-1, "");
      pieces.set(representative, found);
    }
    return found;
  };
  changeSet.entities.forEach((entity, index) => {
    const position = positions.get(entity.table) as number;
    const keys = keysOf[index] as string[];
    const target =
      keys.length === 0
        ? (() => {
            const single = piece(position, "");
            single.sub = subOrderOf(entity, false);
            solo.push(single);
            return single;
          })()
        : ensure(groups.representative(keys[0] as string));
    if (entity.table === "gtd_tasks") target.hasTask = true;
    if (keys.some((key) => key.startsWith(QUEUE_KEY_PREFIX))) target.hasQueue = true;
    target.entities.push(entity);
    target.position = Math.max(target.position, position);
  });
  for (const occurrence of changeSet.recurrence.occurrences) {
    ensure(groups.representative(`template:${occurrence.template_id}`)).occurrences.push(
      occurrence,
    );
  }
  for (const clear of changeSet.recurrence.clears) {
    ensure(groups.representative(`template:${clear.template_id}`)).clears.push(clear);
  }
  const taskPosition = positions.get("gtd_tasks") ?? lastTablePosition;
  const body: Piece[] = [];
  let largestGroup = 0;
  let cutGroups = 0;
  for (const group of [...pieces.values(), ...solo]) {
    if (group.occurrences.length + group.clears.length > 0) {
      group.position = Math.max(group.position, taskPosition);
    }
    // A grouped piece with a task and no queue key (a natural-key or template group) leaves queues
    // first too; solo pieces were ordered when they were made.
    if (group.entities.length > 0 && group.hasTask && !group.hasQueue && group.sub === 1) {
      group.sub = 0;
    }
    group.entities.sort(compareEntities);
    const first = group.entities[0];
    const firstId = first
      ? first.entityId
      : (group.occurrences[0]?.template_id ?? group.clears[0]?.template_id ?? "");
    group.sortKey = `${pad(group.position)}\u0000${group.sub}\u0000${firstId}`;
    largestGroup = Math.max(largestGroup, group.entities.length);
    // A large group is cut where its tasks are tied only by their project's queue (a group without a
    // queue key is one connected component and has nothing to cut).
    const cutEntities = group.entities.length > limits.maxGroupEntities && group.hasQueue;
    if (cutEntities || group.occurrences.length > limits.maxSidecarRows) {
      cutGroups += 1;
      body.push(...cutGroup(group, limits, pad, (entity) => keysByEntity.get(entity) ?? []));
    } else {
      body.push(group);
    }
  }

  // ---- Grow-only-union rows, by table, in id order -------------------------------------------
  for (const [table, rows] of Object.entries(changeSet.unionRows)) {
    const position = positions.get(table) as number;
    const sorted = rows
      .map((row) => ({ row, id: idOfRow(table, row) }))
      .sort((a, b) => compareText(a.id, b.id));
    for (let start = 0; start < sorted.length; start += limits.maxUnionRows) {
      const slice = sorted.slice(start, start + limits.maxUnionRows);
      body.push(
        piece(position, `${pad(position)}\u00001\u0000${slice[0]?.id ?? ""}`, {
          unionRows: slice.map(({ row }) => ({ table, row })),
        }),
      );
    }
  }
  body.sort((a, b) => compareText(a.sortKey, b.sortKey));

  // ---- Aliases first, settings last ------------------------------------------------------------
  const aliases = [...changeSet.aliases].sort(
    (a, b) =>
      tableOrder(a.entity_type) - tableOrder(b.entity_type) || compareText(a.alias_id, b.alias_id),
  );
  const head: Piece[] = [];
  for (let start = 0; start < aliases.length; start += limits.maxAliases) {
    head.push(piece(-1, pad(start), { aliases: aliases.slice(start, start + limits.maxAliases) }));
  }

  // ---- Pack ----------------------------------------------------------------------------------
  let oversizedGroups = 0;
  for (const item of body) {
    if (
      item.entities.length > limits.maxEntities ||
      item.occurrences.length + item.clears.length > limits.maxSidecarRows
    ) {
      oversizedGroups += 1;
    }
  }
  const chunks: ChunkBuilder[] = [];
  let current = new ChunkBuilder();
  const flush = (): void => {
    if (!current.empty) chunks.push(current);
    current = new ChunkBuilder();
  };
  for (const item of head) {
    if (current.overflows(item, limits)) flush();
    current.add(item);
  }
  // Aliases are learned before anything that names them: a chunk of its own, never shared.
  if (!current.empty) flush();
  for (const item of body) {
    if (current.overflows(item, limits)) flush();
    current.add(item);
  }
  current.settings.push(...changeSet.settings);
  flush();

  if (chunks.length <= 1) {
    return { chunks: [changeSet], largestGroup, oversizedGroups, cutGroups };
  }
  return {
    chunks: chunks.map((chunk) => chunk.build(changeSet)),
    largestGroup,
    oversizedGroups,
    cutGroups,
  };
};

/** The ordered chunks of `changeSet` (see {@link planChangeSet}). */
export const splitChangeSet = (
  changeSet: SyncChangeSet,
  limits?: Partial<ApplyLimits>,
): SyncChangeSet[] => planChangeSet(changeSet, limits).chunks;
