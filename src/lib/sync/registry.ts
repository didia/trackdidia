import type { AppSettings } from "../../domain/types/settings";

/**
 * The single source of truth for which data may leave a machine, and in which bundle.
 *
 * Pure data and small pure helpers: no I/O, no storage access. Later slices (bundle encode/filter,
 * the merge engine, the work-profile guards) call the helpers below instead of re-deriving
 * classifications, so a mistake here is a privacy bug: a `gtd` classification reaches the
 * employer-managed work laptop. Classify conservatively. When a table or key is ambiguous, pick
 * the more private side (`gtd` -> `personal`/`finance`, `personal` -> `device`).
 *
 * Completeness is enforced twice. Settings are typed `Record<keyof AppSettings, SettingRule>`, so
 * adding a key to `AppSettings` fails typecheck until it is classified. Tables are checked by
 * `registry.test.ts` against the fully migrated schema (every table classified, no stale entry),
 * together with the domain-isolation invariant (no `gtd` table references a non-`gtd` table) and
 * the natural-key comparison with the schema's unique indexes.
 */

// ---------------------------------------------------------------------------------------------
// Domains and merge classes
// ---------------------------------------------------------------------------------------------

/** Domains that travel in a bundle. Each has its own bundle and its own destination folder. */
export const SYNC_DOMAINS = ["gtd", "personal", "finance"] as const;
export type SyncDomain = (typeof SYNC_DOMAINS)[number];

/** Marker for data that never leaves the machine. Not a bundle domain. */
export const DEVICE_DOMAIN = "device" as const;

/**
 * Marker for sidecar tables whose rows each belong to the domain of the entity they describe
 * (`sync_entity_meta`, `sync_id_aliases`, `sync_conflicts`). Such a table has no domain of its own:
 * a row is published only inside the bundle of its `entity_type`'s domain, resolved by
 * `sidecarPublishDomain`. Not a bundle domain, and never publishable through the plain table guards.
 */
export const BY_ENTITY_TYPE_DOMAIN = "by-entity-type" as const;

/** Every value a table or setting can be classified into. */
export const CLASSIFICATION_DOMAINS = [
  ...SYNC_DOMAINS,
  DEVICE_DOMAIN,
  BY_ENTITY_TYPE_DOMAIN,
] as const;
export type ClassificationDomain = (typeof CLASSIFICATION_DOMAINS)[number];

/** Domains the work profile may apply and publish. Everything else is refused on a work device. */
export const WORK_PROFILE_DOMAINS = ["gtd"] as const satisfies readonly SyncDomain[];

export const MERGE_CLASSES = [
  "field-clock",
  "row-clock",
  "grow-only-union",
  "monotonic-status",
  "child-set",
  "pomodoro",
  "sidecar",
  "device-local",
] as const;
export type MergeClass = (typeof MERGE_CLASSES)[number];

// ---------------------------------------------------------------------------------------------
// Table registry types
// ---------------------------------------------------------------------------------------------

/**
 * How a column points at another table.
 *
 * - `foreign-key`: a declared SQL foreign key.
 * - `soft`: a plain id column the schema does not constrain.
 * - `json-id-list`: a JSON array of ids (merged as an OR-set).
 * - `json-payload`: an id inside a JSON document, resolved through the alias table when read.
 * - `polymorphic`: the column holds an id of one of several tables; one entry per possible target.
 * - `derived`: the value is built from ids of the target table (for example `transfer:<a>:<b>`).
 */
export type ReferenceKind =
  | "foreign-key"
  | "soft"
  | "json-id-list"
  | "json-payload"
  | "polymorphic"
  | "derived";

/**
 * How a `derived` reference is built from the ids of its target table. The alias engine rewrites
 * the embedded ids (`reference-rewrite.ts`):
 *
 * - `transfer-group`: `transfer:<idA>:<idB>`, the two transaction ids sorted;
 * - `embedded-id`: an id inside a longer key (`weekly_carryover:<date>:<taskId>`);
 * - `account-dedupe-hash`: `finance_transactions.dedupe_hash` is a hash of the account id plus the
 *   statement line, so it is re-derived when the account id changes.
 */
export type ReferenceDerivation = "transfer-group" | "embedded-id" | "account-dedupe-hash";

export interface TableReference {
  column: string;
  table: string;
  kind: ReferenceKind;
  /**
   * `json-payload` only: where the id sits inside the column's JSON document, as a restricted
   * JSONPath: `$.key(.key)*`, optionally ending in `[]` for an array of ids (`$.accountIds[]`).
   * Machine-readable: the alias engine rewrites exactly these paths.
   */
  path?: string;
  /** `derived` only: how the value is built from the target's ids. */
  derive?: ReferenceDerivation;
  note?: string;
}

/**
 * What the engine does when two peers hold different rows that violate a declared natural key.
 *
 * - `alias`: the rows denote ONE entity: canonical id = the smaller id, the other is recorded in
 *   `sync_id_aliases` and every reference is rewritten (`apply-aliases.ts`);
 * - `pending-collision`: a partial unique index over `pending` rows; the later pending row stays
 *   pending and the other is expired (`apply-proposals.ts`);
 * - `union-dedupe`: a grow-only-union table keyed twice; the insert-if-absent keeps one row;
 * - `name-prompt`: a rename onto an existing name; the local name stays and an unresolved
 *   `name_collision` conflict asks the user (`apply-names.ts`).
 */
export type NaturalKeyResolution = "alias" | "pending-collision" | "union-dedupe" | "name-prompt";

/**
 * A unique key besides the primary key. Two peers can mint different ids for the same entity;
 * the engine uses these to detect that and pick a canonical id.
 *
 * `index` is the name of the `CREATE UNIQUE INDEX` that enforces it, absent for an inline
 * `UNIQUE` column constraint. `columns` lists bare column names, or the literal SQL expression for
 * an expression index. `where` is the exact predicate of a partial index.
 */
export interface NaturalKey {
  name: string;
  index?: string;
  columns: readonly string[];
  where?: string;
  resolution: NaturalKeyResolution;
  description?: string;
}

/**
 * A subset of a table's rows that is published; the rest stays on the machine.
 *
 * `publishWhen` is REAL SQL, the single source of the filter: a boolean expression over the table's
 * own columns (unqualified; it may use a sub-select on another registry table). `list-changes.ts`
 * appends it to the table's `SELECT`, and `row-filter.ts` holds the matching pure predicate that
 * validates incoming rows; `row-filter.test.ts` runs both over the same rows so they cannot drift.
 */
export interface RowFilter {
  /** SQL predicate selecting the rows that are published. */
  publishWhen: string;
  /** What the excluded rows are and why they stay local. */
  localOnly: string;
}

export interface TableRegistration {
  table: string;
  domain: ClassificationDomain;
  mergeClass: MergeClass;
  primaryKey: readonly string[];
  naturalKeys: readonly NaturalKey[];
  references: readonly TableReference[];
  /** JSON-map columns merged per key (`metrics.<key>`, `milestones.<id>`). */
  jsonMapColumns?: readonly string[];
  /** Id-list columns merged as OR-sets. */
  orSetColumns?: readonly string[];
  rowFilter?: RowFilter;
  /**
   * Only on `by-entity-type` sidecars: the column holding the table name (or `setting`) of the
   * entity a row describes, which decides the bundle the row travels in.
   */
  entityTypeColumn?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------------------------
// Table registry
// ---------------------------------------------------------------------------------------------

/**
 * Statuses of a Pomodoro session that has ended. Only such a session (and its segments) is ever
 * published: a running or paused timer belongs to the laptop it runs on.
 */
export const POMODORO_TERMINAL_STATUSES = ["completed", "cancelled"] as const;

const TERMINAL_SESSION_SQL = `status IN (${POMODORO_TERMINAL_STATUSES.map((status) => `'${status}'`).join(", ")})`;

const noKeys: readonly NaturalKey[] = [];
const noRefs: readonly TableReference[] = [];

const contextIdList = (note?: string): TableReference => ({
  column: "context_ids_json",
  table: "gtd_contexts",
  kind: "json-id-list",
  ...(note === undefined ? {} : { note }),
});

export const TABLE_REGISTRY: readonly TableRegistration[] = [
  // ----- gtd: reaches the work laptop -------------------------------------------------------
  {
    table: "gtd_tasks",
    domain: "gtd",
    mergeClass: "field-clock",
    primaryKey: ["id"],
    naturalKeys: [
      {
        name: "source_external_id",
        columns: ["source_external_id"],
        resolution: "alias",
        description: "Relationship draws generated on two personal laptops; legacy imports.",
      },
    ],
    references: [
      { column: "project_id", table: "gtd_projects", kind: "soft" },
      { column: "parent_task_id", table: "gtd_tasks", kind: "soft" },
      { column: "recurring_template_id", table: "recurring_task_templates", kind: "soft" },
      contextIdList(),
    ],
    orSetColumns: ["context_ids_json"],
    notes:
      "The lifecycle tuple {status, bucket, completed_at, scheduled_for, planned_order, project_id} merges as one unit (merge-task.ts). Rows with is_recurring_instance = 1 follow the recurring-occurrence rules (sync_recurrence_occurrences), not plain field clocks. recurrence_group_id is an opaque group label from imported recurring tasks, not a reference. Relationship-draw tasks and task notes are shared by design.",
  },
  {
    table: "gtd_projects",
    domain: "gtd",
    mergeClass: "field-clock",
    primaryKey: ["id"],
    naturalKeys: [
      {
        name: "source_external_id",
        columns: ["source_external_id"],
        resolution: "alias",
        description: "Legacy imported projects.",
      },
    ],
    references: [contextIdList()],
    orSetColumns: ["context_ids_json"],
  },
  {
    table: "gtd_contexts",
    domain: "gtd",
    mergeClass: "field-clock",
    primaryKey: ["id"],
    naturalKeys: [
      {
        name: "name",
        columns: ["name"],
        resolution: "name-prompt",
        description: "Ids are deterministic (context:<slug>); a rename onto a name is a prompt.",
      },
    ],
    references: noRefs,
  },
  {
    table: "gtd_task_events",
    domain: "gtd",
    mergeClass: "grow-only-union",
    primaryKey: ["id"],
    naturalKeys: [
      {
        name: "dedupe_key",
        columns: ["dedupe_key"],
        resolution: "union-dedupe",
        description: "Weekly carryover on two laptops; the union already keys on it.",
      },
    ],
    references: [
      { column: "task_id", table: "gtd_tasks", kind: "soft" },
      {
        column: "dedupe_key",
        table: "gtd_tasks",
        kind: "derived",
        derive: "embedded-id",
        note: "weekly_carryover:<date>:<taskId> embeds the task id.",
      },
    ],
    notes:
      "Union by id / dedupe_key. metadata_json holds only bucket, from, scheduledFor and recurring values, never ids.",
  },
  {
    table: "recurring_task_templates",
    domain: "gtd",
    mergeClass: "field-clock",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: [{ column: "project_id", table: "gtd_projects", kind: "soft" }, contextIdList()],
    orSetColumns: ["context_ids_json"],
    notes:
      "Generic per-field merge, except last_generated_for_date, which is derived from the latest recurring occurrence (merge-task.ts).",
  },
  {
    table: "pomodoro_sessions",
    domain: "gtd",
    mergeClass: "pomodoro",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: noRefs,
    rowFilter: {
      publishWhen: TERMINAL_SESSION_SQL,
      localOnly: "A running or paused timer is owned by the laptop it runs on and never leaves it.",
    },
    notes:
      "Only terminal sessions are published or applied. A terminal session is immutable in practice; two versions of one are merged by whole-row last-writer-wins (merge-pomodoro.ts). Tombstones are never published (a tombstone cannot prove its session was ever terminal).",
  },
  {
    table: "pomodoro_segments",
    domain: "gtd",
    mergeClass: "pomodoro",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: [
      { column: "session_id", table: "pomodoro_sessions", kind: "soft" },
      { column: "task_id", table: "gtd_tasks", kind: "soft" },
    ],
    rowFilter: {
      publishWhen: `session_id IN (SELECT id FROM pomodoro_sessions WHERE ${TERMINAL_SESSION_SQL})`,
      localOnly: "Segments of a running or paused session stay with that session.",
    },
    notes:
      "Whole-row last-writer-wins, except ended_at: a non-null value beats null, and two different non-null values keep the later timestamp (merge-pomodoro.ts). Tombstones are never published.",
  },

  // Recurrence sidecars: keyed by a gtd template, so they travel with the gtd bundle.
  {
    table: "sync_recurrence_occurrences",
    domain: "gtd",
    mergeClass: "sidecar",
    primaryKey: ["template_id", "due_date"],
    naturalKeys: noKeys,
    references: [{ column: "template_id", table: "recurring_task_templates", kind: "soft" }],
    notes:
      "Outcome of one recurring occurrence (template_id, due_date); a join (a user outcome beats missed and active, then the later outcome_hlc). device_id is the device that produced the outcome, not a reference. Travels in SyncChangeSet.recurrence, not as an entity.",
  },
  {
    table: "sync_recurrence_clears",
    domain: "gtd",
    mergeClass: "sidecar",
    primaryKey: ["template_id"],
    naturalKeys: noKeys,
    references: [{ column: "template_id", table: "recurring_task_templates", kind: "soft" }],
    notes:
      "Latest due date whose missed backlog was cleared; a max. Travels in SyncChangeSet.recurrence, not as an entity.",
  },

  // ----- personal: never reaches the work laptop --------------------------------------------
  {
    table: "daily_entries",
    domain: "personal",
    mergeClass: "field-clock",
    primaryKey: ["date"],
    naturalKeys: noKeys,
    references: noRefs,
    jsonMapColumns: ["metrics_json", "principles_json"],
    notes: "metrics.<key> and principles.<key> merge per key.",
  },
  {
    table: "weekly_reviews",
    domain: "personal",
    mergeClass: "field-clock",
    primaryKey: ["week_start_date"],
    naturalKeys: noKeys,
    references: noRefs,
    jsonMapColumns: ["notes_json"],
    notes: "Review notes merge per key. ritual_checklist_json is one atomic field.",
  },
  {
    table: "monthly_reviews",
    domain: "personal",
    mergeClass: "field-clock",
    primaryKey: ["month_key"],
    naturalKeys: noKeys,
    references: noRefs,
    jsonMapColumns: ["notes_json"],
    notes: "Review notes merge per key. ritual_checklist_json is one atomic field.",
  },
  {
    table: "mid_week_decisions",
    domain: "personal",
    mergeClass: "field-clock",
    primaryKey: ["week_start_date"],
    naturalKeys: noKeys,
    references: noRefs,
    notes: "lagging_snapshot_json is one atomic field.",
  },
  {
    table: "annual_goals",
    domain: "personal",
    mergeClass: "field-clock",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: noRefs,
    jsonMapColumns: ["evaluations_json", "progress_log_json", "milestones_json"],
    notes:
      "evaluations.<key>, progress_log.<key> and milestones.<id> merge per key. source_id is a metric source name, not a reference.",
  },
  {
    table: "weekly_objectives",
    domain: "personal",
    mergeClass: "field-clock",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: noRefs,
    notes:
      "Parent of weekly_objective_results (ON DELETE CASCADE). Merged per field; a parent tombstone also tombstones the results the cascade removes (apply-references.ts).",
  },
  {
    table: "weekly_objective_results",
    domain: "personal",
    mergeClass: "field-clock",
    primaryKey: ["week_start_date", "objective_id"],
    naturalKeys: noKeys,
    references: [{ column: "objective_id", table: "weekly_objectives", kind: "foreign-key" }],
    notes:
      "A result for a deleted or unknown objective is never inserted (it would violate the foreign key): it stays tombstoned or is skipped, with an orphaned_child conflict (apply-references.ts).",
  },
  {
    table: "ai_messages",
    domain: "personal",
    mergeClass: "grow-only-union",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: noRefs,
    notes: "Union by id. Cannot conflict.",
  },
  {
    table: "ai_proposals",
    domain: "personal",
    mergeClass: "monotonic-status",
    primaryKey: ["id"],
    naturalKeys: [
      {
        name: "pending_goal_evaluation",
        index: "idx_ai_proposals_message_goal",
        columns: ["message_id", "json_extract(payload_json, '$.goalId')"],
        where: "status = 'pending' AND type = 'goal_evaluation'",
        resolution: "pending-collision",
        description: "One pending goal evaluation per message and goal.",
      },
      {
        name: "pending_per_message_type",
        index: "idx_ai_proposals_message_type",
        columns: ["message_id", "type"],
        where:
          "status = 'pending' AND type NOT IN ( 'memory', 'review_section_draft', 'weekly_objective', 'gtd_action', 'goal_evaluation' )",
        resolution: "pending-collision",
        description: "One pending proposal per message and type, except the multi-proposal types.",
      },
    ],
    references: [
      { column: "message_id", table: "ai_messages", kind: "foreign-key" },
      // applied_entity_id holds the id of whatever the accepted proposal created or updated.
      // A gtd_action proposal points at a GTD task, which is allowed (personal -> gtd).
      { column: "applied_entity_id", table: "ai_memories", kind: "polymorphic" },
      { column: "applied_entity_id", table: "weekly_objectives", kind: "polymorphic" },
      { column: "applied_entity_id", table: "annual_goals", kind: "polymorphic" },
      { column: "applied_entity_id", table: "gtd_tasks", kind: "polymorphic" },
      // Keyed by date / week start / month key rather than a generated id.
      { column: "applied_entity_id", table: "daily_entries", kind: "polymorphic" },
      { column: "applied_entity_id", table: "weekly_reviews", kind: "polymorphic" },
      { column: "applied_entity_id", table: "monthly_reviews", kind: "polymorphic" },
      { column: "payload_json", table: "gtd_tasks", kind: "json-payload", path: "$.taskId" },
      { column: "payload_json", table: "annual_goals", kind: "json-payload", path: "$.goalId" },
    ],
    notes:
      "Terminal state (accepted / dismissed / expired) beats pending whatever the clocks say; two different terminals keep the smaller status and write a terminal_divergence conflict. Two pending proposals for one natural key keep the later row clock pending and expire the other (merge-proposal.ts). gtd_action proposals refer to tasks but live in personal.",
  },
  {
    table: "ai_memories",
    domain: "personal",
    mergeClass: "row-clock",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: noRefs,
  },

  // ----- finance: never reaches the work laptop ---------------------------------------------
  {
    table: "finance_people",
    domain: "finance",
    mergeClass: "row-clock",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: noRefs,
  },
  {
    table: "finance_accounts",
    domain: "finance",
    mergeClass: "row-clock",
    primaryKey: ["id"],
    naturalKeys: [
      {
        name: "external_key",
        index: "uniq_finance_account_external_key",
        columns: ["external_key"],
        where: "external_key IS NOT NULL",
        resolution: "alias",
        description: "Same import label bound to an account on two laptops.",
      },
    ],
    references: [{ column: "owner_person_id", table: "finance_people", kind: "soft" }],
  },
  {
    table: "finance_categories",
    domain: "finance",
    mergeClass: "row-clock",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: [{ column: "parent_id", table: "finance_categories", kind: "soft" }],
  },
  {
    table: "finance_transactions",
    domain: "finance",
    mergeClass: "row-clock",
    primaryKey: ["id"],
    naturalKeys: [
      {
        name: "account_dedupe_hash",
        index: "uniq_finance_txn_dedupe",
        columns: ["account_id", "dedupe_hash"],
        resolution: "alias",
        description: "Same statement imported on two personal laptops.",
      },
    ],
    references: [
      { column: "account_id", table: "finance_accounts", kind: "soft" },
      { column: "category_id", table: "finance_categories", kind: "soft" },
      { column: "person_id", table: "finance_people", kind: "soft" },
      { column: "import_batch_id", table: "finance_import_batches", kind: "soft" },
      {
        column: "transfer_group_id",
        table: "finance_transactions",
        kind: "derived",
        derive: "transfer-group",
        note: "Value is transfer:<idA>:<idB>, built from the two transaction ids.",
      },
      {
        column: "dedupe_hash",
        table: "finance_accounts",
        kind: "derived",
        derive: "account-dedupe-hash",
        note: "A hash of [accountId, postedDate, amountMinor, currency, description, occurrenceIndex].",
      },
    ],
    notes:
      "Whole-row last-writer-wins, except {category_id, category_source, has_splits} (+ category_confidence and categorized_at, written by the same decision) and the child splits, which form one categorization unit with its own clocks (categorization, categorization_base = base_hlc, categorization_user) in field_clocks_json; see merge-finance.ts. A natural-key collision (the same statement imported on two laptops) resolves through canonical identity: the smaller transaction id wins, the other becomes an alias, the two rows merge by these rules and the splits follow the winning unit (apply-aliases.ts).",
  },
  {
    table: "finance_transaction_splits",
    domain: "finance",
    mergeClass: "child-set",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: [
      { column: "transaction_id", table: "finance_transactions", kind: "soft" },
      { column: "category_id", table: "finance_categories", kind: "soft" },
    ],
    notes:
      "Part of the parent transaction's categorization unit; replaced as a set with whichever categorization wins (apply-finance.ts). Children leave no tombstone: the unit carries the set. A split of a transaction the bundle does not name is skipped (orphaned_child), never an abort.",
  },
  {
    table: "finance_category_suggestions",
    domain: "finance",
    mergeClass: "monotonic-status",
    primaryKey: ["id"],
    naturalKeys: [
      {
        name: "pending_per_transaction",
        index: "uniq_finance_suggestion_pending",
        columns: ["transaction_id"],
        where: "status = 'pending'",
        resolution: "pending-collision",
        description: "One pending suggestion per transaction.",
      },
    ],
    references: [
      { column: "transaction_id", table: "finance_transactions", kind: "soft" },
      { column: "suggested_category_id", table: "finance_categories", kind: "soft" },
    ],
    notes:
      "A decided suggestion (accepted, corrected, dismissed, or expired by a collision) beats a pending one and any tombstone; two different decisions keep the smaller status and write a terminal_divergence conflict unless one is expired; two pending suggestions for one transaction keep the later row clock pending and expire the other (pending_collision), as for AI proposals (merge-finance.ts, apply-proposals.ts). A suggestion may arrive before its transaction (no foreign key): it is stored.",
  },
  {
    table: "finance_rules",
    domain: "finance",
    mergeClass: "row-clock",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: [
      {
        column: "matcher_json",
        table: "finance_accounts",
        kind: "json-payload",
        path: "$.accountIds[]",
      },
      { column: "matcher_json", table: "finance_people", kind: "json-payload", path: "$.personId" },
      {
        column: "actions_json",
        table: "finance_categories",
        kind: "json-payload",
        path: "$.categoryId",
      },
      { column: "actions_json", table: "finance_people", kind: "json-payload", path: "$.personId" },
    ],
    notes:
      "matcher_json and actions_json embed account, person and category ids; the ids of an aliased entity (an account) are rewritten through the alias table like any declared reference, so a rule matching an aliased account keeps matching. applied_count and last_applied_at change on every classification that changes a row and merge with the row (whole-row last-writer-wins).",
  },
  {
    table: "finance_merchant_memory",
    domain: "finance",
    mergeClass: "row-clock",
    primaryKey: ["merchant_key", "account_id", "sign"],
    naturalKeys: noKeys,
    references: [
      { column: "account_id", table: "finance_accounts", kind: "soft" },
      { column: "category_id", table: "finance_categories", kind: "soft" },
    ],
  },
  {
    table: "finance_budget_entries",
    domain: "finance",
    mergeClass: "row-clock",
    primaryKey: ["month_key", "category_id"],
    naturalKeys: noKeys,
    references: [{ column: "category_id", table: "finance_categories", kind: "soft" }],
  },
  {
    table: "finance_budget_months",
    domain: "finance",
    mergeClass: "row-clock",
    primaryKey: ["month_key"],
    naturalKeys: noKeys,
    references: noRefs,
  },
  {
    table: "finance_recurring_series",
    domain: "finance",
    mergeClass: "row-clock",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: [
      { column: "account_id", table: "finance_accounts", kind: "soft" },
      { column: "category_id", table: "finance_categories", kind: "soft" },
    ],
  },
  {
    table: "finance_import_profiles",
    domain: "finance",
    mergeClass: "row-clock",
    primaryKey: ["id"],
    naturalKeys: [
      {
        name: "signature",
        index: "uniq_finance_profile_signature",
        columns: ["signature"],
        resolution: "alias",
        description: "Header signature: the same CSV layout saved on two laptops.",
      },
    ],
    references: [{ column: "default_account_id", table: "finance_accounts", kind: "soft" }],
  },
  {
    table: "finance_import_batches",
    domain: "finance",
    mergeClass: "row-clock",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: [
      { column: "profile_id", table: "finance_import_profiles", kind: "soft" },
      { column: "account_id", table: "finance_accounts", kind: "soft" },
    ],
  },
  {
    table: "finance_account_balance_snapshots",
    domain: "finance",
    mergeClass: "row-clock",
    primaryKey: ["account_id", "as_of_date"],
    naturalKeys: noKeys,
    references: [{ column: "account_id", table: "finance_accounts", kind: "soft" }],
    rowFilter: {
      publishWhen: "source = 'statement'",
      localOnly:
        "source = 'derived' rows are rebuilt by the daily job on each machine and never leave it.",
    },
    notes:
      "Statement snapshots are user data (written by statement import, which also re-bases the opening balance); only they are published, and a bundle row with source other than statement is refused (row_filter_violation). No tombstones are published or kept: the statement import replaces the previous anchor, and apply keeps one standing anchor per account (the later row clock, then date). A statement row beats a derived one at the same key.",
  },

  // ----- by-entity-type sidecars: each row travels in its entity's domain ------------------
  // Their `entity_type` column names a registered table or `setting`; `sidecarPublishDomain`
  // maps a row to its bundle. A row whose entity_type is personal or finance can never be placed
  // in a gtd bundle, because the plain table guards refuse these tables outright.
  {
    table: "sync_entity_meta",
    domain: BY_ENTITY_TYPE_DOMAIN,
    mergeClass: "sidecar",
    primaryKey: ["entity_type", "entity_id"],
    naturalKeys: noKeys,
    references: noRefs,
    entityTypeColumn: "entity_type",
    notes:
      "Field clocks, row clock and tombstone of one entity. entity_id is an id of the table named by entity_type (a setting key for 'setting'), not a declared reference.",
  },
  {
    table: "sync_id_aliases",
    domain: BY_ENTITY_TYPE_DOMAIN,
    mergeClass: "sidecar",
    primaryKey: ["entity_type", "alias_id"],
    naturalKeys: noKeys,
    references: noRefs,
    entityTypeColumn: "entity_type",
    notes:
      "Grow-only alias -> canonical id map, published in the entity's domain (SyncChangeSet.aliases). Rows are kept path-compressed: canonical_id is always the smallest id of the alias class, and recorded_hlc is the largest recorded clock of the class (aliases.ts). Only entity types with a natural key resolved by 'alias' have rows.",
  },
  {
    table: "sync_conflicts",
    domain: BY_ENTITY_TYPE_DOMAIN,
    mergeClass: "sidecar",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: noRefs,
    entityTypeColumn: "entity_type",
    notes:
      "local_json / remote_json hold row contents, so a row travels only in its entity's domain bundle: a personal or finance conflict must never reach a gtd bundle.",
  },

  // ----- device-local: never leaves any machine ---------------------------------------------
  {
    table: "sync_identity",
    domain: "device",
    mergeClass: "device-local",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: noRefs,
    notes:
      "Single row: this installation's device id and name, HLC state, change counters and the transaction-scoped applying flag.",
  },
  {
    table: "sync_peers",
    domain: "device",
    mergeClass: "device-local",
    primaryKey: ["peer_id"],
    naturalKeys: noKeys,
    references: noRefs,
    notes: "What this machine last read from each peer. Meaningless on any other machine.",
  },
  {
    table: "sync_dirty",
    domain: "device",
    mergeClass: "device-local",
    primaryKey: ["entity_type", "entity_id"],
    naturalKeys: noKeys,
    references: noRefs,
    notes:
      "Change-capture marks written by this machine's capture triggers. The stamper drains them inside the same transaction when the write went through writeTransaction, or in a follow-up transaction right after a writeExclusive write; after a failed stamp they stay durable until the next write or backfill scan. Meaningless on any other machine.",
  },
  {
    table: "sync_entity_snapshot",
    domain: "device",
    mergeClass: "device-local",
    primaryKey: ["entity_type", "entity_id"],
    naturalKeys: noKeys,
    references: noRefs,
    notes:
      "The last stamped content of an entity (decoded record for field-clock tables, content hash for the rest, the value for a setting key). Rebuildable; it holds row contents, so it must never be published.",
  },
  {
    table: "sync_capture_state",
    domain: "device",
    mergeClass: "device-local",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: noRefs,
    notes:
      "Single row, present only while change capture is enabled: the hash of the installed capture-trigger set.",
  },
  {
    table: "schema_migrations",
    domain: "device",
    mergeClass: "device-local",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: noRefs,
  },
  {
    table: "app_settings",
    domain: "device",
    mergeClass: "device-local",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: noRefs,
    notes:
      "One JSON blob row. The table itself is never published; synced keys travel individually under entity_type 'setting', governed by SETTINGS_REGISTRY.",
  },
  {
    table: "rescuetime_snapshot_cache",
    domain: "device",
    mergeClass: "device-local",
    primaryKey: ["week_start_date", "kind", "credential_fingerprint"],
    naturalKeys: noKeys,
    references: noRefs,
    notes: "Cache keyed by a credential fingerprint.",
  },
  {
    table: "finance_alert_notifications",
    domain: "device",
    mergeClass: "device-local",
    primaryKey: ["alert_key", "notified_on_date"],
    naturalKeys: noKeys,
    references: noRefs,
    notes: "Records which desktop notifications this machine already showed.",
  },
  {
    table: "calendar_sync_settings",
    domain: "device",
    mergeClass: "device-local",
    primaryKey: ["id"],
    naturalKeys: noKeys,
    references: noRefs,
    notes: "Holds the OAuth client id and the connected account of this machine.",
  },
  {
    table: "calendar_sync_links",
    domain: "device",
    mergeClass: "device-local",
    primaryKey: ["task_id", "occurrence_key"],
    naturalKeys: noKeys,
    references: [{ column: "task_id", table: "gtd_tasks", kind: "soft" }],
    notes: "Mirror of one machine's external calendar; event ids are meaningless elsewhere.",
  },
  ...[
    { table: "email_triage_accounts", primaryKey: ["id"] },
    { table: "email_triage_aliases", primaryKey: ["id"] },
    { table: "email_triage_audit_events", primaryKey: ["id"] },
    { table: "email_triage_classification_attempts", primaryKey: ["id"] },
    { table: "email_triage_conversations", primaryKey: ["id"] },
    { table: "email_triage_desired_effects", primaryKey: ["id"] },
    { table: "email_triage_evaluations", primaryKey: ["id"] },
    { table: "email_triage_messages", primaryKey: ["id"] },
    { table: "email_triage_reviews", primaryKey: ["id"] },
    { table: "email_triage_settings", primaryKey: ["id"] },
  ].map(
    ({ table, primaryKey }): TableRegistration => ({
      table,
      domain: "device",
      mergeClass: "device-local",
      primaryKey,
      naturalKeys: noKeys,
      references: noRefs,
      notes: "Legacy email-triage table: mailbox state and account metadata stay on the machine.",
    }),
  ),
];

const TABLES_BY_NAME: ReadonlyMap<string, TableRegistration> = new Map(
  TABLE_REGISTRY.map((entry) => [entry.table, entry]),
);

if (TABLES_BY_NAME.size !== TABLE_REGISTRY.length) {
  throw new Error("Sync registry lists a table more than once");
}

// ---------------------------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------------------------

/** The registration for a table. Throws for a table the registry does not classify. */
export const getTableRegistration = (table: string): TableRegistration => {
  const entry = TABLES_BY_NAME.get(table);
  if (!entry) {
    throw new Error(`Table "${table}" is not classified in the sync registry`);
  }
  return entry;
};

export const isRegisteredTable = (table: string): boolean => TABLES_BY_NAME.has(table);

export const domainOfTable = (table: string): ClassificationDomain =>
  getTableRegistration(table).domain;

export const tablesInDomain = (domain: ClassificationDomain): string[] =>
  TABLE_REGISTRY.filter((entry) => entry.domain === domain).map((entry) => entry.table);

/** Every table that can appear in some bundle (everything that is not device-local). */
export const syncedTables = (): string[] =>
  TABLE_REGISTRY.filter((entry) => entry.domain !== DEVICE_DOMAIN).map((entry) => entry.table);

// ---------------------------------------------------------------------------------------------
// Canonical identity
// ---------------------------------------------------------------------------------------------

/** The natural keys of a table that the alias engine resolves (resolution `alias`). */
export const aliasKeysOf = (table: string): NaturalKey[] =>
  getTableRegistration(table).naturalKeys.filter((key) => key.resolution === "alias");

/**
 * True when two peers can mint different ids for one entity of this table and the engine merges
 * them under one canonical id: some natural key is resolved by `alias`. Such a table has a
 * single-column primary key (`registry.test.ts` pins it).
 */
export const isAliasableTable = (table: string): boolean =>
  TABLES_BY_NAME.has(table) && aliasKeysOf(table).length > 0;

/** Every aliasable table, in registry order. */
export const aliasableTables = (): string[] =>
  TABLE_REGISTRY.filter((entry) => isAliasableTable(entry.table)).map((entry) => entry.table);

/** The aliasable tables of one bundle domain: the entity types whose aliases travel in it. */
export const aliasableTablesInDomain = (domain: SyncDomain): string[] =>
  aliasableTables().filter((table) => getTableRegistration(table).domain === domain);

export interface InboundReference {
  /** The table holding the reference. */
  table: string;
  reference: TableReference;
}

/** Every declared reference TO `target`, from any registered table, in registry order. */
export const referencesTo = (target: string): InboundReference[] =>
  TABLE_REGISTRY.flatMap((entry) =>
    entry.references
      .filter((reference) => reference.table === target)
      .map((reference) => ({ table: entry.table, reference })),
  );

/**
 * True when the table may be written wholesale into a bundle of `domain`. A `by-entity-type`
 * sidecar is never publishable this way (its rows are routed by entity type); use
 * `isSidecarPublishable`.
 */
export const isTablePublishable = (table: string, domain: SyncDomain): boolean => {
  const entry = TABLES_BY_NAME.get(table);
  return (
    entry !== undefined &&
    entry.domain !== DEVICE_DOMAIN &&
    entry.domain !== BY_ENTITY_TYPE_DOMAIN &&
    entry.domain === domain
  );
};

/**
 * Guard for bundle filtering. A table may only be published in its own domain's bundle, and a
 * device-local table never. Unclassified tables throw rather than pass.
 */
export const assertTablePublishable = (table: string, domain: SyncDomain): void => {
  const entry = getTableRegistration(table);
  if (entry.domain === DEVICE_DOMAIN) {
    throw new Error(`Table "${table}" is device-local and is never published`);
  }
  if (entry.domain === BY_ENTITY_TYPE_DOMAIN) {
    throw new Error(
      `Table "${table}" is published per entity type; use assertSidecarPublishable instead`,
    );
  }
  if (entry.domain !== domain) {
    throw new Error(
      `Table "${table}" belongs to the "${entry.domain}" domain and cannot be published in a "${domain}" bundle`,
    );
  }
};

// ---------------------------------------------------------------------------------------------
// Sidecar routing
// ---------------------------------------------------------------------------------------------

const asSyncDomain = (table: string, domain: ClassificationDomain): SyncDomain => {
  if (!(SYNC_DOMAINS as readonly string[]).includes(domain)) {
    throw new Error(`Table "${table}" is classified "${domain}", which is not a bundle domain`);
  }
  return domain as SyncDomain;
};

/** `entity_type` value of a synced setting; its `entity_id` is the settings key. */
export const SETTING_ENTITY_TYPE = "setting";

/** True for sidecar tables whose rows are routed to a bundle by their `entity_type`. */
export const isEntityTypedSidecar = (table: string): boolean =>
  TABLES_BY_NAME.get(table)?.domain === BY_ENTITY_TYPE_DOMAIN;

/**
 * The bundle domain a row of an entity type travels in. `entityType` is a registered synced table
 * name, or `setting` (then `entityId` is the settings key and decides the scope). Throws for
 * device-local data (tables, device-scope settings, secrets), for sidecar tables used as entity
 * types, and for anything unregistered, so a row is never routed by guesswork.
 */
export const publishDomainOfEntityType = (entityType: string, entityId?: string): SyncDomain => {
  if (entityType === SETTING_ENTITY_TYPE) {
    if (entityId === undefined) {
      throw new Error("A setting sidecar row needs its settings key to resolve a domain");
    }
    const rule = settingRule(entityId);
    if (rule.secret === true || rule.scope === "device") {
      throw new Error(`Setting "${entityId}" is device-local and is never published`);
    }
    return rule.scope;
  }
  const entry = getTableRegistration(entityType);
  if (entry.domain === DEVICE_DOMAIN) {
    throw new Error(`Entity type "${entityType}" is device-local and is never published`);
  }
  if (entry.mergeClass === "sidecar") {
    throw new Error(`Sidecar table "${entityType}" is not an entity type`);
  }
  return asSyncDomain(entityType, entry.domain);
};

/**
 * The bundle domain a row of sidecar `table` is published in. Recurrence sidecars are `gtd`
 * regardless of arguments. A `by-entity-type` sidecar follows its row's `entity_type`
 * (and, for settings, its `entity_id`). Any other table throws.
 */
export const sidecarPublishDomain = (
  table: string,
  entityType?: string,
  entityId?: string,
): SyncDomain => {
  const entry = getTableRegistration(table);
  if (entry.mergeClass !== "sidecar") {
    throw new Error(`Table "${table}" is not a sync sidecar table`);
  }
  if (entry.domain === BY_ENTITY_TYPE_DOMAIN) {
    if (entityType === undefined) {
      throw new Error(`Sidecar table "${table}" needs an entity type to resolve a domain`);
    }
    return publishDomainOfEntityType(entityType, entityId);
  }
  return asSyncDomain(table, entry.domain);
};

/** True when the sidecar row may be written into a bundle of `domain`. Never throws. */
export const isSidecarPublishable = (
  table: string,
  domain: SyncDomain,
  entityType?: string,
  entityId?: string,
): boolean => {
  try {
    return sidecarPublishDomain(table, entityType, entityId) === domain;
  } catch {
    return false;
  }
};

export const assertSidecarPublishable = (
  table: string,
  domain: SyncDomain,
  entityType?: string,
  entityId?: string,
): void => {
  const owner = sidecarPublishDomain(table, entityType, entityId);
  if (owner !== domain) {
    throw new Error(
      `Sidecar row of "${table}" (${entityType ?? "no entity type"}) belongs to the "${owner}" domain and cannot be published in a "${domain}" bundle`,
    );
  }
};

// ---------------------------------------------------------------------------------------------
// Settings registry
// ---------------------------------------------------------------------------------------------

export type SettingMerge = "device" | "lww" | "monotonic-max" | "non-empty-wins";

/** `device` keys never merge; every other scope merges per key. Secrets are always `device`. */
export type SettingRule =
  | { scope: "device"; merge: "device"; secret?: true }
  | { scope: SyncDomain; merge: Exclude<SettingMerge, "device">; secret?: never };

export type SettingScope = SettingRule["scope"];

const device: SettingRule = { scope: "device", merge: "device" };
const secret: SettingRule = { scope: "device", merge: "device", secret: true };
const lww = (scope: SyncDomain): SettingRule => ({ scope, merge: "lww" });
const monotonicMax = (scope: SyncDomain): SettingRule => ({ scope, merge: "monotonic-max" });
const nonEmptyWins = (scope: SyncDomain): SettingRule => ({ scope, merge: "non-empty-wins" });

/**
 * One rule per `AppSettings` key. The `Record<keyof AppSettings, …>` type makes a missing key a
 * compile error, and an extra key too.
 */
export const SETTINGS_REGISTRY: Readonly<Record<keyof AppSettings, SettingRule>> = {
  // Reaches the work laptop. A deliberately short list: only add a key after review.
  language: lww("gtd"),
  gtdImportDoneAt: nonEmptyWins("gtd"),
  gtdReferencesMigrationDoneAt: nonEmptyWins("gtd"),
  gtdScheduledNormalizationDoneAt: nonEmptyWins("gtd"),
  gtdRecurringCollapseDoneAt: nonEmptyWins("gtd"),

  // Never leaves the machine.
  storageMode: device,
  aiApiKey: secret,
  rescuetimeApiKey: secret,
  llmBridgeToken: secret,
  llmBridgeEnabled: device,
  llmBridgePort: device,
  // Ambiguous (a base URL can embed credentials or name a LAN-only host): the more private scope.
  aiBaseUrl: device,
  aiPulseFirstOpenAt: device,
  autoBackupEnabled: device,
  autoBackupIntervalHours: device,
  backupDestinationDir: device,
  lastBackupAt: device,
  lastBackupPath: device,
  runInTray: device,
  launchAtLogin: device,
  // Multi-device sync's own switches: what a laptop syncs with can never be decided by a peer.
  multiDeviceSyncEnabled: device,
  syncProfile: device,
  syncGtdFolderDir: device,
  syncDeviceName: device,

  // Personal: AI preferences, pulse/pastor settings, relationship draws, one-time markers.
  aiEnabled: lww("personal"),
  aiModel: lww("personal"),
  aiPayloadScope: lww("personal"),
  aiSurfaceModels: lww("personal"),
  aiMaxTokens: lww("personal"),
  aiTimeoutMs: lww("personal"),
  aiMemoryEnabled: lww("personal"),
  aiPulseEnabled: lww("personal"),
  aiPulseSlots: lww("personal"),
  aiPulseNotifyEnabled: lww("personal"),
  aiPulseNotifyDays: lww("personal"),
  aiPulseMaxNotificationsPerDay: lww("personal"),
  aiPastorEnabled: lww("personal"),
  aiPastorCustomVerses: lww("personal"),
  aiCostPerMillionTokens: lww("personal"),
  dimancheNotesRelocatedAt: nonEmptyWins("personal"),
  aiMaxTokensUpgradeDoneAt: nonEmptyWins("personal"),
  relationshipDrawsEnabled: lww("personal"),
  relationshipDrawChildrenActivities: lww("personal"),
  relationshipDrawSpouseActivities: lww("personal"),
  relationshipDrawChildrenProcessedDate: monotonicMax("personal"),
  relationshipDrawSpouseProcessedDate: monotonicMax("personal"),
  previousDayReviewDoneDate: monotonicMax("personal"),

  // Finance: every `finance*` key.
  financeEnabled: lww("finance"),
  financeBaseCurrency: lww("finance"),
  financeAiCategorizationEnabled: lww("finance"),
  financeAiStatementEnabled: lww("finance"),
  financeAiAutoApplyEnabled: lww("finance"),
  financeAiAutoApplyMinConfidence: lww("finance"),
  financeAlertsOnToday: lww("finance"),
  financeCoachContextEnabled: lww("finance"),
  financeNotifyRunout: lww("finance"),
  financeSafetyBufferMinor: lww("finance"),
  financeCategoriesSeededAt: nonEmptyWins("finance"),
};

// ---------------------------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------------------------

export const settingKeys = (): (keyof AppSettings)[] =>
  Object.keys(SETTINGS_REGISTRY) as (keyof AppSettings)[];

/** The rule for a key. Throws for a key the registry does not classify (for example a stale blob). */
export const settingRule = (key: string): SettingRule => {
  if (!Object.hasOwn(SETTINGS_REGISTRY, key)) {
    throw new Error(`Setting "${key}" is not classified in the sync registry`);
  }
  return SETTINGS_REGISTRY[key as keyof AppSettings];
};

export const isRegisteredSetting = (key: string): key is keyof AppSettings =>
  Object.hasOwn(SETTINGS_REGISTRY, key);

export const settingScope = (key: string): SettingScope => settingRule(key).scope;

export const settingsKeysInScope = (scope: SettingScope): (keyof AppSettings)[] =>
  settingKeys().filter((key) => SETTINGS_REGISTRY[key].scope === scope);

export const isSecretSetting = (key: string): boolean => settingRule(key).secret === true;

/** True when the key may be written into a bundle of `domain`. Secrets and device keys never are. */
export const isSettingPublishable = (key: string, domain: SyncDomain): boolean => {
  if (!isRegisteredSetting(key)) return false;
  const rule = SETTINGS_REGISTRY[key];
  return rule.scope !== "device" && rule.secret !== true && rule.scope === domain;
};

export const assertSettingPublishable = (key: string, domain: SyncDomain): void => {
  const rule = settingRule(key);
  if (rule.secret === true) {
    throw new Error(`Setting "${key}" is a secret and is never published`);
  }
  if (rule.scope === "device") {
    throw new Error(`Setting "${key}" is device-local and is never published`);
  }
  if (rule.scope !== domain) {
    throw new Error(
      `Setting "${key}" belongs to the "${rule.scope}" domain and cannot be published in a "${domain}" bundle`,
    );
  }
};
