import {
  getTableRegistration,
  isRegisteredTable,
  SYNC_DOMAINS,
  type SyncDomain,
  TABLE_REGISTRY,
  type TableRegistration,
} from "./registry";

/**
 * Which tables this build can publish and merge, and how. This is the single seam between the
 * registry (what a table IS) and the engine (what it can DO):
 *
 * - `listSyncChanges` publishes only tables that have a strategy here;
 * - `applySyncBundle` refuses (`unsupported_merge_class`) a bundle that mentions any other table
 *   instead of half-merging it.
 *
 * A later slice that implements another class (row-clock, monotonic-status, Pomodoro, the finance
 * categorization unit) adds its `kind` to {@link TableStrategy}, a branch in `strategyForTable`, and
 * a case in the dispatcher of `apply-bundle.ts` / `list-changes.ts`; the compiler then points at
 * every place that must handle it. A table that needs its own rules on top of a class (the GTD task
 * lifecycle tuple) is routed through {@link TABLE_STRATEGY_OVERRIDES} instead.
 */

export type TableStrategy =
  /** Per-column / per-key / per-element clocks with whole-entity edit-wins-over-delete. */
  | { kind: "field-clock" }
  /** Insert-if-absent by primary key (and any unique key); never updated, never deleted. */
  | { kind: "grow-only-union" };

export type TableStrategyKind = TableStrategy["kind"];

/**
 * Per-table replacements for the class default. Empty today. The GTD lifecycle slice registers
 * `gtd_tasks` and `recurring_task_templates` here and removes their `lifecycleMergePending` flag.
 */
export const TABLE_STRATEGY_OVERRIDES: Readonly<Record<string, TableStrategy>> = {};

/**
 * The strategy for a registration, or `null` when this build cannot merge it. Not supported:
 *
 * - device-local and by-entity-type tables;
 * - a table with a `rowFilter` (a subset is published, the rest stays local) until the strategy
 *   that owns the filter exists, so a registry change cannot make filtered-out rows leak through a
 *   generic path;
 * - a table with `referencesMergePending` (it takes part in a declared foreign key that can cascade
 *   or abort a bundle);
 * - any merge class without a strategy yet.
 *
 * `lifecycleMergePending` does NOT block merging: it marks tables merged generically on purpose
 * until the GTD lifecycle slice replaces the rule.
 */
export const strategyForRegistration = (entry: TableRegistration): TableStrategy | null => {
  if (!(SYNC_DOMAINS as readonly string[]).includes(entry.domain)) {
    return null;
  }
  if (entry.rowFilter || entry.referencesMergePending) {
    return null;
  }
  const override = Object.hasOwn(TABLE_STRATEGY_OVERRIDES, entry.table)
    ? TABLE_STRATEGY_OVERRIDES[entry.table]
    : undefined;
  if (override) {
    return override;
  }
  switch (entry.mergeClass) {
    case "field-clock":
      return { kind: "field-clock" };
    case "grow-only-union":
      return { kind: "grow-only-union" };
    default:
      return null;
  }
};

/** The strategy for a table by name, or `null` (unknown tables included). */
export const strategyForTable = (table: string): TableStrategy | null =>
  isRegisteredTable(table) ? strategyForRegistration(getTableRegistration(table)) : null;

export const isTableSyncSupported = (table: string): boolean => strategyForTable(table) !== null;

const tablesOfKind = (domain: SyncDomain, kind: TableStrategyKind): string[] =>
  TABLE_REGISTRY.filter(
    (entry) => entry.domain === domain && strategyForTable(entry.table)?.kind === kind,
  ).map((entry) => entry.table);

/** Tables of `domain` published as entities (with a `sync_entity_meta` row), in registry order. */
export const supportedEntityTables = (domain: SyncDomain): string[] =>
  tablesOfKind(domain, "field-clock");

/** Tables of `domain` published as full row sets, in registry order. */
export const supportedUnionTables = (domain: SyncDomain): string[] =>
  tablesOfKind(domain, "grow-only-union");

/** Tables of `domain` this build neither publishes nor merges. */
export const unsupportedTablesInDomain = (domain: SyncDomain): string[] =>
  TABLE_REGISTRY.filter(
    (entry) => entry.domain === domain && strategyForTable(entry.table) === null,
  ).map((entry) => entry.table);

/** Position of a table in the registry; the order tables are applied in. */
export const tableOrder = (table: string): number =>
  TABLE_REGISTRY.findIndex((entry) => entry.table === table);
