import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "./shared";

describe("createEntityId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns prefix:<uuid> from crypto.randomUUID", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-2222-4333-8444-555555555555" });

    expect(createEntityId("task")).toBe("task:11111111-2222-4333-8444-555555555555");
  });

  it("mints distinct ids with the real crypto", () => {
    expect(createEntityId("task")).toMatch(/^task:[0-9a-f-]{36}$/);
    expect(createEntityId("task")).not.toBe(createEntityId("task"));
  });

  it("throws instead of falling back when randomUUID is absent", () => {
    vi.stubGlobal("crypto", {});
    expect(() => createEntityId("task")).toThrow(/randomUUID/);

    vi.stubGlobal("crypto", undefined);
    expect(() => createEntityId("task")).toThrow(/randomUUID/);
  });
});
