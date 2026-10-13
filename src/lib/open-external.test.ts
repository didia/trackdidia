import { describe, expect, it } from "vitest";
import { isWebUrl } from "./open-external";

describe("isWebUrl", () => {
  it("accepts http and https links only", () => {
    expect(isWebUrl("https://mail.google.com/mail/u/0/#inbox/abc")).toBe(true);
    expect(isWebUrl("http://example.com")).toBe(true);
    expect(isWebUrl("javascript:alert(1)")).toBe(false);
    expect(isWebUrl("message://%3Cid@example.com%3E")).toBe(false);
    expect(isWebUrl("not a url")).toBe(false);
    expect(isWebUrl("")).toBe(false);
    expect(isWebUrl(null)).toBe(false);
  });
});
