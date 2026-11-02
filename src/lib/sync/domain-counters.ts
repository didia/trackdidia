import { SYNC_DOMAINS, type SyncDomain } from "./registry";
import { toCounter } from "./status";

/**
 * Per-domain change detection (migration 47). `sync_identity.change_counter` is one counter for the
 * whole database and stays the answer to "anything to publish?" (a single comparison with
 * `last_publish_counter`). Next to it, one column per bundle domain holds the value `change_counter`
 * reached when that domain was LAST changed, so a publish can tell which domains changed after the
 * last publish and rebuild only those: reading the `finance` domain for a bundle is the largest
 * memory cost of a publish, and a task edit must not pay it.
 *
 * Every statement that raises `change_counter` raises the columns of the domains it changed in the
 * same UPDATE (in SQLite every right-hand side reads the row as it was before the statement, so
 * `column = change_counter + n` is the new counter), inside the transaction that made the change.
 */

/** The column holding the counter a domain last changed at. A fixed map: never built from input. */
export const DOMAIN_COUNTER_COLUMN = {
  gtd: "gtd_changed_counter",
  personal: "personal_changed_counter",
  finance: "finance_changed_counter",
} as const satisfies Record<SyncDomain, string>;

/**
 * `UPDATE sync_identity SET change_counter = change_counter + <amount>, <each domain> = ...`. `amount`
 * is SQL text (`"1"` or a bound parameter such as `"$1"`), never user input. With no domains named
 * (a change whose domain is not known) every domain is raised, which is the safe direction: a domain
 * is published when in doubt.
 */
export const bumpChangeCounterSql = (domains: Iterable<SyncDomain>, amount: "1" | "$1"): string => {
  const touched = new Set<SyncDomain>(domains);
  const columns = (
    touched.size === 0 ? [...SYNC_DOMAINS] : SYNC_DOMAINS.filter((d) => touched.has(d))
  ).map((domain) => DOMAIN_COUNTER_COLUMN[domain]);
  const assignments = [`change_counter = change_counter + ${amount}`].concat(
    columns.map((column) => `${column} = change_counter + ${amount}`),
  );
  return `UPDATE sync_identity SET ${assignments.join(", ")} WHERE id = 1`;
};

/** The counter each domain last changed at, as read from `sync_identity` (missing or garbage is 0). */
export type DomainCounters = Readonly<Record<SyncDomain, number>>;

export const domainCountersFromRow = (
  row: Record<string, unknown> | undefined,
): DomainCounters => ({
  gtd: toCounter(row?.[DOMAIN_COUNTER_COLUMN.gtd]),
  personal: toCounter(row?.[DOMAIN_COUNTER_COLUMN.personal]),
  finance: toCounter(row?.[DOMAIN_COUNTER_COLUMN.finance]),
});

/** `SELECT` list for the three domain columns. */
export const DOMAIN_COUNTER_SELECT = SYNC_DOMAINS.map(
  (domain) => DOMAIN_COUNTER_COLUMN[domain],
).join(", ");
