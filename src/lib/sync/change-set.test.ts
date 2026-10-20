import { describe, expect, it } from "vitest";
import {
  assertDomainAllowed,
  clocksOfChangeSet,
  MAX_ENTITY_ID_LENGTH,
  SYNC_FORMAT_VERSION,
  type SyncChangeSet,
  validateChangeSet,
} from "./change-set";
import { SyncApplyError, SyncChangeSetError, type SyncChangeSetErrorCode } from "./errors";
import { encodeHlc } from "./hlc";
import { WORK_PROFILE_DOMAINS } from "./registry";

const DEVICE = "dev:00000000-0000-4000-8000-000000000001";
const hlc = (ms: number, counter = 0) => encodeHlc(ms, counter, DEVICE);

const validEntity = () => ({
  table: "gtd_contexts",
  entityId: "context:home",
  row: { id: "context:home", name: "Home", created_at: "2026-10-01", updated_at: "2026-10-01" },
  fieldClocks: { name: hlc(1000), updated_at: hlc(1000) },
  rowHlc: hlc(1000),
  deletedAt: null as string | null,
});

const base = (): SyncChangeSet =>
  ({
    formatVersion: SYNC_FORMAT_VERSION,
    deviceId: DEVICE,
    domain: "gtd",
    schemaVersion: 43,
    hlcHigh: hlc(2000),
    entities: [validEntity()],
    unionRows: {},
    settings: [],
  }) as SyncChangeSet;

/** Builds a change set from the valid base with `mutate` applied to a deep copy. */
// biome-ignore lint/suspicious/noExplicitAny: fixtures edit untyped JSON change sets
type Draft = Record<string, any>;

const variant = (mutate: (draft: Draft) => void): unknown => {
  const draft = JSON.parse(JSON.stringify(base())) as Draft;
  mutate(draft);
  return draft;
};

const codeOf = (input: unknown): SyncChangeSetErrorCode | "no error" => {
  try {
    validateChangeSet(input);
    return "no error";
  } catch (error) {
    expect(error).toBeInstanceOf(SyncChangeSetError);
    return (error as SyncChangeSetError).code;
  }
};

describe("validateChangeSet accepts", () => {
  it("a well formed change set and returns it typed", () => {
    const result = validateChangeSet(base());
    expect(result.domain).toBe("gtd");
    expect(result.entities[0]?.table).toBe("gtd_contexts");
  });

  it("an empty change set", () => {
    expect(
      codeOf(
        variant((d) => {
          d.entities = [];
        }),
      ),
    ).toBe("no error");
  });

  it("extra columns and missing non-key columns in a row", () => {
    const input = variant((d) => {
      d.entities[0].row = {
        id: "context:home",
        name: "Home",
        from_the_future: "x",
        nested_flag: 1,
      };
    });
    expect(codeOf(input)).toBe("no error");
  });

  it("a tombstone with no row", () => {
    const input = variant((d) => {
      d.entities[0].row = null;
      d.entities[0].deletedAt = hlc(1500);
    });
    expect(codeOf(input)).toBe("no error");
  });

  it("a composite primary key written canonically", () => {
    const input = variant((d) => {
      d.domain = "personal";
      d.entities = [
        {
          table: "weekly_objective_results",
          entityId: JSON.stringify(["2026-10-04", "objective-1"]),
          row: { week_start_date: "2026-10-04", objective_id: "objective-1" },
          fieldClocks: {},
          rowHlc: hlc(1000),
          deletedAt: null,
        },
      ];
    });
    expect(codeOf(input)).toBe("no error");
  });

  it("an own __proto__ key from JSON without polluting anything", () => {
    const parsed = JSON.parse(
      `{"formatVersion":1,"deviceId":"${DEVICE}","domain":"gtd","schemaVersion":43,"hlcHigh":"${hlc(2000)}","entities":[{"table":"gtd_contexts","entityId":"c","row":{"id":"c","__proto__":"x"},"fieldClocks":{"__proto__":"${hlc(1000)}"},"rowHlc":"${hlc(1000)}","deletedAt":null}],"unionRows":{},"settings":[]}`,
    );
    const result = validateChangeSet(parsed);
    expect(Object.hasOwn(result.entities[0]?.fieldClocks ?? {}, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("an upper bound hlcHigh that is above every carried clock", () => {
    const input = variant((d) => {
      d.hlcHigh = hlc(9_000);
    });
    expect(codeOf(input)).toBe("no error");
    expect(clocksOfChangeSet(validateChangeSet(input))).toContain(hlc(1000));
  });
});

describe("validateChangeSet rejects", () => {
  const cases: [string, unknown, SyncChangeSetErrorCode][] = [
    ["a non-object", "nope", "invalid_shape"],
    ["null", null, "invalid_shape"],
    ["an array", [], "invalid_shape"],
    ["an unexpected top-level key", variant((d) => (d.extra = 1)), "invalid_shape"],
    ["a missing top-level key", variant((d) => delete d.settings), "invalid_shape"],
    [
      "an unknown format version",
      variant((d) => (d.formatVersion = 2)),
      "unsupported_format_version",
    ],
    [
      "a missing format version value",
      variant((d) => (d.formatVersion = "1")),
      "unsupported_format_version",
    ],
    ["an invalid device id", variant((d) => (d.deviceId = "laptop")), "invalid_shape"],
    ["an unknown domain", variant((d) => (d.domain = "device")), "invalid_shape"],
    ["a zero schema version", variant((d) => (d.schemaVersion = 0)), "invalid_shape"],
    ["a fractional schema version", variant((d) => (d.schemaVersion = 1.5)), "invalid_shape"],
    ["a malformed hlcHigh", variant((d) => (d.hlcHigh = "zzzz")), "invalid_clock"],
    [
      "an uppercase-hex hlcHigh",
      variant((d) => (d.hlcHigh = hlc(1000).replace("000000", "00000A"))),
      "invalid_clock",
    ],
    ["entities that are not an array", variant((d) => (d.entities = {})), "invalid_shape"],
    ["an entity with an extra key", variant((d) => (d.entities[0].extra = 1)), "invalid_shape"],
    ["an unknown table", variant((d) => (d.entities[0].table = "not_a_table")), "unknown_table"],
    ["a non-string table", variant((d) => (d.entities[0].table = 7)), "unknown_table"],
    [
      "a device-local table",
      variant((d) => (d.entities[0].table = "sync_identity")),
      "table_not_in_domain",
    ],
    [
      "the capture snapshot table",
      variant((d) => (d.entities[0].table = "sync_entity_snapshot")),
      "table_not_in_domain",
    ],
    [
      "a by-entity-type sidecar as an entity",
      variant((d) => (d.entities[0].table = "sync_entity_meta")),
      "table_not_in_domain",
    ],
    [
      "a personal table in a gtd change set",
      variant((d) => (d.entities[0].table = "daily_entries")),
      "table_not_in_domain",
    ],
    [
      "a finance table in a gtd change set",
      variant((d) => (d.entities[0].table = "finance_accounts")),
      "table_not_in_domain",
    ],
    [
      "a gtd table in a personal change set",
      variant((d) => (d.domain = "personal")),
      "table_not_in_domain",
    ],
    [
      "a union table sent as an entity",
      variant((d) => (d.entities[0].table = "gtd_task_events")),
      "invalid_entity",
    ],
    ["an empty entity id", variant((d) => (d.entities[0].entityId = "")), "invalid_entity_id"],
    ["a non-string entity id", variant((d) => (d.entities[0].entityId = 5)), "invalid_entity_id"],
    [
      "an oversized entity id",
      variant((d) => {
        const id = "x".repeat(MAX_ENTITY_ID_LENGTH + 1);
        d.entities[0].entityId = id;
        d.entities[0].row.id = id;
      }),
      "entity_id_too_long",
    ],
    [
      "a composite id that is not canonical JSON",
      variant((d) => {
        d.domain = "personal";
        d.entities = [
          {
            table: "weekly_objective_results",
            entityId: '["2026-10-04", "objective-1"]',
            row: { week_start_date: "2026-10-04", objective_id: "objective-1" },
            fieldClocks: {},
            rowHlc: hlc(1000),
            deletedAt: null,
          },
        ];
      }),
      "invalid_entity_id",
    ],
    [
      "a duplicate entity",
      variant((d) => d.entities.push(structuredClone(d.entities[0]))),
      "duplicate_entity",
    ],
    [
      "a row whose key disagrees with the entity id",
      variant((d) => (d.entities[0].row.id = "other")),
      "invalid_row",
    ],
    ["a row without its key column", variant((d) => delete d.entities[0].row.id), "invalid_row"],
    ["a boolean column value", variant((d) => (d.entities[0].row.name = true)), "invalid_row"],
    ["a nested column value", variant((d) => (d.entities[0].row.name = { a: 1 })), "invalid_row"],
    ["a row that is an array", variant((d) => (d.entities[0].row = [])), "invalid_row"],
    [
      "a tombstone with no deleted clock",
      variant((d) => {
        d.entities[0].row = null;
      }),
      "invalid_entity",
    ],
    [
      "a live entity carrying a deleted clock",
      variant((d) => (d.entities[0].deletedAt = hlc(1500))),
      "invalid_entity",
    ],
    [
      "a malformed field clock",
      variant((d) => (d.entities[0].fieldClocks.name = "later")),
      "invalid_clock",
    ],
    [
      "a non-string field clock",
      variant((d) => (d.entities[0].fieldClocks.name = 5)),
      "invalid_clock",
    ],
    ["a malformed rowHlc", variant((d) => (d.entities[0].rowHlc = "")), "invalid_clock"],
    [
      "a malformed deleted clock",
      variant((d) => {
        d.entities[0].row = null;
        d.entities[0].deletedAt = "yesterday";
      }),
      "invalid_clock",
    ],
    [
      "a clock above hlcHigh",
      variant((d) => (d.entities[0].fieldClocks.name = hlc(2001))),
      "hlc_high_too_low",
    ],
    [
      "a deleted clock above hlcHigh",
      variant((d) => {
        d.entities[0].row = null;
        d.entities[0].deletedAt = hlc(5000);
      }),
      "hlc_high_too_low",
    ],
    ["unionRows that is not an object", variant((d) => (d.unionRows = [])), "invalid_shape"],
    ["an unknown union table", variant((d) => (d.unionRows = { nope: [] })), "unknown_table"],
    [
      "a non-union table in unionRows",
      variant((d) => (d.unionRows = { gtd_tasks: [] })),
      "invalid_entity",
    ],
    [
      "a personal union table in a gtd change set",
      variant((d) => (d.unionRows = { ai_messages: [] })),
      "table_not_in_domain",
    ],
    [
      "union rows that are not an array",
      variant((d) => (d.unionRows = { gtd_task_events: {} })),
      "invalid_shape",
    ],
    [
      "a union row without its id",
      variant((d) => (d.unionRows = { gtd_task_events: [{ task_id: "t" }] })),
      "invalid_row",
    ],
    [
      "a duplicate union row",
      variant((d) => (d.unionRows = { gtd_task_events: [{ id: "e1" }, { id: "e1" }] })),
      "duplicate_entity",
    ],
    ["settings that are not an array", variant((d) => (d.settings = {})), "invalid_shape"],
    [
      "a setting entry with an extra key",
      variant((d) => (d.settings = [{ key: "language", value: "fr", rowHlc: hlc(1000), x: 1 }])),
      "invalid_shape",
    ],
    [
      "a secret setting",
      variant((d) => (d.settings = [{ key: "aiApiKey", value: "sk-secret", rowHlc: hlc(1000) }])),
      "setting_not_syncable",
    ],
    [
      "another secret setting",
      variant((d) => (d.settings = [{ key: "llmBridgeToken", value: "t", rowHlc: hlc(1000) }])),
      "setting_not_syncable",
    ],
    [
      "a device-scoped setting",
      variant(
        (d) => (d.settings = [{ key: "backupDestinationDir", value: "/x", rowHlc: hlc(1000) }]),
      ),
      "setting_not_syncable",
    ],
    [
      "a setting of another domain",
      variant((d) => (d.settings = [{ key: "aiModel", value: "m", rowHlc: hlc(1000) }])),
      "setting_not_syncable",
    ],
    [
      "an unknown setting",
      variant((d) => (d.settings = [{ key: "madeUp", value: 1, rowHlc: hlc(1000) }])),
      "setting_not_syncable",
    ],
    [
      "a prototype-named setting",
      variant((d) => (d.settings = [{ key: "constructor", value: 1, rowHlc: hlc(1000) }])),
      "setting_not_syncable",
    ],
    [
      "a duplicate setting",
      variant(
        (d) =>
          (d.settings = [
            { key: "language", value: "fr", rowHlc: hlc(1000) },
            { key: "language", value: "en", rowHlc: hlc(1100) },
          ]),
      ),
      "duplicate_entity",
    ],
    [
      "a setting with a malformed clock",
      variant((d) => (d.settings = [{ key: "language", value: "fr", rowHlc: "x" }])),
      "invalid_clock",
    ],
    [
      "a setting clock above hlcHigh",
      variant((d) => (d.settings = [{ key: "language", value: "fr", rowHlc: hlc(3000) }])),
      "hlc_high_too_low",
    ],
    [
      "a setting value that is not JSON",
      variant((d) => (d.settings = [{ key: "language", value: undefined, rowHlc: hlc(1000) }])),
      "invalid_setting_value",
    ],
  ];

  it.each(cases)("%s", (_name, input, code) => {
    expect(codeOf(input)).toBe(code);
  });

  it("a setting value nested beyond the depth limit", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 100; i += 1) deep = [deep];
    const input = variant((d) => {
      d.settings = [{ key: "language", value: null, rowHlc: hlc(1000) }];
    }) as { settings: { value: unknown }[] };
    expect(codeOf(input)).toBe("no error");
    (input.settings[0] as { value: unknown }).value = deep;
    expect(codeOf(input)).toBe("invalid_setting_value");
  });

  it("names the offending path", () => {
    try {
      validateChangeSet(variant((d) => (d.entities[0].fieldClocks.name = "later")));
      expect.unreachable();
    } catch (error) {
      expect((error as SyncChangeSetError).path).toBe("entities[0].fieldClocks.name");
    }
  });

  it("accepts a work-style gtd change set only with gtd settings", () => {
    const withLanguage = variant((d) => {
      d.settings = [{ key: "language", value: "en", rowHlc: hlc(1000) }];
    });
    expect(codeOf(withLanguage)).toBe("no error");
  });
});

describe("assertDomainAllowed", () => {
  it("passes a domain on the allow-list", () => {
    expect(() => assertDomainAllowed("gtd", WORK_PROFILE_DOMAINS)).not.toThrow();
    expect(() => assertDomainAllowed("finance", ["gtd", "personal", "finance"])).not.toThrow();
  });

  it("refuses personal and finance for the work profile, with a typed error", () => {
    for (const domain of ["personal", "finance"] as const) {
      try {
        assertDomainAllowed(domain, WORK_PROFILE_DOMAINS);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(SyncApplyError);
        expect((error as SyncApplyError).code).toBe("domain_not_allowed");
      }
    }
  });

  it("refuses everything for an empty allow-list", () => {
    expect(() => assertDomainAllowed("gtd", [])).toThrow(/not allowed/);
  });
});
