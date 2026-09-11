import { describe, expect, it } from "vitest";
import {
  clearCachedAccessToken,
  getCachedAccessToken,
  setCachedAccessToken,
  __tokenCacheForTests,
} from "./token-cache";

describe("token cache", () => {
  it("stores access tokens only in memory", () => {
    setCachedAccessToken("acct-1", "token-a", 3600);
    expect(getCachedAccessToken("acct-1")).toBe("token-a");
    clearCachedAccessToken("acct-1");
    expect(getCachedAccessToken("acct-1")).toBeNull();
    expect(__tokenCacheForTests.size()).toBe(0);
  });
});
