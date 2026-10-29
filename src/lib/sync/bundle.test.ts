// @vitest-environment node
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SYNC_FORMAT_VERSION, type SyncChangeSet, validateChangeSet } from "./change-set";
import {
  BUNDLE_MAGIC,
  decodeBundle,
  encodeBundle,
  MAX_BUNDLE_LINE_CHARS,
  MAX_DECODED_BUNDLE_BYTES,
  MAX_ENCODED_BUNDLE_BYTES,
  SyncBundleError,
  type SyncBundleErrorCode,
} from "./bundle";
import { encodeHlc } from "./hlc";

const DEVICE = "dev:00000000-0000-4000-8000-000000000001";
const hlc = (ms: number, counter = 0) => encodeHlc(ms, counter, DEVICE);

const task = (index: number, overrides: Record<string, unknown> = {}) => ({
  table: "gtd_contexts",
  entityId: `context:${index}`,
  row: {
    id: `context:${index}`,
    name: `Contexte ${index}`,
    created_at: "2026-10-01",
    updated_at: "2026-10-01",
    ...overrides,
  },
  fieldClocks: { name: hlc(1000 + index), updated_at: hlc(1000 + index) },
  rowHlc: hlc(1000 + index),
  deletedAt: null as string | null,
});

const base = (overrides: Partial<SyncChangeSet> = {}): SyncChangeSet => ({
  formatVersion: SYNC_FORMAT_VERSION,
  deviceId: DEVICE,
  domain: "gtd",
  schemaVersion: 43,
  hlcHigh: hlc(9000),
  entities: [task(1)],
  unionRows: {},
  settings: [],
  recurrence: { occurrences: [], clears: [] },
  aliases: [],
  ...overrides,
});

const rich = (): SyncChangeSet =>
  base({
    entities: [
      task(1, { name: "Été à Zürich — 日本語 — 🚀   \u0000 \\ \" ' \n tab\t" }),
      { ...task(2), row: null, deletedAt: hlc(5000), fieldClocks: {} },
      task(3, { name: null, position: 3.5 }),
    ],
    unionRows: {
      gtd_task_events: [
        { id: "e1", task_id: "context:1", event_type: "created", occurred_at: "2026-10-01" },
      ],
    },
    settings: [{ key: "language", value: "fr", rowHlc: hlc(3000) }],
    recurrence: {
      occurrences: [
        {
          template_id: "tpl-1",
          due_date: "2026-10-02",
          outcome: "completed",
          outcome_hlc: hlc(4000),
          device_id: DEVICE,
        },
      ],
      clears: [{ template_id: "tpl-1", cleared_through_date: "2026-09-30" }],
    },
    aliases: [
      {
        entity_type: "gtd_tasks",
        alias_id: "task-b",
        canonical_id: "task-a",
        recorded_hlc: hlc(4500),
      },
    ],
  });

const roundTrip = async (changeSet: SyncChangeSet, compression?: "gzip" | "none") => {
  const encoded = await encodeBundle(changeSet, { compression });
  return { encoded, decoded: await decodeBundle(encoded.bytes) };
};

const codeOf = async (promise: Promise<unknown>): Promise<SyncBundleErrorCode | "no error"> => {
  try {
    await promise;
    return "no error";
  } catch (error) {
    expect(error).toBeInstanceOf(SyncBundleError);
    return (error as SyncBundleError).code;
  }
};

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytesOf = (text: string) => new TextEncoder().encode(text);
const preamble = (compression: "gzip" | "none" = "none", version = 1) =>
  `${BUNDLE_MAGIC} ${version} ${compression}\n`;
const header = (counts: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "header",
    formatVersion: 1,
    domain: "gtd",
    deviceId: DEVICE,
    schemaVersion: 43,
    hlcHigh: hlc(1),
    counts: {
      entities: 0,
      settings: 0,
      occurrences: 0,
      clears: 0,
      aliases: 0,
      unionTables: {},
      ...counts,
    },
    ...overrides,
  });
const plain = (...lines: string[]) => bytesOf(`${preamble()}${lines.join("\n")}\n`);

describe("bundle round trip", () => {
  for (const compression of ["gzip", "none"] as const) {
    it(`restores every part of a change set exactly (${compression})`, async () => {
      const original = rich();
      const { encoded, decoded } = await roundTrip(original, compression);
      expect(encoded.compression).toBe(compression);
      // The decoded value passes the same gate a received bundle passes, and equals the input.
      expect(validateChangeSet(decoded)).toStrictEqual(validateChangeSet(original));
      expect(validateChangeSet(decoded)).toStrictEqual(original);
    });
  }

  it("round-trips an empty change set and an empty union table", async () => {
    const empty = base({ entities: [] });
    expect(validateChangeSet((await roundTrip(empty)).decoded)).toStrictEqual(empty);
    const withEmptyTable = base({ entities: [], unionRows: { gtd_task_events: [] } });
    const decoded = validateChangeSet((await roundTrip(withEmptyTable)).decoded);
    expect(decoded).toStrictEqual(withEmptyTable);
    expect(Object.keys(decoded.unionRows)).toEqual(["gtd_task_events"]);
  });

  it("keeps an own __proto__ key as data and pollutes nothing", async () => {
    const text = JSON.stringify(base({ entities: [] })).replace(
      '"entities":[]',
      `"entities":[{"table":"gtd_contexts","entityId":"c","row":{"id":"c","__proto__":"x"},"fieldClocks":{"__proto__":"${hlc(1000)}"},"rowHlc":"${hlc(1000)}","deletedAt":null}]`,
    );
    const original = validateChangeSet(JSON.parse(text));
    const { decoded } = await roundTrip(original);
    const restored = validateChangeSet(decoded);
    expect(restored).toStrictEqual(original);
    expect(Object.hasOwn(restored.entities[0]?.row ?? {}, "__proto__")).toBe(true);
    expect(Object.hasOwn(restored.entities[0]?.fieldClocks ?? {}, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.getPrototypeOf(restored.entities[0]?.row)).toBe(Object.prototype);
  });

  it("round-trips lone surrogates and very large strings", async () => {
    const huge = `${"é".repeat(2_000_000)}\ud800 end`;
    const original = base({ entities: [task(1, { name: huge }), task(2, { name: "\udfff" })] });
    const { decoded } = await roundTrip(original);
    expect(validateChangeSet(decoded)).toStrictEqual(original);
  });

  it("round-trips more records than fit one compressor batch, in order", async () => {
    const entities = Array.from({ length: 30_000 }, (_, index) =>
      task(index, { name: `Contexte ${index} ${"x".repeat(60)}` }),
    );
    const original = base({ entities, hlcHigh: hlc(100_000) });
    const { encoded, decoded } = await roundTrip(original);
    expect(encoded.uncompressedBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(encoded.records).toBe(30_000);
    expect(validateChangeSet(decoded)).toStrictEqual(original);
    expect(encoded.bytes.length).toBeLessThan(encoded.uncompressedBytes / 4);
  });

  it("is plain text after one preamble line when uncompressed, and deterministic", async () => {
    const first = await encodeBundle(rich(), { compression: "none" });
    const second = await encodeBundle(rich(), { compression: "none" });
    expect(textOf(first.bytes)).toBe(textOf(second.bytes));
    const lines = textOf(first.bytes).split("\n");
    expect(lines[0]).toBe(`${BUNDLE_MAGIC} 1 none`);
    expect(JSON.parse(lines[1] as string)).toMatchObject({
      kind: "header",
      domain: "gtd",
      counts: { entities: 3, settings: 1, occurrences: 1, clears: 1, aliases: 1 },
    });
    expect(lines.at(-1)).toBe("");
    const gzip = await encodeBundle(rich());
    expect(textOf(gzip.bytes.subarray(0, 40))).toContain(`${BUNDLE_MAGIC} 1 gzip\n`);
  });

  it("writes uncompressed when the runtime has no CompressionStream, and refuses gzip it cannot read", async () => {
    const compressed = (await encodeBundle(rich())).bytes;
    vi.stubGlobal("CompressionStream", undefined);
    vi.stubGlobal("DecompressionStream", undefined);
    try {
      const fallback = await encodeBundle(rich());
      expect(fallback.compression).toBe("none");
      expect(validateChangeSet(await decodeBundle(fallback.bytes))).toStrictEqual(rich());
      expect(await codeOf(decodeBundle(compressed))).toBe("compression_unavailable");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the encoder enforces the line cap every reader enforces", () => {
  it("refuses one record over the cap at encode time, and accepts one just under it", async () => {
    const huge = base({ entities: [task(1, { name: "x".repeat(MAX_BUNDLE_LINE_CHARS) })] });
    expect(await codeOf(encodeBundle(huge))).toBe("line_too_long");
    expect(await codeOf(encodeBundle(huge, { compression: "none" }))).toBe("line_too_long");

    // A record that fits (its line is under the cap) is written and read back.
    const fits = base({
      entities: [task(1, { name: "x".repeat(MAX_BUNDLE_LINE_CHARS - 2000) })],
    });
    const { decoded } = await roundTrip(fits, "none");
    expect(validateChangeSet(decoded)).toStrictEqual(fits);
  });
});

describe("everything the encoder accepts is readable under the decoder's limits", () => {
  /** A highly compressible set whose body is about `megabytes` MiB over several 1 MiB records. */
  const compressible = (records: number, size: number) =>
    base({
      entities: Array.from({ length: records }, (_, index) =>
        task(index, { name: "a".repeat(size) }),
      ),
      hlcHigh: hlc(100_000),
    });

  it("refuses a body over the total cap while encoding, naming the persistent cause", async () => {
    const set = compressible(40, 100_000);
    const probe = await encodeBundle(set, {
      compression: "none",
      maxBodyBytes: Number.MAX_SAFE_INTEGER,
    });
    const exact = probe.uncompressedBytes;
    expect(exact).toBeGreaterThan(4_000_000);
    expect(await codeOf(encodeBundle(set, { maxBodyBytes: exact - 1 }))).toBe("body_too_large");
    expect(await codeOf(encodeBundle(set, { compression: "none", maxBodyBytes: exact - 1 }))).toBe(
      "body_too_large",
    );
    expect(await codeOf(encodeBundle(set, { maxBodyBytes: exact }))).toBe("no error");
  });

  it("boundary sweep: just under and just over the total cap, accepted exactly when readable", async () => {
    for (const [records, size] of [
      [1, 10],
      [3, 700_000],
      [12, 400_000],
      [40, 100_000],
    ] as const) {
      const set = compressible(records, size);
      const exact = (
        await encodeBundle(set, { compression: "none", maxBodyBytes: Number.MAX_SAFE_INTEGER })
      ).uncompressedBytes;
      for (const cap of [exact - 1, exact, exact + 1]) {
        let encoded: Awaited<ReturnType<typeof encodeBundle>> | null = null;
        try {
          encoded = await encodeBundle(set, { maxBodyBytes: cap });
        } catch (error) {
          expect((error as SyncBundleError).code).toBe("body_too_large");
        }
        // Accepted <=> the body fits; and an accepted bundle always decodes under the same cap.
        expect(encoded !== null).toBe(exact <= cap);
        if (encoded !== null) {
          const decoded = await decodeBundle(encoded.bytes, { maxDecodedBytes: cap });
          expect(validateChangeSet(decoded)).toStrictEqual(set);
        } else if (exact > cap) {
          // And the same bytes, written without the guard, are refused by the reader.
          const unguarded = await encodeBundle(set, { maxBodyBytes: Number.MAX_SAFE_INTEGER });
          expect(await codeOf(decodeBundle(unguarded.bytes, { maxDecodedBytes: cap }))).toBe(
            "decoded_too_large",
          );
        }
      }
    }
  });

  it("stops streaming at the cap instead of producing the whole body", async () => {
    // 300 records of 1 MiB: the encoder gives up after a handful of batches.
    const set = compressible(300, 1024 * 1024);
    const started = Date.now();
    expect(await codeOf(encodeBundle(set, { maxBodyBytes: 3 * 1024 * 1024 }))).toBe(
      "body_too_large",
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("uses the decoder's own default total cap", async () => {
    // 513 records of about 1 MiB compress to well under a megabyte but inflate past 512 MiB.
    const shared = "x".repeat(1024 * 1024);
    const set = base({
      entities: Array.from({ length: 513 }, (_, index) => task(index, { name: shared })),
      hlcHigh: hlc(100_000),
    });
    expect(await codeOf(encodeBundle(set))).toBe("body_too_large");
  }, 60_000);
});

describe("bundle limits", () => {
  it("states the caps relative to the folder transport's 64 MiB", () => {
    expect(MAX_ENCODED_BUNDLE_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_DECODED_BUNDLE_BYTES).toBe(8 * MAX_ENCODED_BUNDLE_BYTES);
  });
});

describe("decodeBundle rejects hostile input", () => {
  it("a missing or foreign preamble", async () => {
    expect(await codeOf(decodeBundle(new Uint8Array()))).toBe("bad_preamble");
    expect(await codeOf(decodeBundle(bytesOf("{}\n")))).toBe("bad_preamble");
    expect(await codeOf(decodeBundle(bytesOf(`${BUNDLE_MAGIC} 1 none`)))).toBe("bad_preamble");
    expect(await codeOf(decodeBundle(bytesOf(`other 1 none\n${header()}\n`)))).toBe("bad_preamble");
    expect(await codeOf(decodeBundle(bytesOf(`${BUNDLE_MAGIC} 1\n${header()}\n`)))).toBe(
      "bad_preamble",
    );
    expect(await codeOf(decodeBundle(bytesOf(`${"x".repeat(200)}\n`)))).toBe("bad_preamble");
  });

  it("an unknown format version, in the preamble or the header", async () => {
    expect(await codeOf(decodeBundle(bytesOf(`${preamble("none", 2)}${header()}\n`)))).toBe(
      "unknown_version",
    );
    expect(
      await codeOf(decodeBundle(bytesOf(`${preamble()}${header({}, { formatVersion: 2 })}\n`))),
    ).toBe("unknown_version");
  });

  it("an unknown compression", async () => {
    expect(await codeOf(decodeBundle(bytesOf(`${BUNDLE_MAGIC} 1 brotli\n${header()}\n`)))).toBe(
      "unknown_compression",
    );
  });

  it("bytes that are not gzip, and a gzip stream cut short", async () => {
    const notGzip = bytesOf(`${preamble("gzip")}this is not a gzip stream at all`);
    expect(await codeOf(decodeBundle(notGzip))).toBe("bad_gzip");

    const { bytes } = await encodeBundle(rich());
    const cut = bytes.subarray(0, bytes.length - 12);
    expect(await codeOf(decodeBundle(cut))).toBe("bad_gzip");
    const flipped = Uint8Array.from(bytes);
    flipped[flipped.length - 9] = (flipped[flipped.length - 9] as number) ^ 0xff;
    expect(await codeOf(decodeBundle(flipped))).toBe("bad_gzip");
  });

  it("a decompression bomb, by a lowered cap and by the real one", async () => {
    // Valid records, so only the size can stop it: `megabytes` entities of about 1 MiB each, as
    // concatenated gzip members (a stream may be made of several) so no big string is ever built.
    const bomb = (megabytes: number) => {
      const member = (text: string) => gzipSync(Buffer.from(text), { level: 9 });
      const filler = member(`${JSON.stringify(["e", { pad: "0".repeat(1024 * 1024 - 20) }])}\n`);
      return Uint8Array.from([
        ...bytesOf(preamble("gzip")),
        ...member(`${header({ entities: megabytes })}\n`),
        ...Array.from({ length: megabytes }, () => [...filler]).flat(),
      ]);
    };
    const small = bomb(8);
    expect(small.length).toBeLessThan(200_000);
    expect(await codeOf(decodeBundle(small, { maxDecodedBytes: 4 * 1024 * 1024 }))).toBe(
      "decoded_too_large",
    );
    // Within the cap the same bytes are an ordinary (if odd) bundle.
    expect(await codeOf(decodeBundle(small, { maxDecodedBytes: 64 * 1024 * 1024 }))).toBe(
      "no error",
    );
    const stored = bytesOf(`${preamble()}${"x".repeat(2000)}`);
    expect(await codeOf(decodeBundle(stored, { maxDecodedBytes: 1000 }))).toBe("decoded_too_large");

    // The real cap: 8 x 64 MiB. 520 MiB of text compresses to about half a megabyte.
    const huge = bomb(520);
    expect(huge.length).toBeLessThan(4 * 1024 * 1024);
    expect(await codeOf(decodeBundle(huge))).toBe("decoded_too_large");
  }, 60_000);

  it("a body whose records do not match the header counts", async () => {
    const entity = JSON.stringify(["e", task(1)]);
    // Truncated at a line boundary: fewer records than declared.
    expect(await codeOf(decodeBundle(plain(header({ entities: 2 }), entity)))).toBe(
      "count_mismatch",
    );
    // Padded: more than declared.
    expect(await codeOf(decodeBundle(plain(header({ entities: 1 }), entity, entity)))).toBe(
      "count_mismatch",
    );
    // A union table the header does not list.
    expect(
      await codeOf(decodeBundle(plain(header(), JSON.stringify(["u", "gtd_task_events", {}])))),
    ).toBe("count_mismatch");
    // A union table short of its declared rows.
    expect(await codeOf(decodeBundle(plain(header({ unionTables: { gtd_task_events: 1 } }))))).toBe(
      "count_mismatch",
    );
    for (const [key, tag, payload] of [
      ["settings", "s", {}],
      ["occurrences", "o", {}],
      ["clears", "c", {}],
      ["aliases", "a", {}],
    ] as const) {
      expect(await codeOf(decodeBundle(plain(header({ [key]: 1 }))))).toBe("count_mismatch");
      expect(await codeOf(decodeBundle(plain(header(), JSON.stringify([tag, payload]))))).toBe(
        "count_mismatch",
      );
    }
  });

  it("a cut in the middle of a line, and a stream that does not end in a newline", async () => {
    const whole = await encodeBundle(rich(), { compression: "none" });
    const text = textOf(whole.bytes);
    const middle = text.indexOf('"entityId"');
    expect(await codeOf(decodeBundle(bytesOf(text.slice(0, middle))))).toBe("bad_line");
    expect(await codeOf(decodeBundle(bytesOf(text.slice(0, -1))))).toBe("bad_line");
  });

  it("a bundle of another domain, before any record is read", async () => {
    const personal = await encodeBundle(base({ domain: "personal", entities: [] }));
    expect(await codeOf(decodeBundle(personal.bytes, { expectedDomain: "gtd" }))).toBe(
      "wrong_domain",
    );
    expect(await codeOf(decodeBundle(personal.bytes, { expectedDomain: "personal" }))).toBe(
      "no error",
    );
    // Without an expectation the domain is the caller's (the engine's) to check.
    expect((await decodeBundle(personal.bytes)).domain).toBe("personal");
    const first = plain(header({}, { domain: "finance" }), "not even json");
    expect(await codeOf(decodeBundle(first, { expectedDomain: "gtd" }))).toBe("wrong_domain");
  });

  it("malformed headers and records", async () => {
    const cases: [string, Uint8Array, SyncBundleErrorCode][] = [
      ["only a preamble", bytesOf(preamble()), "bad_header"],
      ["a record first", plain(JSON.stringify(["e", task(1)])), "bad_header"],
      ["header with no domain", plain(header({}, { domain: 7 })), "bad_header"],
      ["header with no counts", plain(header({}, { counts: null })), "bad_header"],
      ["header with bad counts", plain(header({ entities: -1 })), "bad_header"],
      ["header with fractional counts", plain(header({ settings: 1.5 })), "bad_header"],
      ["header with bad union count", plain(header({ unionTables: { t: "x" } })), "bad_header"],
      ["header that is not JSON", plain("{nope"), "bad_line"],
      ["an empty line", plain(header(), ""), "bad_line"],
      ["an untagged record", plain(header(), "{}"), "bad_line"],
      ["an unknown tag", plain(header(), JSON.stringify(["z", {}])), "bad_line"],
      ["an entity record of the wrong length", plain(header({ entities: 1 }), '["e"]'), "bad_line"],
      [
        "a union record without a table",
        plain(header({ unionTables: { t: 1 } }), '["u", 5, {}]'),
        "bad_line",
      ],
      ["invalid UTF-8", Uint8Array.from([...bytesOf(preamble()), 0xff, 0xfe, 0x0a]), "bad_line"],
    ];
    for (const [label, input, expected] of cases) {
      expect(await codeOf(decodeBundle(input)), label).toBe(expected);
    }
  });

  it("a single line over the cap, before it is joined", async () => {
    const giant = `${"a".repeat(MAX_BUNDLE_LINE_CHARS + 1)}\n`;
    expect(await codeOf(decodeBundle(bytesOf(`${preamble()}${header()}\n${giant}`)))).toBe(
      "line_too_long",
    );
    // Without any newline at all the tail is still bounded.
    expect(
      await codeOf(decodeBundle(bytesOf(`${preamble()}${"a".repeat(MAX_BUNDLE_LINE_CHARS + 1)}`))),
    ).toBe("line_too_long");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
