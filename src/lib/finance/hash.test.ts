import { hash128 } from "./hash";

describe("finance hash128", () => {
  it("is deterministic for the same input", () => {
    expect(hash128("hello world")).toBe(hash128("hello world"));
  });

  it("produces a 32-character hex string", () => {
    expect(hash128("anything")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("differs for different inputs (distribution sanity)", () => {
    const values = ["a", "b", "aa", "ab", "ba", "transaction-1", "transaction-2"];
    const hashes = new Set(values.map((value) => hash128(value)));
    expect(hashes.size).toBe(values.length);
  });

  it("produces no collisions across a 50 000-row synthetic corpus", () => {
    const seen = new Set<string>();

    for (let index = 0; index < 50_000; index += 1) {
      const synthetic = `acct-${index % 20}|2026-0${(index % 9) + 1}-${String(
        (index % 27) + 1,
      ).padStart(2, "0")}|${index * 137}|CAD|MERCHANT ${index}|${index % 3}`;
      const digest = hash128(synthetic);
      expect(seen.has(digest)).toBe(false);
      seen.add(digest);
    }

    expect(seen.size).toBe(50_000);
  });
});
