import { describe, expect, it } from "vitest";
import { rescueTimeCredentialFingerprint } from "./credential-fingerprint";

describe("rescueTimeCredentialFingerprint", () => {
  it("is stable, 16 hex characters and never contains the key", async () => {
    const first = await rescueTimeCredentialFingerprint("key-a-secret");
    const second = await rescueTimeCredentialFingerprint("key-a-secret");
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(first).not.toContain("secret");
  });

  it("differs per key", async () => {
    expect(await rescueTimeCredentialFingerprint("key-a")).not.toBe(
      await rescueTimeCredentialFingerprint("key-b"),
    );
  });

  it("trims surrounding whitespace", async () => {
    expect(await rescueTimeCredentialFingerprint("  key-a \n")).toBe(
      await rescueTimeCredentialFingerprint("key-a"),
    );
  });
});
