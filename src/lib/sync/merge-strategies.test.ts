import { describe, expect, it } from "vitest";
import {
  isTableSyncSupported,
  strategyForRegistration,
  strategyForTable,
  supportedEntityTables,
  supportedUnionTables,
  TABLE_STRATEGY_OVERRIDES,
  unsupportedTablesInDomain,
} from "./merge-strategies";
import { getTableRegistration, SYNC_DOMAINS, TABLE_REGISTRY, tablesInDomain } from "./registry";

describe("merge strategies", () => {
  it("supports exactly the field-clock and grow-only-union tables of the three domains", () => {
    expect(supportedEntityTables("gtd")).toEqual([
      "gtd_tasks",
      "gtd_projects",
      "gtd_contexts",
      "recurring_task_templates",
    ]);
    expect(supportedUnionTables("gtd")).toEqual(["gtd_task_events"]);
    expect(supportedEntityTables("personal")).toEqual([
      "daily_entries",
      "weekly_reviews",
      "monthly_reviews",
      "mid_week_decisions",
      "annual_goals",
    ]);
    expect(supportedUnionTables("personal")).toEqual(["ai_messages"]);
    expect(supportedEntityTables("finance")).toEqual([]);
    expect(supportedUnionTables("finance")).toEqual([]);
  });

  it("refuses every other merge class, naming the tables a later slice must add", () => {
    expect(unsupportedTablesInDomain("gtd")).toEqual([
      "pomodoro_sessions",
      "pomodoro_segments",
      "sync_recurrence_occurrences",
      "sync_recurrence_clears",
    ]);
    expect(unsupportedTablesInDomain("personal")).toEqual([
      "weekly_objectives",
      "weekly_objective_results",
      "ai_proposals",
      "ai_memories",
    ]);
    expect(unsupportedTablesInDomain("finance")).toEqual(tablesInDomain("finance"));
  });

  it("never supports device-local tables, by-entity-type sidecars, unknown tables or filtered tables", () => {
    for (const entry of TABLE_REGISTRY) {
      if (entry.domain === "device" || entry.domain === "by-entity-type") {
        expect(isTableSyncSupported(entry.table), entry.table).toBe(false);
      }
      if (entry.rowFilter) {
        expect(isTableSyncSupported(entry.table), entry.table).toBe(false);
      }
    }
    expect(isTableSyncSupported("not_a_table")).toBe(false);
    expect(strategyForTable("sync_identity")).toBeNull();
    expect(strategyForTable("sync_conflicts")).toBeNull();
  });

  it("derives a supported table's strategy from the registry's merge class", () => {
    for (const domain of SYNC_DOMAINS) {
      for (const table of supportedEntityTables(domain)) {
        expect(strategyForTable(table)).toEqual({ kind: "field-clock" });
      }
      for (const table of supportedUnionTables(domain)) {
        expect(strategyForTable(table)).toEqual({ kind: "grow-only-union" });
      }
    }
  });

  it("has no per-table override yet", () => {
    expect(Object.keys(TABLE_STRATEGY_OVERRIDES)).toEqual([]);
  });

  it("never supports a table with a rowFilter, even one that would otherwise merge generically", () => {
    // The guard is what keeps filtered-out rows (a running Pomodoro) from leaking through a
    // generic path if a registry edit ever gave such a table a generic merge class.
    const plain = getTableRegistration("gtd_projects");
    expect(strategyForRegistration(plain)).toEqual({ kind: "field-clock" });
    expect(
      strategyForRegistration({
        ...plain,
        rowFilter: { publishWhen: "status = 'x'", localOnly: "the rest stays local" },
      }),
    ).toBeNull();
    const union = getTableRegistration("gtd_task_events");
    expect(strategyForRegistration(union)).toEqual({ kind: "grow-only-union" });
    expect(
      strategyForRegistration({
        ...union,
        rowFilter: { publishWhen: "x", localOnly: "y" },
      }),
    ).toBeNull();
  });

  it("does not support a table whose foreign key handling is pending, but still merges one whose lifecycle merge is", () => {
    const plain = getTableRegistration("gtd_projects");
    expect(strategyForRegistration({ ...plain, referencesMergePending: true })).toBeNull();
    expect(strategyForRegistration({ ...plain, lifecycleMergePending: true })).toEqual({
      kind: "field-clock",
    });
    expect(isTableSyncSupported("weekly_objectives")).toBe(false);
    expect(isTableSyncSupported("weekly_objective_results")).toBe(false);
    expect(isTableSyncSupported("gtd_tasks")).toBe(true);
  });
});
