/** Deterministic, non-cryptographic string hash used for stable "pick of the day" indexing. */
export const hashString = (value: string): number => {
  let hash = 0;

  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return hash;
};
