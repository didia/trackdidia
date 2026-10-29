// Test-only: nothing in the app imports this file.
import { getTableRegistration } from "../registry";

/**
 * A readable difference between two canonical domain states (see `stateOf` in the property tests):
 * one short line per differing row, column, clock or setting instead of two giant objects. An empty
 * list means equal (rows are keyed by the registry's primary key, never by a guess). Bounded, so a wholesale divergence stays readable.
 */

type Row = Record<string, unknown>;
interface State {
  tables?: Record<string, Row[]>;
  meta?: Row[];
  snapshots?: Row[];
  settings?: Record<string, unknown>;
  aliases?: Row[];
}

const MAX_LINES = 30;
const short = (value: unknown): string => (JSON.stringify(value) ?? "undefined").slice(0, 90);

/** How a row is identified inside its group: by columns that the registry declares as the key. */
type KeyOf = (row: Row) => string;

const byColumns =
  (columns: readonly string[]): KeyOf =>
  (row) =>
    JSON.stringify(columns.map((column) => row[column] ?? null));

const tableKey = (table: string): KeyOf => byColumns(getTableRegistration(table).primaryKey);
const metaKey: KeyOf = byColumns(["entity_type", "entity_id"]);
const aliasKey: KeyOf = byColumns(["entity_type", "alias_id"]);

const diffRows = (label: string, left: Row[], right: Row[], keyOf: KeyOf, out: string[]): void => {
  const l = new Map(left.map((row) => [keyOf(row), row]));
  const r = new Map(right.map((row) => [keyOf(row), row]));
  // A key shared by two rows of one side would hide a difference: say so instead.
  for (const [side, rows, map] of [
    ["first", left, l],
    ["second", right, r],
  ] as const) {
    if (rows.length !== map.size) out.push(`${label}: duplicate keys in the ${side} state`);
  }
  for (const key of new Set([...l.keys(), ...r.keys()])) {
    const a = l.get(key);
    const b = r.get(key);
    if (!a || !b) {
      out.push(`${label} ${key}: only ${a ? "in the first" : "in the second"} state`);
      continue;
    }
    for (const column of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[column]) !== JSON.stringify(b[column])) {
        out.push(`${label} ${key} .${column}: ${short(a[column])}  vs  ${short(b[column])}`);
      }
    }
  }
};

export const diffStates = (first: unknown, second: unknown): string[] => {
  const x = first as State;
  const y = second as State;
  const out: string[] = [];
  for (const table of new Set([...Object.keys(x.tables ?? {}), ...Object.keys(y.tables ?? {})])) {
    diffRows(table, x.tables?.[table] ?? [], y.tables?.[table] ?? [], tableKey(table), out);
  }
  diffRows("meta", x.meta ?? [], y.meta ?? [], metaKey, out);
  diffRows("snapshot", x.snapshots ?? [], y.snapshots ?? [], metaKey, out);
  diffRows("alias", x.aliases ?? [], y.aliases ?? [], aliasKey, out);
  for (const key of new Set([...Object.keys(x.settings ?? {}), ...Object.keys(y.settings ?? {})])) {
    if (JSON.stringify(x.settings?.[key]) !== JSON.stringify(y.settings?.[key])) {
      out.push(`setting ${key}: ${short(x.settings?.[key])}  vs  ${short(y.settings?.[key])}`);
    }
  }
  return out.length > MAX_LINES
    ? [...out.slice(0, MAX_LINES), `... ${out.length - MAX_LINES} more`]
    : out;
};

/** Diffs two maps of domain states and labels each line with its domain. */
export const diffDomainStates = (
  first: Record<string, unknown>,
  second: Record<string, unknown>,
): string[] =>
  Object.keys(first).flatMap((domain) =>
    diffStates(first[domain], second[domain]).map((line) => `[${domain}] ${line}`),
  );
