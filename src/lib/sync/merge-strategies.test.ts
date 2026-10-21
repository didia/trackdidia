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
  it("supports every field-clock, grow-only-union and row-clock table, each through its rule", () => {
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
      "ai_memories",
    ]);
    expect(supportedUnionTables("personal")).toEqual(["ai_messages"]);
    expect(supportedEntityTables("finance")).toEqual([
      "finance_people",
      "finance_accounts",
      "finance_categories",
      "finance_transactions",
      "finance_transaction_splits",
      "finance_category_suggestions",
      "finance_rules",
      "finance_merchant_memory",
      "finance_budget_entries",
      "finance_budget_months",
      "finance_recurring_series",
      "finance_import_profiles",
      "finance_import_batches",
      "finance_account_balance_snapshots",
    ]);
    expect(supportedUnionTables("finance")).toEqual([]);
  });

  it("refuses only the recurrence sidecars, which travel in SyncChangeSet.recurrence", () => {
    expect(unsupportedTablesInDomain("gtd")).toEqual([
      "sync_recurrence_occurrences",
      "sync_recurrence_clears",
    ]);
    expect(unsupportedTablesInDomain("personal")).toEqual([]);
    expect(unsupportedTablesInDomain("finance")).toEqual([]);
    // Every other table of every bundle domain has a strategy, none is half-handled.
    for (const domain of SYNC_DOMAINS) {
      for (const table of tablesInDomain(domain)) {
        if (getTableRegistration(table).mergeClass === "sidecar") continue;
        expect(isTableSyncSupported(table), table).toBe(true);
      }
    }
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
      expect(strategy?.kind, entry.table).toBe("row-clock");
    }
    expect(strategyForTable("finance_account_balance_snapshots")).toEqual({
      kind: "row-clock",
      rule: "finance-balance-snapshot",
    });
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

  it("layers rules on exactly the tables that need more than their merge class", () => {
    expect(TABLE_STRATEGY_OVERRIDES).toEqual({
      gtd_tasks: { kind: "field-clock", rule: "gtd-task" },
      recurring_task_templates: { kind: "field-clock", rule: "recurring-template" },
      pomodoro_sessions: { kind: "row-clock", rule: "pomodoro-session" },
      pomodoro_segments: { kind: "row-clock", rule: "pomodoro-segment" },
      ai_proposals: { kind: "row-clock", rule: "ai-proposal" },
      finance_transactions: { kind: "row-clock", rule: "finance-transaction" },
      finance_transaction_splits: { kind: "row-clock", rule: "finance-split" },
      finance_category_suggestions: { kind: "row-clock", rule: "finance-suggestion" },
      finance_account_balance_snapshots: { kind: "row-clock", rule: "finance-balance-snapshot" },
    });
    // Every other row-clock table takes the generic whole-row rule from its merge class.
    for (const table of [
      "finance_accounts",
      "finance_rules",
      "finance_import_batches",
      "ai_memories",
    ]) {
      expect(rowClockRuleOf(table), table).toBe("generic-row");
    }
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
