import { describe, expect, it } from "vitest";
import { dedupeHash } from "../finance/import-profile";
import {
  MAX_OCCURRENCE_INDEX,
  type Resolver,
  rederiveDedupeHash,
  rewriteEmbeddedIds,
  rewriteEntityId,
  rewriteIdentity,
  rewriteIdListText,
  rewriteJsonText,
  rewriteReferences,
  rewriteRulesOf,
  rewriteSyncRow,
  rewriteTransferGroup,
  tablesWithRewriteRules,
} from "./reference-rewrite";
import { isAliasableTable, referencesTo, TABLE_REGISTRY } from "./registry";

const resolver =
  (aliases: Record<string, Record<string, string>>): Resolver =>
  (entityType, id) =>
    aliases[entityType]?.[id] ?? id;

const tasks = resolver({ gtd_tasks: { "task:z": "task:a", "task:y": "task:a" } });

describe("which references get rewritten", () => {
  it("covers every declared reference to an aliasable table, and only those", () => {
    for (const entry of TABLE_REGISTRY) {
      const rules = rewriteRulesOf(entry.table);
      const expected = entry.references.filter((reference) => isAliasableTable(reference.table));
      expect(rules.map((rule) => `${rule.column}->${rule.target}`).sort(), entry.table).toEqual(
        expected.map((reference) => `${reference.column}->${reference.table}`).sort(),
      );
    }
  });

  it("lists the tables that hold such references, in registry order", () => {
    expect(tablesWithRewriteRules()).toEqual([
      "gtd_tasks",
      "gtd_task_events",
      "recurring_task_templates",
      "pomodoro_segments",
      "ai_proposals",
      "finance_transactions",
      "finance_transaction_splits",
      "finance_category_suggestions",
      "finance_rules",
      "finance_merchant_memory",
      "finance_recurring_series",
      "finance_import_profiles",
      "finance_import_batches",
      "finance_account_balance_snapshots",
      "calendar_sync_links",
    ]);
  });

  it("gives every json-payload rule a parseable path and every derived rule a derivation", () => {
    for (const entry of TABLE_REGISTRY) {
      for (const reference of entry.references) {
        if (reference.kind === "json-payload") {
          expect(reference.path, `${entry.table}.${reference.column}`).toMatch(
            /^\$\.[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*(\[\])?$/,
          );
        } else {
          expect(reference.path, `${entry.table}.${reference.column}`).toBeUndefined();
        }
        if (reference.kind === "derived") {
          expect(reference.derive, `${entry.table}.${reference.column}`).toBeDefined();
        } else {
          expect(reference.derive, `${entry.table}.${reference.column}`).toBeUndefined();
        }
      }
    }
  });

  // One row per rule, built from the registry alone: a new declared reference to an aliasable table
  // (or a new kind) fails here until the rewriter handles it.
  it.each(
    TABLE_REGISTRY.flatMap((entry) =>
      entry.references
        .filter((reference) => isAliasableTable(reference.table))
        .map(
          (reference) =>
            [
              `${entry.table}.${reference.column} (${reference.kind})`,
              entry.table,
              reference,
            ] as const,
        ),
    ),
  )("rewrites %s", (_name, table, reference) => {
    const alias = "ALIAS-ID";
    const root = "A-ROOT-ID";
    const resolve = resolver({ [reference.table]: { [alias]: root } });
    let value: unknown;
    let expected: unknown;
    const row: Record<string, unknown> = {};
    switch (reference.kind) {
      case "foreign-key":
      case "soft":
      case "polymorphic":
        value = alias;
        expected = root;
        break;
      case "json-id-list":
        value = JSON.stringify(["keep", alias]);
        expected = JSON.stringify(["keep", root]);
        break;
      case "json-payload": {
        const path = reference.path as string;
        const keys = (path.endsWith("[]") ? path.slice(2, -2) : path.slice(2)).split(".");
        const build = (id: string): unknown =>
          [...keys].reverse().reduce<unknown>(
            (inner, key, index) => ({
              [key]: index === 0 && path.endsWith("[]") ? ["keep", inner] : inner,
            }),
            id,
          );
        value = JSON.stringify(build(alias));
        expected = JSON.stringify(build(root));
        break;
      }
      case "derived":
        if (reference.derive === "transfer-group") {
          value = `transfer:${alias}:ZZZ`;
          expected = `transfer:${root}:ZZZ`;
        } else if (reference.derive === "embedded-id") {
          value = `weekly_carryover:2026-04-19:${alias}`;
          expected = `weekly_carryover:2026-04-19:${root}`;
        } else if (reference.derive === "account-dedupe-hash") {
          Object.assign(row, {
            account_id: alias,
            posted_date: "2026-04-01",
            amount_minor: -1234,
            currency: "CAD",
            description_raw: "IGA 1234",
          });
          const base = {
            postedDate: "2026-04-01",
            amountMinor: -1234,
            currency: "CAD",
            descriptionRaw: "IGA 1234",
            occurrenceIndex: 0,
          };
          value = dedupeHash({ ...base, accountId: alias });
          expected = dedupeHash({ ...base, accountId: root });
        } else {
          throw new Error(`no fixture for derivation ${String(reference.derive)}`);
        }
        break;
      default:
        throw new Error(`no fixture for reference kind ${String(reference.kind)}`);
    }
    row[reference.column] = value;
    const rewritten = rewriteReferences(table, row, resolve);
    expect(rewritten?.[reference.column]).toEqual(expected);
    // A row that names no alias is left alone.
    expect(rewriteReferences(table, row, resolver({}))).toBeNull();
  });
});

describe("plain references", () => {
  it("rewrites a task's project, parent and a split's transaction, and nothing else", () => {
    const resolve = resolver({
      gtd_tasks: { "task:z": "task:a" },
      gtd_projects: { "proj:z": "proj:a" },
    });
    expect(
      rewriteReferences(
        "gtd_tasks",
        { id: "task:child", title: "task:z", project_id: "proj:z", parent_task_id: "task:z" },
        resolve,
      ),
    ).toEqual({
      id: "task:child",
      title: "task:z",
      project_id: "proj:a",
      parent_task_id: "task:a",
    });
  });

  it("returns null when nothing changes and never touches unrelated tables", () => {
    expect(rewriteReferences("gtd_tasks", { project_id: "p" }, tasks)).toBeNull();
    expect(rewriteReferences("daily_entries", { date: "task:z" }, tasks)).toBeNull();
  });

  it("leaves NULL and non-string values alone", () => {
    expect(rewriteReferences("gtd_task_events", { task_id: null }, tasks)).toBeNull();
    expect(rewriteReferences("gtd_task_events", { task_id: 7 }, tasks)).toBeNull();
  });
});

describe("ids inside JSON documents", () => {
  const accounts = resolver({ finance_accounts: { "acc-b": "acc-a" } });

  it("rewrites account ids in a rule matcher list and keeps everything else byte for byte", () => {
    const matcher = JSON.stringify({
      descriptionContains: "acc-b",
      accountIds: ["acc-b", "acc-x"],
      personId: "p",
    });
    expect(
      rewriteReferences("finance_rules", { matcher_json: matcher, actions_json: "{}" }, accounts),
    ).toEqual({
      matcher_json: JSON.stringify({
        descriptionContains: "acc-b",
        accountIds: ["acc-a", "acc-x"],
        personId: "p",
      }),
      actions_json: "{}",
    });
  });

  it("rewrites a gtd_action proposal's taskId and the applied entity", () => {
    const payload = JSON.stringify({ taskId: "task:z", taskTitle: "task:z", action: "drop" });
    expect(
      rewriteReferences(
        "ai_proposals",
        { payload_json: payload, applied_entity_id: "task:z" },
        tasks,
      ),
    ).toEqual({
      payload_json: JSON.stringify({ taskId: "task:a", taskTitle: "task:z", action: "drop" }),
      applied_entity_id: "task:a",
    });
  });

  it("does not rewrite an id that is not at the declared path", () => {
    const payload = JSON.stringify({ other: { taskId: "task:z" }, notes: "task:z" });
    expect(rewriteReferences("ai_proposals", { payload_json: payload }, tasks)).toBeNull();
  });

  it("leaves an unparsable document alone", () => {
    expect(rewriteReferences("ai_proposals", { payload_json: "{nope task:z" }, tasks)).toBeNull();
  });

  it("supports nested paths and arrays, and rejects unsupported paths", () => {
    const map = (id: string) => (id === "x" ? "y" : id);
    expect(rewriteJsonText('{"a":{"b":["x","k"]}}', "$.a.b[]", map)).toBe('{"a":{"b":["y","k"]}}');
    expect(rewriteJsonText('{"a":{"b":"x"}}', "$.a.b", map)).toBe('{"a":{"b":"y"}}');
    expect(rewriteJsonText('{"a":{"b":"k"}}', "$.a.b", map)).toBeNull();
    expect(() => rewriteJsonText("{}", "a.b", map)).toThrow(/Unsupported/);
    expect(() => rewriteJsonText("{}", "$.a[0]", map)).toThrow(/Unsupported/);
  });
});

describe("id lists", () => {
  it("rewrites the ids of a JSON array and leaves everything else alone", () => {
    const map = (id: string) => (id === "ctx-b" ? "ctx-a" : id);
    expect(rewriteIdListText('["ctx-b","ctx-c",7]', map)).toBe('["ctx-a","ctx-c",7]');
    expect(rewriteIdListText('["ctx-c"]', map)).toBeNull();
    expect(rewriteIdListText("{}", map)).toBeNull();
    expect(rewriteIdListText("nope", map)).toBeNull();
  });
});

describe("derived values", () => {
  const txns = resolver({ finance_transactions: { "finance-txn:z": "finance-txn:a" } });

  it("rebuilds a transfer group from the canonical ids, sorted like the app builds it", () => {
    expect(
      rewriteTransferGroup("transfer:finance-txn:b:finance-txn:z", (id) =>
        txns("finance_transactions", id),
      ),
    ).toBe("transfer:finance-txn:a:finance-txn:b");
    expect(
      rewriteTransferGroup("transfer:finance-txn:z:finance-txn:zz", (id) =>
        txns("finance_transactions", id),
      ),
    ).toBe("transfer:finance-txn:a:finance-txn:zz");
    // Untouched groups, other prefixes and non-groups stay.
    expect(
      rewriteTransferGroup("transfer:finance-txn:b:finance-txn:c", (id) =>
        txns("finance_transactions", id),
      ),
    ).toBe("transfer:finance-txn:b:finance-txn:c");
    expect(
      rewriteTransferGroup("pair:finance-txn:z", (id) => txns("finance_transactions", id)),
    ).toBe("pair:finance-txn:z");
  });

  it("rewrites an alias id embedded in an event dedupe key, whole pieces only", () => {
    const map = (id: string) => tasks("gtd_tasks", id);
    expect(rewriteEmbeddedIds("weekly_carryover:2026-04-19:task:z", map)).toBe(
      "weekly_carryover:2026-04-19:task:a",
    );
    expect(rewriteEmbeddedIds("task_moved:pullback:task:y:2026-04-20", map)).toBe(
      "task_moved:pullback:task:a:2026-04-20",
    );
    expect(rewriteEmbeddedIds("weekly_carryover:2026-04-19:task:zz", map)).toBe(
      "weekly_carryover:2026-04-19:task:zz",
    );
    expect(rewriteEmbeddedIds("weekly_carryover:2026-04-19:xtask:z", map)).toBe(
      "weekly_carryover:2026-04-19:xtask:z",
    );
  });

  it("re-derives a transaction's dedupe hash for the canonical account, for any occurrence index", () => {
    const line = {
      postedDate: "2026-04-01",
      amountMinor: -1234,
      currency: "CAD",
      descriptionRaw: "IGA  1234",
    };
    for (const occurrenceIndex of [0, 1, 7, MAX_OCCURRENCE_INDEX]) {
      const row = {
        account_id: "acc-b",
        posted_date: line.postedDate,
        amount_minor: line.amountMinor,
        currency: line.currency,
        description_raw: line.descriptionRaw,
        dedupe_hash: dedupeHash({ ...line, accountId: "acc-b", occurrenceIndex }),
      };
      expect(rederiveDedupeHash(row, "acc-b", "acc-a")).toBe(
        dedupeHash({ ...line, accountId: "acc-a", occurrenceIndex }),
      );
    }
  });

  it("leaves a hash it cannot re-derive (a manual transaction) as it is", () => {
    const row = {
      account_id: "acc-b",
      posted_date: "2026-04-01",
      amount_minor: -1,
      currency: "CAD",
      description_raw: "x",
      dedupe_hash: "manual:123",
    };
    expect(rederiveDedupeHash(row, "acc-b", "acc-a")).toBeNull();
    const rewritten = rewriteReferences(
      "finance_transactions",
      row,
      resolver({ finance_accounts: { "acc-b": "acc-a" } }),
    );
    expect(rewritten).toMatchObject({ account_id: "acc-a", dedupe_hash: "manual:123" });
  });

  it("moves the whole transaction to the canonical account in one rewrite", () => {
    const base = {
      postedDate: "2026-04-01",
      amountMinor: -50,
      currency: "CAD",
      descriptionRaw: "CAFE",
    };
    const row = {
      id: "finance-txn:1",
      account_id: "acc-b",
      posted_date: base.postedDate,
      amount_minor: base.amountMinor,
      currency: base.currency,
      description_raw: base.descriptionRaw,
      dedupe_hash: dedupeHash({ ...base, accountId: "acc-b", occurrenceIndex: 0 }),
      transfer_group_id: null,
    };
    expect(
      rewriteReferences(
        "finance_transactions",
        row,
        resolver({ finance_accounts: { "acc-b": "acc-a" } }),
      ),
    ).toEqual({
      ...row,
      account_id: "acc-a",
      dedupe_hash: dedupeHash({ ...base, accountId: "acc-a", occurrenceIndex: 0 }),
    });
  });
});

describe("identity and keys", () => {
  it("rewrites an aliasable table's own id", () => {
    expect(rewriteIdentity("gtd_tasks", { id: "task:z", title: "x" }, tasks)).toEqual({
      id: "task:a",
      title: "x",
    });
    expect(rewriteIdentity("gtd_tasks", { id: "task:q" }, tasks)).toBeNull();
    expect(rewriteIdentity("gtd_contexts", { id: "task:z" }, tasks)).toBeNull();
  });

  it("does identity and references in one go", () => {
    const resolve = resolver({ gtd_tasks: { "task:z": "task:a", "task:y": "task:a" } });
    expect(
      rewriteSyncRow("gtd_tasks", { id: "task:z", parent_task_id: "task:y" }, resolve),
    ).toEqual({
      id: "task:a",
      parent_task_id: "task:a",
    });
  });

  it("rewrites entity ids built from a reference (composite primary keys)", () => {
    const accounts = resolver({ finance_accounts: { "acc-b": "acc-a" } });
    expect(
      rewriteEntityId("finance_merchant_memory", JSON.stringify(["IGA", "acc-b", -1]), accounts),
    ).toBe(JSON.stringify(["IGA", "acc-a", -1]));
    expect(
      rewriteEntityId(
        "finance_account_balance_snapshots",
        JSON.stringify(["acc-b", "2026-04-30"]),
        accounts,
      ),
    ).toBe(JSON.stringify(["acc-a", "2026-04-30"]));
    expect(
      rewriteEntityId("finance_merchant_memory", JSON.stringify(["IGA", "acc-q", -1]), accounts),
    ).toBe(JSON.stringify(["IGA", "acc-q", -1]));
    expect(rewriteEntityId("finance_accounts", "acc-b", accounts)).toBe("acc-a");
    expect(rewriteEntityId("daily_entries", "2026-04-01", accounts)).toBe("2026-04-01");
  });

  it("ignores a malformed composite entity id", () => {
    expect(rewriteEntityId("finance_merchant_memory", "not json", resolver({}))).toBe("not json");
  });

  it("lists who points at tasks (the engine's view of the registry)", () => {
    expect(
      referencesTo("gtd_tasks")
        .map((item) => `${item.table}.${item.reference.column}`)
        .sort(),
    ).toEqual(
      [
        "ai_proposals.applied_entity_id",
        "ai_proposals.payload_json",
        "calendar_sync_links.task_id",
        "gtd_task_events.dedupe_key",
        "gtd_task_events.task_id",
        "gtd_tasks.parent_task_id",
        "pomodoro_segments.task_id",
      ].sort(),
    );
  });
});
