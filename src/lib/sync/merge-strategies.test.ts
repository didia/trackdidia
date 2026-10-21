import { describe, expect, it } from "vitest";
import {
  fieldClockRuleOf,
  isTableSyncSupported,
  rowClockRuleOf,
  strategyForRegistration,
  strategyForTable,
  supportedEntityTables,
  supportedUnionTables,
  TABLE_STRATEGY_OVERRIDES,
  unsupportedTablesInDomain,
} from "./merge-strategies";
import { getTableRegistration, SYNC_DOMAINS, TABLE_REGISTRY, tablesInDomain } from "./registry";

describe("merge strategies", () => {
  it("supports exactly the field-clock, grow-only-union and the three ruled row-clock tables", () => {
    expect(supportedEntityTables("gtd")).toEqual([
      "gtd_tasks",
      "gtd_projects",
      "gtd_contexts",
      "recurring_task_templates",
      "pomodoro_sessions",
      "pomodoro_segments",
    ]);
    expect(supportedUnionTables("gtd")).toEqual(["gtd_task_events"]);
    expect(supportedEntityTables("personal")).toEqual([
      "daily_entries",
      "weekly_reviews",
      "monthly_reviews",
      "mid_week_decisions",
      "annual_goals",
      "weekly_objectives",
      "weekly_objective_results",
      "ai_proposals",
    ]);
    expect(supportedUnionTables("personal")).toEqual(["ai_messages"]);
    expect(supportedEntityTables("finance")).toEqual([]);
    expect(supportedUnionTables("finance")).toEqual([]);
  });

  it("refuses every other merge class, naming the tables a later slice must add", () => {
    expect(unsupportedTablesInDomain("gtd")).toEqual([
      "sync_recurrence_occurrences",
      "sync_recurrence_clears",
    ]);
    expect(unsupportedTablesInDomain("personal")).toEqual(["ai_memories"]);
    expect(unsupportedTablesInDomain("finance")).toEqual(tablesInDomain("finance"));
  });

  it("never supports device-local tables, by-entity-type sidecars or unknown tables", () => {
    for (const entry of TABLE_REGISTRY) {
      if (entry.domain === "device" || entry.domain === "by-entity-type") {
        expect(isTableSyncSupported(entry.table), entry.table).toBe(false);
      }
    }
    expect(isTableSyncSupported("not_a_table")).toBe(false);
    expect(strategyForTable("sync_identity")).toBeNull();
    expect(strategyForTable("sync_conflicts")).toBeNull();
  });

  it("supports a table with a rowFilter only through a row-clock rule that owns the filter", () => {
    for (const entry of TABLE_REGISTRY.filter((candidate) => candidate.rowFilter)) {
      const strategy = strategyForTable(entry.table);
      // The finance snapshot filter has no rule yet (next slice): refused.
      expect(strategy === null || strategy.kind === "row-clock", entry.table).toBe(true);
    }
    expect(strategyForTable("finance_account_balance_snapshots")).toBeNull();
    expect(strategyForTable("pomodoro_sessions")).toEqual({
      kind: "row-clock",
      rule: "pomodoro-session",
    });
  });

  it("derives a supported table's strategy from the registry's merge class or its override", () => {
    for (const domain of SYNC_DOMAINS) {
      for (const table of supportedEntityTables(domain)) {
        expect(strategyForTable(table)).toMatchObject({
          kind:
            getTableRegistration(table).mergeClass === "field-clock" ? "field-clock" : "row-clock",
        });
      }
      for (const table of supportedUnionTables(domain)) {
        expect(strategyForTable(table)).toEqual({ kind: "grow-only-union" });
      }
    }
  });

  it("layers the GTD rules on exactly the task and the recurring template", () => {
    expect(TABLE_STRATEGY_OVERRIDES).toEqual({
      gtd_tasks: { kind: "field-clock", rule: "gtd-task" },
      recurring_task_templates: { kind: "field-clock", rule: "recurring-template" },
      pomodoro_sessions: { kind: "row-clock", rule: "pomodoro-session" },
      pomodoro_segments: { kind: "row-clock", rule: "pomodoro-segment" },
      ai_proposals: { kind: "row-clock", rule: "ai-proposal" },
    });
    expect(rowClockRuleOf("ai_proposals")).toBe("ai-proposal");
    expect(rowClockRuleOf("gtd_tasks")).toBeUndefined();
    expect(fieldClockRuleOf("gtd_tasks")).toBe("gtd-task");
    expect(fieldClockRuleOf("recurring_task_templates")).toBe("recurring-template");
    expect(fieldClockRuleOf("gtd_projects")).toBeUndefined();
    expect(fieldClockRuleOf("daily_entries")).toBeUndefined();
    // They stay entity tables: published and applied through the field-clock path.
    expect(supportedEntityTables("gtd")).toContain("gtd_tasks");
    expect(supportedEntityTables("gtd")).toContain("recurring_task_templates");
  });

  it("never gives a filtered table a generic path, even one that would otherwise merge generically", () => {
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

  it("supports the former foreign-key tables: references are handled by apply-references.ts", () => {
    for (const table of ["weekly_objectives", "weekly_objective_results", "ai_proposals"]) {
      expect(isTableSyncSupported(table), table).toBe(true);
    }
    expect(isTableSyncSupported("gtd_tasks")).toBe(true);
  });
});
