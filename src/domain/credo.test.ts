import {
  credoDefinitions,
  credoKeys,
  deriveCredoKeys,
  isCredoKey,
  principleKeyToCredoKeys,
} from "./credo";
import { principleDefinitions } from "./definitions";

describe("credoDefinitions", () => {
  it("lists the ten credo items in written order", () => {
    expect(credoDefinitions).toHaveLength(10);
    expect(credoDefinitions.map((definition) => definition.order)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(new Set(credoKeys).size).toBe(10);
    expect(credoDefinitions.every((definition) => definition.statement.trim().length > 0)).toBe(
      true,
    );
  });
});

describe("principleKeyToCredoKeys", () => {
  it("maps every daily principle to at least one valid credo item", () => {
    for (const definition of principleDefinitions) {
      const mapped = principleKeyToCredoKeys[definition.key];
      expect(mapped, `missing bridge for ${definition.key}`).toBeDefined();
      expect(mapped.length).toBeGreaterThan(0);
      expect(mapped.every(isCredoKey)).toBe(true);
    }
  });

  it("has no entry for a key that is not a daily principle", () => {
    const principleKeys = new Set<string>(principleDefinitions.map((definition) => definition.key));
    expect(Object.keys(principleKeyToCredoKeys).filter((key) => !principleKeys.has(key))).toEqual(
      [],
    );
  });
});

describe("deriveCredoKeys", () => {
  it("dedupes credo items shared by several principles", () => {
    expect(deriveCredoKeys(["priereDuMatin", "priereDuSoir"])).toEqual(["procheDeDieu"]);
  });

  it("caps the result at three credo items", () => {
    // These four principles together reach five distinct credo items.
    const derived = deriveCredoKeys([
      "respectDeVieCommeJesus",
      "apprentissage",
      "attentionAMonEpouse",
      "objectifsAtteints",
    ]);
    expect(derived).toHaveLength(3);
    expect(derived.every(isCredoKey)).toBe(true);
  });

  it("returns a non-empty result for every single principle", () => {
    for (const definition of principleDefinitions) {
      expect(deriveCredoKeys([definition.key]).length).toBeGreaterThan(0);
    }
  });
});
