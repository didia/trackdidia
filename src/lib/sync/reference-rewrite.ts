import { dedupeHash } from "../finance/import-profile";
import type { RawRow } from "./capture-decode";
import { entityIdOf, parseEntityId } from "./entity-id";
import {
  getTableRegistration,
  isAliasableTable,
  type ReferenceDerivation,
  type ReferenceKind,
  TABLE_REGISTRY,
} from "./registry";

/**
 * Canonical identity, the pure half of reference rewriting.
 *
 * When an id becomes an alias, every place that names it must name the canonical id instead:
 * the entity's own primary key, SQL columns of other tables, ids inside JSON documents and values
 * derived from ids. The places are exactly the registry's declared `references` whose target table
 * is aliasable (plus the rows' own ids), so the registry stays the single source and
 * `reference-rewrite.test.ts` fails when a declared reference has no rule here.
 *
 * Everything here is a pure function of a row and a resolver (`entity type, id -> canonical id`),
 * so the same transformation runs on a stored row, on a row of an incoming bundle ("alias on
 * decode") and in the tests, and gives the same result on every replica that knows the same
 * aliases. A row that needs no change comes back as `null`.
 */

export type Resolver = (entityType: string, id: string) => string;

/** One rewriting rule: a declared reference whose target is aliasable. */
export interface RewriteRule {
  column: string;
  target: string;
  kind: ReferenceKind;
  path?: string;
  derive?: ReferenceDerivation;
}

/** Highest `occurrenceIndex` the account re-derivation searches for (see {@link rederiveDedupeHash}). */
export const MAX_OCCURRENCE_INDEX = 256;

const rulesByTable = (): Map<string, RewriteRule[]> => {
  const rules = new Map<string, RewriteRule[]>();
  for (const entry of TABLE_REGISTRY) {
    for (const reference of entry.references) {
      if (!isAliasableTable(reference.table)) continue;
      const list = rules.get(entry.table) ?? [];
      list.push({
        column: reference.column,
        target: reference.table,
        kind: reference.kind,
        ...(reference.path === undefined ? {} : { path: reference.path }),
        ...(reference.derive === undefined ? {} : { derive: reference.derive }),
      });
      rules.set(entry.table, list);
    }
  }
  return rules;
};

let cachedRules: Map<string, RewriteRule[]> | null = null;

/** The rules of a table, plain references first and derived ones last (they read the others). */
export const rewriteRulesOf = (table: string): readonly RewriteRule[] => {
  cachedRules ??= rulesByTable();
  const rules = cachedRules.get(table) ?? [];
  return [...rules].sort((a, b) => Number(a.kind === "derived") - Number(b.kind === "derived"));
};

/** Every table that holds at least one reference to an aliasable table, in registry order. */
export const tablesWithRewriteRules = (): string[] => {
  cachedRules ??= rulesByTable();
  return TABLE_REGISTRY.filter((entry) => cachedRules?.has(entry.table)).map(
    (entry) => entry.table,
  );
};

// ---------------------------------------------------------------------------------------------
// Ids embedded in longer strings
// ---------------------------------------------------------------------------------------------

/** Longest id (in `:`-separated pieces) searched for inside a derived value. */
const MAX_ID_PIECES = 4;

/**
 * Replaces every id of `resolve` that appears as a whole run of `:`-separated pieces inside
 * `value` (`weekly_carryover:2026-04-19:task:abc` holds the id `task:abc`). Longest run first, left
 * to right, no overlap. Whole pieces only, so an id never matches inside another one. Returns
 * `value` itself when nothing changes.
 */
export const rewriteEmbeddedIds = (value: string, resolve: (id: string) => string): string => {
  const pieces = value.split(":");
  const out: string[] = [];
  let changed = false;
  let index = 0;
  while (index < pieces.length) {
    let replaced = false;
    for (let width = Math.min(MAX_ID_PIECES, pieces.length - index); width >= 1; width -= 1) {
      const candidate = pieces.slice(index, index + width).join(":");
      const target = resolve(candidate);
      if (target !== candidate) {
        out.push(target);
        index += width;
        replaced = true;
        changed = true;
        break;
      }
    }
    if (!replaced) {
      out.push(pieces[index] as string);
      index += 1;
    }
  }
  return changed ? out.join(":") : value;
};

const TRANSFER_PREFIX = "transfer:";

/**
 * `transfer:<idA>:<idB>` with the two transaction ids sorted, as the app builds it. Ids hold `:`
 * themselves, so the pair is found by trying every split. A pair with an aliased id is rebuilt from
 * the canonical ids and sorted again, so a group made from the same two transactions has the same
 * value whichever laptop named it.
 */
export const rewriteTransferGroup = (value: string, resolve: (id: string) => string): string => {
  if (!value.startsWith(TRANSFER_PREFIX)) return value;
  const pieces = value.slice(TRANSFER_PREFIX.length).split(":");
  for (let split = 1; split < pieces.length; split += 1) {
    const first = pieces.slice(0, split).join(":");
    const second = pieces.slice(split).join(":");
    const left = resolve(first);
    const right = resolve(second);
    if (left !== first || right !== second) {
      const [a, b] = [left, right].sort();
      return `${TRANSFER_PREFIX}${a}:${b}`;
    }
  }
  return value;
};

// ---------------------------------------------------------------------------------------------
// JSON documents
// ---------------------------------------------------------------------------------------------

interface ParsedPath {
  keys: string[];
  list: boolean;
}

const parsePath = (path: string): ParsedPath => {
  if (!path.startsWith("$.")) {
    throw new Error(`Unsupported JSON path "${path}"`);
  }
  const list = path.endsWith("[]");
  const keys = (list ? path.slice(2, -2) : path.slice(2)).split(".");
  if (keys.some((key) => key.length === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
    throw new Error(`Unsupported JSON path "${path}"`);
  }
  return { keys, list };
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Rewrites the ids at `path` in place; true when anything changed. */
const rewriteAtPath = (
  document: unknown,
  { keys, list }: ParsedPath,
  map: (id: string) => string,
): boolean => {
  let node: unknown = document;
  for (const key of keys.slice(0, -1)) {
    if (!isObject(node)) return false;
    node = Object.hasOwn(node, key) ? node[key] : undefined;
  }
  const last = keys[keys.length - 1] as string;
  if (!isObject(node) || !Object.hasOwn(node, last)) return false;
  const current = node[last];
  if (list) {
    if (!Array.isArray(current)) return false;
    let changed = false;
    for (let index = 0; index < current.length; index += 1) {
      const item = current[index];
      if (typeof item === "string") {
        const next = map(item);
        if (next !== item) {
          current[index] = next;
          changed = true;
        }
      }
    }
    return changed;
  }
  if (typeof current !== "string") return false;
  const next = map(current);
  if (next === current) return false;
  node[last] = next;
  return true;
};

/**
 * Rewrites the ids at a registry JSON path inside a JSON column. Returns the new compact JSON text,
 * or `null` when nothing changes or the text is not JSON (an unparsable document is left alone).
 */
export const rewriteJsonText = (
  text: string,
  path: string,
  map: (id: string) => string,
): string | null => {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  return rewriteAtPath(document, parsePath(path), map) ? JSON.stringify(document) : null;
};

/**
 * Rewrites the ids of a JSON array of ids (`context_ids_json`). Returns the new compact JSON text,
 * or `null` when nothing changes or the text is not an array.
 */
export const rewriteIdListText = (text: string, map: (id: string) => string): string | null => {
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const mapped = list.map((id) => (typeof id === "string" ? map(id) : id));
  return mapped.some((id, index) => id !== list[index]) ? JSON.stringify(mapped) : null;
};

// ---------------------------------------------------------------------------------------------
// Derived account hashes
// ---------------------------------------------------------------------------------------------

/**
 * `finance_transactions.dedupe_hash` hashes the ACCOUNT ID together with the statement line and an
 * occurrence index that is not stored. When an account becomes an alias its transactions move to
 * the canonical account and their hash must be the one an import into that account would compute,
 * or two copies of one statement line (one per account) would never collide on the natural key and a
 * later re-import would insert duplicates.
 *
 * The index is recovered by trying 0..{@link MAX_OCCURRENCE_INDEX} against the stored hash with the
 * old account id. A hash that matches no index (a manual transaction, an edited description) is
 * left as it is: it is not a statement line, so it has no twin to collide with.
 */
export const rederiveDedupeHash = (
  row: RawRow,
  oldAccountId: string,
  newAccountId: string,
): string | null => {
  const stored = row.dedupe_hash;
  if (typeof stored !== "string") return null;
  const base = {
    postedDate: String(row.posted_date ?? ""),
    amountMinor: Number(row.amount_minor),
    currency: String(row.currency ?? ""),
    descriptionRaw: String(row.description_raw ?? ""),
  };
  for (let occurrenceIndex = 0; occurrenceIndex <= MAX_OCCURRENCE_INDEX; occurrenceIndex += 1) {
    if (dedupeHash({ ...base, accountId: oldAccountId, occurrenceIndex }) === stored) {
      return dedupeHash({ ...base, accountId: newAccountId, occurrenceIndex });
    }
  }
  return null;
};

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

const ACCOUNT_COLUMN = "account_id";

const applyRule = (
  rule: RewriteRule,
  row: RawRow,
  before: RawRow,
  resolve: Resolver,
): unknown | undefined => {
  const value = row[rule.column];
  if (rule.kind === "derived") {
    if (rule.derive === "account-dedupe-hash") {
      const from = before[ACCOUNT_COLUMN];
      const to = row[ACCOUNT_COLUMN];
      if (typeof from !== "string" || typeof to !== "string" || from === to) return undefined;
      return rederiveDedupeHash(row, from, to) ?? undefined;
    }
    if (typeof value !== "string") return undefined;
    const map = (id: string): string => resolve(rule.target, id);
    const next =
      rule.derive === "transfer-group"
        ? rewriteTransferGroup(value, map)
        : rewriteEmbeddedIds(value, map);
    return next === value ? undefined : next;
  }
  if (rule.kind === "json-payload") {
    if (typeof value !== "string" || rule.path === undefined) return undefined;
    return rewriteJsonText(value, rule.path, (id) => resolve(rule.target, id)) ?? undefined;
  }
  if (rule.kind === "json-id-list") {
    if (typeof value !== "string") return undefined;
    return rewriteIdListText(value, (id) => resolve(rule.target, id)) ?? undefined;
  }
  // foreign-key, soft and polymorphic: the column holds one id.
  if (typeof value !== "string") return undefined;
  const next = resolve(rule.target, value);
  return next === value ? undefined : next;
};

/**
 * The row with every reference rewritten through `resolve`, or `null` when nothing changes. The
 * primary key columns that are themselves references (`finance_merchant_memory.account_id`) are
 * rewritten like any other; the row's own `id` is {@link rewriteIdentity}'s business.
 */
export const rewriteReferences = (table: string, row: RawRow, resolve: Resolver): RawRow | null => {
  const rules = rewriteRulesOf(table);
  if (rules.length === 0) return null;
  let next: RawRow = row;
  for (const rule of rules) {
    const replaced = applyRule(rule, next, row, resolve);
    if (replaced !== undefined) {
      next = { ...next, [rule.column]: replaced };
    }
  }
  return next === row ? null : next;
};

/** The row with its own id replaced by the canonical one, or `null` (also for non-aliasable tables). */
export const rewriteIdentity = (table: string, row: RawRow, resolve: Resolver): RawRow | null => {
  if (!isAliasableTable(table)) return null;
  const column = getTableRegistration(table).primaryKey[0] as string;
  const value = row[column];
  if (typeof value !== "string") return null;
  const canonical = resolve(table, value);
  return canonical === value ? null : { ...row, [column]: canonical };
};

/** Identity first, then references: the whole "alias on decode" transformation of one row. */
export const rewriteSyncRow = (table: string, row: RawRow, resolve: Resolver): RawRow | null => {
  const identity = rewriteIdentity(table, row, resolve);
  const references = rewriteReferences(table, identity ?? row, resolve);
  return references ?? identity;
};

/**
 * The entity id after rewriting: an aliasable table's id is resolved; a composite key whose columns
 * are references (`["cafe","acc-2",-1]`) is rebuilt from the rewritten key columns. `entityId`
 * itself when nothing changes.
 */
export const rewriteEntityId = (table: string, entityId: string, resolve: Resolver): string => {
  const registration = getTableRegistration(table);
  if (isAliasableTable(table)) return resolve(table, entityId);
  if (registration.primaryKey.length === 1 || rewriteRulesOf(table).length === 0) return entityId;
  const key = parseEntityId(table, entityId);
  if (key === null) return entityId;
  const keyRow: RawRow = {};
  registration.primaryKey.forEach((column, index) => {
    keyRow[column] = key[index];
  });
  const rewritten = rewriteReferences(table, keyRow, resolve);
  if (rewritten === null) return entityId;
  return entityIdOf(
    table,
    registration.primaryKey.map((column) => rewritten[column]),
  );
};
