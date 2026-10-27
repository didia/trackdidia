import { describe, expect, it } from "vitest";
import { folderOverlap, normalizeFolderPath } from "./folder-paths";

describe("folderOverlap", () => {
  it("recognizes the same folder under any spelling", () => {
    expect(folderOverlap("/Drive/Perso", "/Drive/Perso")).toBe("same");
    expect(folderOverlap("/Drive/Perso/", "/drive/perso")).toBe("same");
    expect(folderOverlap("/Drive//Perso", "/Drive/Perso/")).toBe("same");
    expect(folderOverlap("C:\\Drive\\Perso", "c:/drive/perso/")).toBe("same");
    expect(folderOverlap("  /Drive/Perso  ", "/Drive/Perso")).toBe("same");
  });

  it("recognizes a folder inside or around the other", () => {
    expect(folderOverlap("/Drive/Perso/GTD", "/Drive/Perso")).toBe("inside");
    expect(folderOverlap("/Drive/Perso/backups", "/Drive/Perso/")).toBe("inside");
    expect(folderOverlap("/Drive", "/Drive/Perso")).toBe("contains");
    expect(folderOverlap("/", "/Drive/Perso")).toBe(null);
  });

  it("does not confuse siblings that share a name prefix", () => {
    expect(folderOverlap("/Drive/Perso2", "/Drive/Perso")).toBeNull();
    expect(folderOverlap("/Drive/Perso", "/Drive/Perso-GTD")).toBeNull();
    expect(folderOverlap("/Drive/GTD", "/Drive/Perso")).toBeNull();
  });

  it("says nothing about a folder that is not set", () => {
    expect(folderOverlap("", "/Drive/Perso")).toBeNull();
    expect(folderOverlap("/Drive/Perso", "   ")).toBeNull();
    expect(folderOverlap("", "")).toBeNull();
  });

  it("normalizes", () => {
    expect(normalizeFolderPath(" C:\\A\\B\\ ")).toBe("c:/a/b");
  });
});
