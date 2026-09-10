import { describe, expect, it } from "vitest";
import {
  createPkceChallenge,
  generateOAuthState,
  generatePkceVerifier,
  validateOAuthState,
} from "./pkce";

describe("pkce helpers", () => {
  it("generates verifier, challenge, and state values", async () => {
    const verifier = generatePkceVerifier();
    const challenge = await createPkceChallenge(verifier);
    const state = generateOAuthState();
    expect(verifier.length).toBeGreaterThan(20);
    expect(challenge.length).toBeGreaterThan(20);
    expect(state.length).toBeGreaterThan(20);
  });

  it("validates oauth state exactly", () => {
    expect(validateOAuthState("abc", "abc")).toBe(true);
    expect(validateOAuthState("abc", "def")).toBe(false);
  });
});
