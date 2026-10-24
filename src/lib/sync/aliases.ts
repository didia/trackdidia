import { compareHlc } from "./hlc";

/**
 * Canonical identity, the pure half: the alias classes of `sync_id_aliases`.
 *
 * Two peers can mint different ids for one entity (the same statement imported on two laptops).
 * The engine picks the lexicographically smaller id as canonical and records the other as an alias.
 * With three replicas the aliases chain (B -> A, then C -> B), so the stored relation is an
 * equivalence relation, not a map: an {@link AliasIndex} keeps its classes (union-find) and every
 * class has ONE root, the smallest id of the class under plain code-unit comparison (`<` on
 * strings: a total order, so every replica picks the same root whatever order it met the pairs).
 *
 * Properties the apply path relies on (all pinned by `aliases.test.ts`):
 * - the classes, their roots and the rows {@link AliasIndex.records} are a function of the SET of
 *   pairs learned, not of their order (commutative and associative), and learning a pair twice
 *   changes nothing (idempotent);
 * - the stored rows are path-compressed: every non-root member points straight at its root, so a
 *   reader never follows a chain;
 * - `recordedHlc` is a grow-only clock: a member's row carries the LARGEST clock recorded for its
 *   class. The clock is informational (it only has to be a clock some device issued, so the bundle's
 *   `hlcHigh` covers it); defining it per class keeps the stored rows order independent even though
 *   path compression moves a member's row between chains.
 *
 * No I/O here: `alias-store.ts` loads and persists, `apply-aliases.ts` acts on the changes.
 */

/** One `sync_id_aliases` row. */
export interface AliasRecord {
  entityType: string;
  aliasId: string;
  canonicalId: string;
  recordedHlc: string;
}

/** An id whose class root changed while learning a pair. */
export interface RootMove {
  entityType: string;
  /** The id that stops being a root or whose root moved. */
  id: string;
  /** Its previous root (itself when it was alone). */
  from: string;
  /** Its new root. */
  to: string;
}

/** Plain code-unit order: the total order the canonical id is chosen by. */
export const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface TypeClasses {
  /** Non-root member -> its root. */
  rootOf: Map<string, string>;
  /** Root -> its non-root members. Only roots with members are present. */
  members: Map<string, Set<string>>;
  /** Root -> the largest clock recorded for the class. */
  clock: Map<string, string>;
}

const laterClock = (a: string | undefined, b: string | undefined): string | undefined =>
  a === undefined ? b : b === undefined ? a : compareHlc(a, b) >= 0 ? a : b;

export class AliasIndex {
  private readonly types = new Map<string, TypeClasses>();

  constructor(records: readonly AliasRecord[] = []) {
    // Order independent by construction, but a stable order keeps the work reproducible.
    for (const record of [...records].sort(
      (a, b) =>
        compareIds(a.entityType, b.entityType) ||
        compareIds(a.aliasId, b.aliasId) ||
        compareIds(a.canonicalId, b.canonicalId),
    )) {
      this.learn(record.entityType, record.aliasId, record.canonicalId, record.recordedHlc);
    }
  }

  private classesOf(entityType: string): TypeClasses {
    let classes = this.types.get(entityType);
    if (classes === undefined) {
      classes = { rootOf: new Map(), members: new Map(), clock: new Map() };
      this.types.set(entityType, classes);
    }
    return classes;
  }

  /** True when no alias is known at all (the common case: nothing to rewrite). */
  isEmpty(): boolean {
    for (const classes of this.types.values()) {
      if (classes.rootOf.size > 0) return false;
    }
    return true;
  }

  /** True when `entityType` has at least one alias. */
  hasAliases(entityType: string): boolean {
    return (this.types.get(entityType)?.rootOf.size ?? 0) > 0;
  }

  /** The root of the class of `id`; `id` itself when it is a root or unknown. */
  resolve(entityType: string, id: string): string {
    return this.types.get(entityType)?.rootOf.get(id) ?? id;
  }

  /** True when `id` is a known non-root member (an alias). */
  isAlias(entityType: string, id: string): boolean {
    return this.types.get(entityType)?.rootOf.has(id) ?? false;
  }

  /** Every non-root member of the class rooted at `root`. */
  aliasesOf(entityType: string, root: string): string[] {
    return [...(this.types.get(entityType)?.members.get(root) ?? [])].sort(compareIds);
  }

  /** Every alias (non-root member) of an entity type, sorted. */
  allAliases(entityType: string): string[] {
    return [...(this.types.get(entityType)?.rootOf.keys() ?? [])].sort(compareIds);
  }

  /**
   * Merges the classes of `a` and `b` and records `hlc` for the merged class. Returns the ids whose
   * root changed: the root that lost (and its members) now point at the smaller of the two roots.
   * Learning a pair that is already in one class returns no move (the clock may still grow).
   */
  learn(entityType: string, a: string, b: string, hlc: string): RootMove[] {
    if (a === b) {
      throw new Error(`An id cannot be its own alias (${entityType} ${a})`);
    }
    const classes = this.classesOf(entityType);
    const rootA = classes.rootOf.get(a) ?? a;
    const rootB = classes.rootOf.get(b) ?? b;
    if (rootA === rootB) {
      const merged = laterClock(classes.clock.get(rootA), hlc) as string;
      classes.clock.set(rootA, merged);
      return [];
    }
    const root = compareIds(rootA, rootB) < 0 ? rootA : rootB;
    const loser = root === rootA ? rootB : rootA;
    const moved = [loser, ...(classes.members.get(loser) ?? [])].sort(compareIds);

    const members = classes.members.get(root) ?? new Set<string>();
    for (const id of moved) {
      members.add(id);
      classes.rootOf.set(id, root);
    }
    classes.members.set(root, members);
    classes.members.delete(loser);

    const merged = laterClock(
      laterClock(classes.clock.get(rootA), classes.clock.get(rootB)),
      hlc,
    ) as string;
    classes.clock.set(root, merged);
    classes.clock.delete(loser);
    return moved.map((id) => ({ entityType, id, from: loser, to: root }));
  }

  /** The largest clock recorded for the class of `id`, or `null` for an id with no alias. */
  clockOf(entityType: string, id: string): string | null {
    const classes = this.types.get(entityType);
    if (classes === undefined) return null;
    return classes.clock.get(classes.rootOf.get(id) ?? id) ?? null;
  }

  /** The rows to store: every non-root member -> root, with the class clock. Sorted. */
  records(): AliasRecord[] {
    const rows: AliasRecord[] = [];
    for (const [entityType, classes] of this.types) {
      for (const [aliasId, canonicalId] of classes.rootOf) {
        rows.push({
          entityType,
          aliasId,
          canonicalId,
          recordedHlc: classes.clock.get(canonicalId) as string,
        });
      }
    }
    return rows.sort(
      (a, b) => compareIds(a.entityType, b.entityType) || compareIds(a.aliasId, b.aliasId),
    );
  }
}
