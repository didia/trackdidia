/**
 * Linear-time collection helpers for the alias path. A first merge can move tens of thousands of
 * ids, so nothing on that path may copy an accumulator per element (`[...list, item]`) or search an
 * array per element (`array.includes`); `collections.test.ts` pins the helpers at scale.
 */

/** Appends `value` to the list stored under `key`, creating it; returns the list. */
export const appendTo = <K, V>(map: Map<K, V[]>, key: K, value: V): V[] => {
  const list = map.get(key);
  if (list === undefined) {
    const created = [value];
    map.set(key, created);
    return created;
  }
  list.push(value);
  return list;
};

/** The items that are not in `excluded`, in order. */
export const without = <T>(items: readonly T[], excluded: ReadonlySet<T>): T[] =>
  items.filter((item) => !excluded.has(item));

/** The largest list length of a map of lists (0 when empty), without spreading into `Math.max`. */
export const longestList = <V>(lists: Iterable<readonly V[]>): number => {
  let longest = 0;
  for (const list of lists) if (list.length > longest) longest = list.length;
  return longest;
};
