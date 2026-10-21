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
 * A later slice that implements another class adds its `kind` to {@link TableStrategy}, a branch in
 * `strategyForTable`, and a case in the dispatcher of `apply-bundle.ts` / `list-changes.ts`; the
 * compiler then points at every place that must handle it. A table that needs its own rules on top
 * of a class (the GTD task lifecycle tuple, the Pomodoro tables, AI proposals, the finance
 * categorization unit) is routed through {@link TABLE_STRATEGY_OVERRIDES} instead.
 *
 * Still refused after the finance slice: nothing in the three bundle domains except the gtd
 * recurrence sidecars (they travel in `SyncChangeSet.recurrence`, never as entities). Natural-key
 * canonicalization (`sync_id_aliases`) is a later slice: a declared natural-key collision still
 * aborts the bundle with `natural_key_collision`.
 */

/**
 * Extra rules a field-clock table layers on top of the class (`merge-task.ts`). No rule means the
 * generic merge of `merge-entity.ts`.
 *
 * - `gtd-task`: the lifecycle tuple as one unit, save-time normalization, recurring instances
 *   recomputed from their occurrences, the Planned queue repaired after the merge;
 * - `recurring-template`: generic, except `last_generated_for_date` derived from the occurrences.
 */
export type FieldClockRule = "gtd-task" | "recurring-template";

/**
 * Rules of the tables stamped as a WHOLE ROW (`row_hlc` only, no per-field clocks), merged by
 * `merge-row.ts` plus the table's own rule:
 *
 * - `pomodoro-session`: terminal sessions only (registry `rowFilter`); a running or paused local
 *   session is never touched; whole-row last-writer-wins (`merge-pomodoro.ts`);
 * - `pomodoro-segment`: only segments of a terminal session; `ended_at` joined (non-null beats null);
 * - `ai-proposal`: terminal status beats pending, divergent terminals logged, one pending proposal
 *   per natural key (`merge-proposal.ts`, `apply-proposals.ts`);
 * - `generic-row`: plain whole-row last-writer-wins, the loser logged (`merge-finance.ts`): every
 *   other `row-clock` table (the finance people, accounts, categories, rules, merchant memory,
 *   budget, recurring series, import profiles and batches, and `ai_memories`);
 * - `finance-transaction`: the row merges by row clock, its categorization unit
 *   (`{category_id, category_source, has_splits}` + the splits) by the unit order
 *   (`merge-finance.ts`, `apply-finance.ts`);
 * - `finance-split`: a child of the transaction's unit, applied together with its transaction
 *   (never merged on its own);
 * - `finance-suggestion`: monotonic status, one pending suggestion per transaction
 *   (`merge-finance.ts`, `apply-proposals.ts`);
 * - `finance-balance-snapshot`: only `source = 'statement'` rows are published or accepted
 *   (registry `rowFilter`), at most one standing anchor per account (`apply-finance.ts`).
 */
export type RowClockRule =
  | "pomodoro-session"
  | "pomodoro-segment"
  | "ai-proposal"
  | "generic-row"
  | "finance-transaction"
  | "finance-split"
  | "finance-suggestion"
  | "finance-balance-snapshot";

export type TableStrategy =
  /** Per-column / per-key / per-element clocks with whole-entity edit-wins-over-delete. */
  | { kind: "field-clock"; rule?: FieldClockRule }
  /** One clock per row with whole-entity edit-wins-over-delete; always carries a table rule. */
  | { kind: "row-clock"; rule: RowClockRule }
  /** Insert-if-absent by primary key (and any unique key); never updated, never deleted. */
  | { kind: "grow-only-union" };

export type TableStrategyKind = TableStrategy["kind"];

/**
 * Per-table replacements for the class default: the GTD task and the recurring template have their
 * own rules on top of the field-clock class; the Pomodoro tables, AI proposals and the finance
 * tables that need more than whole-row last-writer-wins (transactions and their splits, category
 * suggestions, statement snapshots) are routed through their own row-clock rule. Every other
 * `row-clock` table takes the `generic-row` rule from its merge class.
 */
export const TABLE_STRATEGY_OVERRIDES: Readonly<Record<string, TableStrategy>> = {
  gtd_tasks: { kind: "field-clock", rule: "gtd-task" },
  recurring_task_templates: { kind: "field-clock", rule: "recurring-template" },
  pomodoro_sessions: { kind: "row-clock", rule: "pomodoro-session" },
  pomodoro_segments: { kind: "row-clock", rule: "pomodoro-segment" },
  ai_proposals: { kind: "row-clock", rule: "ai-proposal" },
  finance_transactions: { kind: "row-clock", rule: "finance-transaction" },
  finance_transaction_splits: { kind: "row-clock", rule: "finance-split" },
  finance_category_suggestions: { kind: "row-clock", rule: "finance-suggestion" },
  finance_account_balance_snapshots: { kind: "row-clock", rule: "finance-balance-snapshot" },
};

/**
 * The strategy for a registration, or `null` when this build cannot merge it. Not supported:
 *
 * - device-local and by-entity-type tables;
 * - a table with a `rowFilter` (a subset is published, the rest stays local) unless its strategy
 *   is a row-clock rule that owns the filter, so a registry change cannot make filtered-out rows
 *   leak through a generic path;
 * - any merge class without a strategy yet (`monotonic-status`, `child-set` and `pomodoro` tables
 *   need an override; there is no other class left without one).
 *
 * Declared foreign keys are not a reason to refuse a table: `apply-references.ts` orders the
 * tables, keeps children off deleted parents and tombstones what a cascade removes, derived from
 * `PRAGMA foreign_key_list`; `registry.test.ts` fails when a migration adds a key it does not cover.
 */
export const strategyForRegistration = (entry: TableRegistration): TableStrategy | null => {
  if (!(SYNC_DOMAINS as readonly string[]).includes(entry.domain)) {
    return null;
  }
  const override = Object.hasOwn(TABLE_STRATEGY_OVERRIDES, entry.table)
    ? TABLE_STRATEGY_OVERRIDES[entry.table]
    : undefined;
  if (entry.rowFilter) {
    // A filtered table is supported only through a rule that implements its filter.
    return override?.kind === "row-clock" ? override : null;
  }
  if (override) {
    return override;
  }
  switch (entry.mergeClass) {
    case "field-clock":
      return { kind: "field-clock" };
    case "row-clock":
      return { kind: "row-clock", rule: "generic-row" };
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
  TABLE_REGISTRY.filter((entry) => {
    const kind = entry.domain === domain ? strategyForTable(entry.table)?.kind : undefined;
    return kind === "field-clock" || kind === "row-clock";
  }).map((entry) => entry.table);

/** Tables of `domain` published as full row sets, in registry order. */
export const supportedUnionTables = (domain: SyncDomain): string[] =>
  tablesOfKind(domain, "grow-only-union");

/** Tables of `domain` this build neither publishes nor merges. */
export const unsupportedTablesInDomain = (domain: SyncDomain): string[] =>
  TABLE_REGISTRY.filter(
    (entry) => entry.domain === domain && strategyForTable(entry.table) === null,
  ).map((entry) => entry.table);

/** The extra rule of a supported field-clock table, if any. */
export const fieldClockRuleOf = (table: string): FieldClockRule | undefined => {
  const strategy = strategyForTable(table);
  return strategy?.kind === "field-clock" ? strategy.rule : undefined;
};

/** The rule of a supported row-clock table. */
export const rowClockRuleOf = (table: string): RowClockRule | undefined => {
  const strategy = strategyForTable(table);
  return strategy?.kind === "row-clock" ? strategy.rule : undefined;
};

/** Position of a table in the registry; the order tables are published in. */
export const tableOrder = (table: string): number =>
  TABLE_REGISTRY.findIndex((entry) => entry.table === table);
