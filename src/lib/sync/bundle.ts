import { SYNC_FORMAT_VERSION, type SyncChangeSet } from "./change-set";
import type { SyncDomain } from "./registry";

/**
 * The file format of one published bundle: a `SyncChangeSet` as gzip-compressed JSON lines.
 *
 * ```text
 * trackdidia-sync-bundle 1 gzip\n       <- preamble, plain ASCII: magic, format version, compression
 * <body>                                <- gzip stream (or, with `none`, the raw text) of JSON lines:
 *   {"kind":"header", formatVersion, domain, deviceId, schemaVersion, hlcHigh, counts}
 *   ["e", <entity>] ...                 entities, in change-set order
 *   ["u", "<table>", <row>] ...         grow-only-union rows
 *   ["s", <setting>] ...                synced settings
 *   ["o", <occurrence>] ["c", <clear>]  recurrence sidecars
 *   ["a", <alias>] ...                  id aliases
 * ```
 *
 * The preamble is outside the compressed part so a reader knows how to read the rest (and whether
 * it can) before touching it. `counts` in the header lets a reader prove it received everything: a
 * truncated or tampered body is a `count_mismatch`, not a smaller change set. Records are
 * one-per-line so neither side ever builds the whole change set as one string: encoding feeds the
 * compressor line batches, decoding parses line by line as the decompressor produces them.
 *
 * Trust. A bundle comes from another machine through a shared folder. `decodeBundle` never trusts
 * its size (the decompressed output is capped, see {@link MAX_DECODED_BUNDLE_BYTES}), never
 * evaluates anything, and rejects with a typed {@link SyncBundleError}. What it returns has the
 * SHAPE of a change set but is not validated: `validateChangeSet` is the gate that decides whether
 * its content may reach a database, and it runs on this output unchanged (an encode/decode round
 * trip of a validated change set validates to a deep-equal value).
 *
 * Compression is the platform's `CompressionStream`/`DecompressionStream` (Safari 16.4+, Chromium,
 * Node 18+). Where it is missing a bundle is written uncompressed (`none`), and a compressed bundle
 * cannot be read ({@link SyncBundleErrorCode} `compression_unavailable`). No dependency is added.
 */

export const BUNDLE_MAGIC = "trackdidia-sync-bundle";

/** The Rust IPC cap on one stored bundle (`MAX_BUNDLE_BYTES` in `sync_folder.rs`). */
export const MAX_ENCODED_BUNDLE_BYTES = 64 * 1024 * 1024;

/** A compressed bundle may not inflate to more than eight times the cap on what is stored. */
export const MAX_DECODED_BUNDLE_BYTES = 8 * MAX_ENCODED_BUNDLE_BYTES;

/** No record of a real change set comes near this; longer is not a bundle. */
export const MAX_BUNDLE_LINE_CHARS = 16 * 1024 * 1024;

const MAX_PREAMBLE_BYTES = 64;
/** Lines are batched this large before they are handed to the compressor. */
const ENCODE_BATCH_CHARS = 1024 * 1024;

export type BundleCompression = "gzip" | "none";

export type SyncBundleErrorCode =
  /** The first line is not `trackdidia-sync-bundle <version> <compression>`. */
  | "bad_preamble"
  /** Written by a build with another format version. */
  | "unknown_version"
  | "unknown_compression"
  /** The bundle is gzip and this runtime has no `DecompressionStream`. */
  | "compression_unavailable"
  /** Not a gzip stream, or damaged / cut short. */
  | "bad_gzip"
  /** Inflated beyond the cap (a decompression bomb) or an uncompressed body over the cap. */
  | "decoded_too_large"
  /**
   * Raised by the ENCODER: the uncompressed body exceeds {@link MAX_DECODED_BUNDLE_BYTES}, the limit
   * every reader enforces while inflating. Writing it would publish a bundle nobody can read.
   */
  | "body_too_large"
  | "line_too_long"
  /** The text is not UTF-8 or a line is not JSON of the expected shape. */
  | "bad_line"
  | "bad_header"
  | "wrong_domain"
  /** The records do not match the header's counts: truncated, padded or tampered. */
  | "count_mismatch";

export class SyncBundleError extends Error {
  readonly code: SyncBundleErrorCode;

  constructor(code: SyncBundleErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SyncBundleError";
    this.code = code;
  }
}

function fail(code: SyncBundleErrorCode, message: string, cause?: unknown): never {
  throw new SyncBundleError(code, message, cause === undefined ? undefined : { cause });
}

export interface EncodeBundleOptions {
  /**
   * `gzip` (default): compress, and throw nothing if the runtime cannot: fall back to `none`.
   * `none`: write the text as it is. Tests and runtimes without `CompressionStream`.
   */
  compression?: BundleCompression;
  /**
   * Largest uncompressed body the encoder will produce; default {@link MAX_DECODED_BUNDLE_BYTES},
   * the decoder's own default limit, so everything the encoder accepts is readable. Tests lower it
   * (together with the decoder's `maxDecodedBytes`) to exercise the boundary cheaply.
   */
  maxBodyBytes?: number;
}

export interface EncodedBundle {
  bytes: Uint8Array;
  compression: BundleCompression;
  /** Records in the body: what the manifest calls `rows` plus recurrence and alias records. */
  records: number;
  /** Size of the body before compression, preamble excluded. */
  uncompressedBytes: number;
}

const hasCompression = (): boolean =>
  typeof CompressionStream === "function" && typeof DecompressionStream === "function";

const preambleOf = (compression: BundleCompression): string =>
  `${BUNDLE_MAGIC} ${SYNC_FORMAT_VERSION} ${compression}\n`;

/** The counts the header promises. `unionTables` (in the file only) lists every table, empty or not. */
interface BundleCounts {
  entities: number;
  settings: number;
  occurrences: number;
  clears: number;
  aliases: number;
}

/** The rows of one union table; a descriptor read, so a table named `__proto__` is just data. */
const unionRowsOf = (changeSet: SyncChangeSet, table: string): unknown[] => {
  const descriptor = Object.getOwnPropertyDescriptor(changeSet.unionRows, table);
  return (descriptor ? descriptor.value : []) as unknown[];
};

const headerCounts = (changeSet: SyncChangeSet): BundleCounts & { unionTables: object } => {
  const unionTables: Record<string, number> = {};
  for (const table of Object.keys(changeSet.unionRows)) {
    Object.defineProperty(unionTables, table, {
      value: unionRowsOf(changeSet, table).length,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return {
    entities: changeSet.entities.length,
    settings: changeSet.settings.length,
    occurrences: changeSet.recurrence.occurrences.length,
    clears: changeSet.recurrence.clears.length,
    aliases: changeSet.aliases.length,
    unionTables,
  };
};

/**
 * Every record of the body as one JSON line (no trailing newline), in a fixed order. A line over
 * {@link MAX_BUNDLE_LINE_CHARS} is refused HERE: every reader enforces the same cap, so writing it
 * would make the bundle unreadable for all of them. It fails at publish with `line_too_long`.
 */
function* bodyLines(changeSet: SyncChangeSet): Generator<string> {
  for (const line of rawBodyLines(changeSet)) {
    if (line.length > MAX_BUNDLE_LINE_CHARS) {
      fail(
        "line_too_long",
        `A single record is ${line.length} characters, over the ${MAX_BUNDLE_LINE_CHARS} a bundle line may hold`,
      );
    }
    yield line;
  }
}

function* rawBodyLines(changeSet: SyncChangeSet): Generator<string> {
  yield JSON.stringify({
    kind: "header",
    formatVersion: changeSet.formatVersion,
    domain: changeSet.domain,
    deviceId: changeSet.deviceId,
    schemaVersion: changeSet.schemaVersion,
    hlcHigh: changeSet.hlcHigh,
    counts: headerCounts(changeSet),
  });
  for (const entity of changeSet.entities) yield JSON.stringify(["e", entity]);
  for (const table of Object.keys(changeSet.unionRows)) {
    const rows = unionRowsOf(changeSet, table);
    for (const row of rows) yield JSON.stringify(["u", table, row]);
  }
  for (const setting of changeSet.settings) yield JSON.stringify(["s", setting]);
  for (const occurrence of changeSet.recurrence.occurrences) {
    yield JSON.stringify(["o", occurrence]);
  }
  for (const clear of changeSet.recurrence.clears) yield JSON.stringify(["c", clear]);
  for (const alias of changeSet.aliases) yield JSON.stringify(["a", alias]);
}

/** The body as byte batches of about {@link ENCODE_BATCH_CHARS}: never one string for all of it. */
function* bodyBatches(changeSet: SyncChangeSet): Generator<Uint8Array> {
  const encoder = new TextEncoder();
  let pending: string[] = [];
  let size = 0;
  for (const line of bodyLines(changeSet)) {
    pending.push(line);
    size += line.length + 1;
    if (size >= ENCODE_BATCH_CHARS) {
      yield encoder.encode(`${pending.join("\n")}\n`);
      pending = [];
      size = 0;
    }
  }
  if (pending.length > 0) yield encoder.encode(`${pending.join("\n")}\n`);
}

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

const gzipBatches = async (batches: Iterable<Uint8Array>): Promise<Uint8Array[]> => {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const output: Uint8Array[] = [];
  // Reading must run alongside writing: a full output queue would otherwise stall the writer.
  const collected = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      output.push(value as Uint8Array);
    }
  })();
  try {
    for (const batch of batches) await writer.write(batch as Uint8Array<ArrayBuffer>);
    await writer.close();
    await collected;
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    await collected.catch(() => undefined);
    throw error;
  }
  return output;
};

/** Encodes a change set to the bytes stored in the folder. Pure apart from the compressor. */
export const encodeBundle = async (
  changeSet: SyncChangeSet,
  options: EncodeBundleOptions = {},
): Promise<EncodedBundle> => {
  const requested = options.compression ?? "gzip";
  const compression: BundleCompression = requested === "gzip" && hasCompression() ? "gzip" : "none";
  const limit = options.maxBodyBytes ?? MAX_DECODED_BUNDLE_BYTES;
  let uncompressedBytes = 0;
  // Counted while the batches stream by: with gzip nothing but the compressed output is kept. The
  // moment the running total passes the limit the stream stops (the throw aborts the compressor), so
  // a huge compressible change set is never fully produced, and never reaches the folder.
  const batches = (function* () {
    for (const batch of bodyBatches(changeSet)) {
      uncompressedBytes += batch.length;
      if (uncompressedBytes > limit) {
        fail(
          "body_too_large",
          `The bundle body passes ${limit} bytes uncompressed, the most a reader inflates; not written`,
        );
      }
      yield batch;
    }
  })();
  const records =
    changeSet.entities.length +
    Object.keys(changeSet.unionRows).reduce(
      (total, table) => total + unionRowsOf(changeSet, table).length,
      0,
    ) +
    changeSet.settings.length +
    changeSet.recurrence.occurrences.length +
    changeSet.recurrence.clears.length +
    changeSet.aliases.length;
  const preamble = new TextEncoder().encode(preambleOf(compression));
  const body = compression === "gzip" ? await gzipBatches(batches) : [...batches];
  return { bytes: concat([preamble, ...body]), compression, records, uncompressedBytes };
};

// ---------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------

export interface DecodeBundleOptions {
  /** Refuse a bundle of another domain as soon as its header is read, before any record. */
  expectedDomain?: SyncDomain;
  /** Decompressed size limit; default {@link MAX_DECODED_BUNDLE_BYTES}. Tests lower it. */
  maxDecodedBytes?: number;
}

/** The shape `validateChangeSet` takes. Nothing here has been validated. */
export interface DecodedBundle {
  formatVersion: unknown;
  deviceId: unknown;
  domain: unknown;
  schemaVersion: unknown;
  hlcHigh: unknown;
  entities: unknown[];
  unionRows: Record<string, unknown[]>;
  settings: unknown[];
  recurrence: { occurrences: unknown[]; clears: unknown[] };
  aliases: unknown[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const readPreamble = (bytes: Uint8Array): { compression: BundleCompression; bodyStart: number } => {
  const limit = Math.min(bytes.length, MAX_PREAMBLE_BYTES);
  let end = -1;
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0x0a) {
      end = index;
      break;
    }
  }
  if (end < 0) return fail("bad_preamble", "Not a TrackDidia sync bundle (no preamble line)");
  const line = new TextDecoder("latin1").decode(bytes.subarray(0, end));
  const parts = line.split(" ");
  if (parts.length !== 3 || parts[0] !== BUNDLE_MAGIC) {
    return fail("bad_preamble", "Not a TrackDidia sync bundle (unknown preamble)");
  }
  if (parts[1] !== String(SYNC_FORMAT_VERSION)) {
    return fail(
      "unknown_version",
      `Bundle format ${String(parts[1]).slice(0, 12)} is not understood by this version (it reads ${SYNC_FORMAT_VERSION})`,
    );
  }
  if (parts[2] !== "gzip" && parts[2] !== "none") {
    return fail("unknown_compression", "Bundle compression is not gzip or none");
  }
  return { compression: parts[2], bodyStart: end + 1 };
};

/** Receives the decoded text in order, line by line, and enforces the structure. */
class BundleAssembler {
  private header: Record<string, unknown> | null = null;
  private declared: BundleCounts | null = null;
  private readonly seen = {
    entities: 0,
    settings: 0,
    occurrences: 0,
    clears: 0,
    aliases: 0,
  };
  private readonly unionDeclared = new Map<string, number>();
  private readonly unionRows = new Map<string, unknown[]>();
  readonly decoded: DecodedBundle = {
    formatVersion: undefined,
    deviceId: undefined,
    domain: undefined,
    schemaVersion: undefined,
    hlcHigh: undefined,
    entities: [],
    unionRows: {},
    settings: [],
    recurrence: { occurrences: [], clears: [] },
    aliases: [],
  };

  constructor(private readonly expectedDomain: SyncDomain | undefined) {}

  line(text: string): void {
    if (text.length === 0) {
      fail("bad_line", "Empty line in a bundle");
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      fail("bad_line", "A bundle line is not JSON", error);
    }
    if (this.header === null) {
      this.acceptHeader(value);
      return;
    }
    this.acceptRecord(value);
  }

  private acceptHeader(value: unknown): void {
    if (!isRecord(value) || value.kind !== "header") {
      fail("bad_header", "The first line of a bundle is not its header");
    }
    const header = value as Record<string, unknown>;
    if (header.formatVersion !== SYNC_FORMAT_VERSION) {
      fail(
        "unknown_version",
        `Bundle header declares format ${String(header.formatVersion)}, this version reads ${SYNC_FORMAT_VERSION}`,
      );
    }
    if (typeof header.domain !== "string") {
      fail("bad_header", "The bundle header has no domain");
    }
    if (this.expectedDomain !== undefined && header.domain !== this.expectedDomain) {
      fail(
        "wrong_domain",
        `Expected a "${this.expectedDomain}" bundle, found "${String(header.domain).slice(0, 32)}"`,
      );
    }
    const counts = header.counts;
    if (!isRecord(counts)) fail("bad_header", "The bundle header has no counts");
    const record = counts as Record<string, unknown>;
    const unionTables = record.unionTables;
    if (
      !isCount(record.entities) ||
      !isCount(record.settings) ||
      !isCount(record.occurrences) ||
      !isCount(record.clears) ||
      !isCount(record.aliases) ||
      !isRecord(unionTables)
    ) {
      fail("bad_header", "The bundle header counts are malformed");
    }
    for (const name of Object.keys(unionTables as Record<string, unknown>)) {
      // A descriptor read: a table named `__proto__` is data here, never a prototype.
      const count = Object.getOwnPropertyDescriptor(unionTables, name)?.value;
      if (!isCount(count)) fail("bad_header", "The bundle header counts are malformed");
      this.unionDeclared.set(name, count as number);
      // An empty list must survive the round trip: the key is part of the change set.
      this.unionRows.set(name, []);
    }
    this.header = header;
    this.declared = {
      entities: record.entities as number,
      settings: record.settings as number,
      occurrences: record.occurrences as number,
      clears: record.clears as number,
      aliases: record.aliases as number,
    };
    this.decoded.formatVersion = header.formatVersion;
    this.decoded.deviceId = header.deviceId;
    this.decoded.domain = header.domain;
    this.decoded.schemaVersion = header.schemaVersion;
    this.decoded.hlcHigh = header.hlcHigh;
  }

  private acceptRecord(value: unknown): void {
    if (!Array.isArray(value) || typeof value[0] !== "string") {
      fail("bad_line", "A bundle record is not a tagged array");
    }
    const record = value as unknown[];
    const declared = this.declared as BundleCounts;
    const tooMany = (what: string): never =>
      fail("count_mismatch", `The bundle holds more ${what} than its header declares`);
    switch (record[0]) {
      case "e":
        if (record.length !== 2) fail("bad_line", "Malformed entity record");
        if (++this.seen.entities > declared.entities) tooMany("entities");
        this.decoded.entities.push(record[1]);
        return;
      case "u": {
        if (record.length !== 3 || typeof record[1] !== "string") {
          fail("bad_line", "Malformed union row record");
        }
        const table = record[1] as string;
        const rows = this.unionRows.get(table);
        if (rows === undefined) {
          fail("count_mismatch", "The bundle holds rows of a table its header does not list");
        }
        if ((rows as unknown[]).length + 1 > (this.unionDeclared.get(table) as number)) {
          tooMany("union rows");
        }
        (rows as unknown[]).push(record[2]);
        return;
      }
      case "s":
        if (record.length !== 2) fail("bad_line", "Malformed setting record");
        if (++this.seen.settings > declared.settings) tooMany("settings");
        this.decoded.settings.push(record[1]);
        return;
      case "o":
        if (record.length !== 2) fail("bad_line", "Malformed occurrence record");
        if (++this.seen.occurrences > declared.occurrences) tooMany("occurrences");
        this.decoded.recurrence.occurrences.push(record[1]);
        return;
      case "c":
        if (record.length !== 2) fail("bad_line", "Malformed clear record");
        if (++this.seen.clears > declared.clears) tooMany("clears");
        this.decoded.recurrence.clears.push(record[1]);
        return;
      case "a":
        if (record.length !== 2) fail("bad_line", "Malformed alias record");
        if (++this.seen.aliases > declared.aliases) tooMany("aliases");
        this.decoded.aliases.push(record[1]);
        return;
      default:
        fail("bad_line", "A bundle record has an unknown tag");
    }
  }

  finish(): DecodedBundle {
    if (this.header === null || this.declared === null) {
      return fail("bad_header", "The bundle is empty (no header)");
    }
    const declared = this.declared;
    const complete =
      this.seen.entities === declared.entities &&
      this.seen.settings === declared.settings &&
      this.seen.occurrences === declared.occurrences &&
      this.seen.clears === declared.clears &&
      this.seen.aliases === declared.aliases &&
      [...this.unionDeclared].every(
        ([table, count]) => this.unionRows.get(table)?.length === count,
      );
    if (!complete) {
      fail(
        "count_mismatch",
        "The bundle holds fewer records than its header declares (truncated?)",
      );
    }
    for (const [table, rows] of this.unionRows) {
      Object.defineProperty(this.decoded.unionRows, table, {
        value: rows,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return this.decoded;
  }
}

/** Splits decoded text into lines, enforcing the line cap before a giant line is ever joined. */
class LineReader {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private tail = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Uint8Array): void {
    let text: string;
    try {
      text = this.decoder.decode(chunk, { stream: true });
    } catch (error) {
      fail("bad_line", "The bundle text is not valid UTF-8", error);
    }
    this.consume(text);
  }

  end(): void {
    let rest = "";
    try {
      rest = this.decoder.decode();
    } catch (error) {
      fail("bad_line", "The bundle text is not valid UTF-8", error);
    }
    this.consume(rest);
    // Every record is terminated by a newline, so text left over means the stream was cut.
    if (this.tail.length > 0) fail("bad_line", "The bundle ends in the middle of a line");
  }

  private consume(text: string): void {
    if (text.length === 0) return;
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline < 0) break;
      const line = this.tail + text.slice(start, newline);
      this.tail = "";
      if (line.length > MAX_BUNDLE_LINE_CHARS) fail("line_too_long", "A bundle line is too long");
      this.onLine(line);
      start = newline + 1;
    }
    this.tail += text.slice(start);
    if (this.tail.length > MAX_BUNDLE_LINE_CHARS)
      fail("line_too_long", "A bundle line is too long");
  }
}

const inflateInto = async (
  body: Uint8Array,
  limit: number,
  sink: (chunk: Uint8Array) => void,
): Promise<void> => {
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  // The input is fed while the output is read; a write that fails shows up on the reader too.
  const feeding = (async () => {
    try {
      await writer.write(body as Uint8Array<ArrayBuffer>);
      await writer.close();
    } catch {
      /* the failure is reported by the reader */
    }
  })();
  let total = 0;
  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        return fail("bad_gzip", "The bundle is not a complete gzip stream", error);
      }
      if (result.done) return;
      total += result.value.length;
      if (total > limit) {
        fail("decoded_too_large", `The bundle inflates beyond ${limit} bytes; refused`);
      }
      sink(result.value);
    }
  } finally {
    // Stops the decompressor (a bomb keeps producing) and releases the pending write.
    await reader.cancel().catch(() => undefined);
    await feeding;
  }
};

/**
 * Decodes the bytes of one bundle. Rejects with {@link SyncBundleError}; never returns a partial
 * result. See the module comment for what is and is not checked here.
 */
export const decodeBundle = async (
  bytes: Uint8Array,
  options: DecodeBundleOptions = {},
): Promise<DecodedBundle> => {
  const limit = options.maxDecodedBytes ?? MAX_DECODED_BUNDLE_BYTES;
  const { compression, bodyStart } = readPreamble(bytes);
  const assembler = new BundleAssembler(options.expectedDomain);
  const lines = new LineReader((line) => assembler.line(line));
  if (compression === "gzip") {
    if (typeof DecompressionStream !== "function") {
      fail("compression_unavailable", "This runtime cannot read compressed bundles");
    }
    await inflateInto(bytes.subarray(bodyStart), limit, (chunk) => lines.push(chunk));
  } else {
    if (bytes.length - bodyStart > limit) {
      fail("decoded_too_large", `The bundle body is larger than ${limit} bytes; refused`);
    }
    lines.push(bytes.subarray(bodyStart));
  }
  lines.end();
  return assembler.finish();
};
