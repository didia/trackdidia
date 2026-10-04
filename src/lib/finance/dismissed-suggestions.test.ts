import { isSuggestionDismissed } from "./dismissed-suggestions";

describe("isSuggestionDismissed", () => {
  it("suppresses a pair dismissed today", () => {
    const dismissed = [
      { merchantKey: "IGA", categoryId: "fincat:alimentation.epicerie", dismissedAt: "2026-01-01" },
    ];
    expect(
      isSuggestionDismissed(dismissed, "IGA", "fincat:alimentation.epicerie", "2026-01-01"),
    ).toBe(true);
  });

  it("suppresses within the 90-day window", () => {
    const dismissed = [
      { merchantKey: "IGA", categoryId: "fincat:alimentation.epicerie", dismissedAt: "2026-01-01" },
    ];
    expect(
      isSuggestionDismissed(dismissed, "IGA", "fincat:alimentation.epicerie", "2026-03-31"),
    ).toBe(true);
  });

  it("no longer suppresses after 90 days", () => {
    const dismissed = [
      { merchantKey: "IGA", categoryId: "fincat:alimentation.epicerie", dismissedAt: "2026-01-01" },
    ];
    expect(
      isSuggestionDismissed(dismissed, "IGA", "fincat:alimentation.epicerie", "2026-04-02"),
    ).toBe(false);
  });

  it("does not suppress a different category for the same merchant", () => {
    const dismissed = [
      { merchantKey: "IGA", categoryId: "fincat:alimentation.epicerie", dismissedAt: "2026-01-01" },
    ];
    expect(
      isSuggestionDismissed(dismissed, "IGA", "fincat:alimentation.restaurants", "2026-01-02"),
    ).toBe(false);
  });

  it("does not suppress a different merchant for the same category", () => {
    const dismissed = [
      { merchantKey: "IGA", categoryId: "fincat:alimentation.epicerie", dismissedAt: "2026-01-01" },
    ];
    expect(
      isSuggestionDismissed(dismissed, "METRO", "fincat:alimentation.epicerie", "2026-01-02"),
    ).toBe(false);
  });

  it("suppresses a same-day dismissal even when dismissedAt carries a full ISO timestamp", () => {
    // A real `finance_category_suggestions.decided_at` is written via `nowIso()`
    // (a full UTC ISO timestamp), never a bare date. Comparing that instant
    // against a date-only "today" must not go negative and skip suppression.
    const dismissed = [
      {
        merchantKey: "IGA",
        categoryId: "fincat:alimentation.epicerie",
        dismissedAt: "2026-01-01T23:50:00.000Z",
      },
    ];
    expect(
      isSuggestionDismissed(dismissed, "IGA", "fincat:alimentation.epicerie", "2026-01-01"),
    ).toBe(true);
  });

  it("still suppresses within the 90-day window with a full ISO dismissedAt", () => {
    const dismissed = [
      {
        merchantKey: "IGA",
        categoryId: "fincat:alimentation.epicerie",
        dismissedAt: "2026-01-01T05:00:00.000Z",
      },
    ];
    expect(
      isSuggestionDismissed(dismissed, "IGA", "fincat:alimentation.epicerie", "2026-03-31"),
    ).toBe(true);
    expect(
      isSuggestionDismissed(dismissed, "IGA", "fincat:alimentation.epicerie", "2026-04-02"),
    ).toBe(false);
  });
});
