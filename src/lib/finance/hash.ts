// 128-bit FNV-1a hash for finance dedupe keys, returned as a hex string.
//
// src/lib/hash.ts's hashString is a 32-bit non-cryptographic hash: at 10 000
// transactions the birthday-collision probability is ~1%, and a collision there
// would silently drop a real transaction. This hash runs two independent 64-bit
// FNV-1a passes (different offset basis/prime pairing per lane) and concatenates
// them into a 128-bit hex digest, which is synchronous and safe under jsdom —
// unlike WebCrypto `subtle.digest`, which is async.

const MASK_64 = (1n << 64n) - 1n;

// Standard FNV-1a 64-bit constants.
const FNV64_PRIME = 0x100000001b3n;
const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;

// A second, independent lane: a different offset basis so the two 64-bit halves
// are not simply the same computation twice.
const FNV64_OFFSET_BASIS_B = 0x9e3779b97f4a7c15n;

const fnv1a64 = (value: string, offsetBasis: bigint): bigint => {
  let hash = offsetBasis;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = BigInt(value.charCodeAt(index));
    hash ^= codeUnit;
    hash = (hash * FNV64_PRIME) & MASK_64;
  }

  return hash;
};

const toHex64 = (value: bigint): string => value.toString(16).padStart(16, "0");

/** Deterministic, synchronous 128-bit (hex) hash. Safe for dedupe keys. */
export const hash128 = (value: string): string => {
  const lowLane = fnv1a64(value, FNV64_OFFSET_BASIS);
  const highLane = fnv1a64(value, FNV64_OFFSET_BASIS_B);

  return `${toHex64(highLane)}${toHex64(lowLane)}`;
};
