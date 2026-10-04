import { describe, expect, it } from "vitest";
import {
  isIsoDateString,
  isMonthKey,
  resolveInitialMonthlyReviewMonth,
  resolveInitialWeeklyReviewWeek,
} from "./review-query-params";

describe("review query params", () => {
  it("recognizes well-formed date and month values only", () => {
    expect(isIsoDateString("2026-03-14")).toBe(true);
    expect(isIsoDateString("2026-3-14")).toBe(false);
    expect(isIsoDateString("2026-03")).toBe(false);
    expect(isIsoDateString(null)).toBe(false);
    expect(isMonthKey("2026-03")).toBe(true);
    expect(isMonthKey("2026-03-14")).toBe(false);
    expect(isMonthKey("")).toBe(false);
    expect(isMonthKey(undefined)).toBe(false);
  });

  describe("resolveInitialWeeklyReviewWeek", () => {
    it("snaps a valid ?date= to its Sunday", () => {
      // 2026-03-11 is a Wednesday; its week starts on Sunday 2026-03-08.
      expect(resolveInitialWeeklyReviewWeek("2026-03-11", "2026-06-01")).toBe("2026-03-08");
    });

    it("keeps a Sunday ?date= on that week", () => {
      expect(resolveInitialWeeklyReviewWeek("2026-03-08", "2026-06-01")).toBe("2026-03-08");
    });

    it("falls back to the current week on a weekday when the param is missing or malformed", () => {
      // 2026-06-03 is a Wednesday; its week starts on Sunday 2026-05-31.
      expect(resolveInitialWeeklyReviewWeek(null, "2026-06-03")).toBe("2026-05-31");
      expect(resolveInitialWeeklyReviewWeek("last-week", "2026-06-03")).toBe("2026-05-31");
    });

    it("opens the week that just ended when today is Sunday", () => {
      expect(resolveInitialWeeklyReviewWeek(null, "2026-06-07")).toBe("2026-05-31");
    });
  });

  describe("resolveInitialMonthlyReviewMonth", () => {
    it("uses a valid ?month= deep link", () => {
      expect(resolveInitialMonthlyReviewMonth("2026-02", "2026-06-15")).toBe("2026-02");
    });

    it("falls back to the default month when the param is missing or malformed", () => {
      expect(resolveInitialMonthlyReviewMonth(null, "2026-06-15")).toBe("2026-06");
      expect(resolveInitialMonthlyReviewMonth("2026-2", "2026-06-15")).toBe("2026-06");
      expect(resolveInitialMonthlyReviewMonth("June", "2026-06-15")).toBe("2026-06");
    });

    it("opens the previous month on the first Saturday of a month", () => {
      // 2026-06-06 is the first Saturday of June 2026.
      expect(resolveInitialMonthlyReviewMonth(null, "2026-06-06")).toBe("2026-05");
    });
  });
});
