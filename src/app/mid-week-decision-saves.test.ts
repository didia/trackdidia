import { afterEach, describe, expect, it } from "vitest";
import {
  clearFailedMidWeekDraft,
  enqueueMidWeekDecisionSave,
  getFailedMidWeekDraft,
  waitForMidWeekDecisionSaves,
} from "./mid-week-decision-saves";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mid-week decision save queue", () => {
  afterEach(() => {
    clearFailedMidWeekDraft("2026-08-02");
    clearFailedMidWeekDraft("2026-08-09");
  });

  it("runs saves for one week in order even when the first task waits longer", async () => {
    const order: string[] = [];
    const first = enqueueMidWeekDecisionSave("2026-08-02", "old", async () => {
      await delay(30);
      order.push("old");
    });
    const second = enqueueMidWeekDecisionSave("2026-08-02", "new", async () => {
      order.push("new");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["old", "new"]);
  });

  it("does not block different weeks on each other", async () => {
    const order: string[] = [];
    const slow = enqueueMidWeekDecisionSave("2026-08-02", "a", async () => {
      await delay(40);
      order.push("slow");
    });
    const fast = enqueueMidWeekDecisionSave("2026-08-09", "b", async () => {
      order.push("fast");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["fast", "slow"]);
  });

  it("records a failed draft, re-throws, and clears it after a later success", async () => {
    await expect(
      enqueueMidWeekDecisionSave("2026-08-02", "draft", async () => {
        throw new Error("disk");
      }),
    ).rejects.toThrow("disk");
    expect(getFailedMidWeekDraft("2026-08-02")).toMatchObject({ text: "draft" });

    await enqueueMidWeekDecisionSave("2026-08-02", "draft", async () => undefined);
    expect(getFailedMidWeekDraft("2026-08-02")).toBeUndefined();
  });

  it("keeps running later saves after an earlier one failed", async () => {
    const ran: string[] = [];
    const failing = enqueueMidWeekDecisionSave("2026-08-02", "a", async () => {
      throw new Error("x");
    });
    const next = enqueueMidWeekDecisionSave("2026-08-02", "b", async () => {
      ran.push("b");
    });
    await expect(failing).rejects.toThrow();
    await next;
    expect(ran).toEqual(["b"]);
  });

  it("waits for a follow-up save enqueued right after the previous one settles", async () => {
    const order: string[] = [];
    const first = enqueueMidWeekDecisionSave("2026-08-02", "A", async () => {
      await delay(20);
      order.push("A");
    });
    void first.then(() => {
      void enqueueMidWeekDecisionSave("2026-08-02", "AB", async () => {
        await delay(20);
        order.push("AB");
      });
    });
    await waitForMidWeekDecisionSaves("2026-08-02");
    expect(order).toEqual(["A", "AB"]);
  });

  it("never rejects and returns immediately when nothing is queued", async () => {
    await expect(waitForMidWeekDecisionSaves("2026-08-16")).resolves.toBeUndefined();
    const failing = enqueueMidWeekDecisionSave("2026-08-02", "x", async () => {
      throw new Error("x");
    });
    failing.catch(() => undefined);
    await expect(waitForMidWeekDecisionSaves("2026-08-02")).resolves.toBeUndefined();
  });
});
