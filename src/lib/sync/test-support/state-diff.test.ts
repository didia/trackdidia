import { describe, expect, it } from "vitest";
import { diffDomainStates, diffStates } from "./state-diff";

/** A diff that cannot see a difference makes the property tests vacuous: pin its keys. */

const occurrence = (due_date: string, outcome: string) => ({
  template_id: "tpl",
  due_date,
  outcome,
  outcome_hlc: "h",
  device_id: "d",
});

describe("state diff", () => {
  it("is empty for equal states and ignores row order", () => {
    const rows = [occurrence("2026-10-01", "active"), occurrence("2026-10-02", "missed")];
    expect(
      diffStates(
        { tables: { sync_recurrence_occurrences: rows } },
        { tables: { sync_recurrence_occurrences: [...rows].reverse() } },
      ),
    ).toEqual([]);
  });

  it("sees a difference between two occurrences of the same template (composite key)", () => {
    const left = [occurrence("2026-10-01", "active"), occurrence("2026-10-02", "active")];
    const right = [occurrence("2026-10-01", "active"), occurrence("2026-10-02", "completed")];
    const lines = diffStates(
      { tables: { sync_recurrence_occurrences: left } },
      { tables: { sync_recurrence_occurrences: right } },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(".outcome");
  });

  it("sees a difference between two snapshots of the same account (account_id, as_of_date)", () => {
    const snapshot = (as_of_date: string, balance_minor: number) => ({
      account_id: "acc",
      as_of_date,
      balance_minor,
      source: "statement",
    });
    const lines = diffStates(
      {
        tables: {
          finance_account_balance_snapshots: [snapshot("2026-09-30", 1), snapshot("2026-10-31", 2)],
        },
      },
      {
        tables: {
          finance_account_balance_snapshots: [snapshot("2026-09-30", 1), snapshot("2026-10-31", 3)],
        },
      },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(".balance_minor");
  });

  it("sees a difference between merchant memories of one merchant (merchant_key, account_id, sign)", () => {
    const memory = (sign: number, category_id: string) => ({
      merchant_key: "IGA",
      account_id: "acc",
      sign,
      category_id,
    });
    const lines = diffStates(
      { tables: { finance_merchant_memory: [memory(-1, "a"), memory(1, "a")] } },
      { tables: { finance_merchant_memory: [memory(-1, "a"), memory(1, "b")] } },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(".category_id");
  });

  it("keys meta and snapshots by entity and aliases by alias id", () => {
    const meta = (entity_id: string, row_hlc: string) => ({
      entity_type: "gtd_tasks",
      entity_id,
      row_hlc,
    });
    expect(
      diffStates(
        { meta: [meta("a", "1"), meta("b", "2")] },
        { meta: [meta("a", "1"), meta("b", "3")] },
      ),
    ).toHaveLength(1);
    const alias = (alias_id: string, canonical_id: string) => ({
      entity_type: "gtd_tasks",
      alias_id,
      canonical_id,
    });
    expect(
      diffStates(
        { aliases: [alias("x", "a"), alias("y", "a")] },
        { aliases: [alias("x", "a"), alias("y", "b")] },
      ),
    ).toHaveLength(1);
  });

  it("reports missing rows, duplicate keys, settings and labels the domain", () => {
    expect(
      diffStates(
        { tables: { gtd_contexts: [{ id: "a" }, { id: "b" }] }, settings: { language: "fr" } },
        { tables: { gtd_contexts: [{ id: "a" }] }, settings: { language: "en" } },
      ),
    ).toEqual([
      expect.stringContaining("only in the first"),
      expect.stringContaining("setting language"),
    ]);
    expect(
      diffStates(
        { tables: { gtd_contexts: [{ id: "a" }, { id: "a" }] } },
        { tables: { gtd_contexts: [{ id: "a" }] } },
      ),
    ).toEqual([expect.stringContaining("duplicate keys in the first")]);
    expect(
      diffDomainStates(
        { gtd: { tables: { gtd_contexts: [{ id: "a" }] } } },
        { gtd: { tables: {} } },
      )[0],
    ).toMatch(/^\[gtd\] /);
  });
});
