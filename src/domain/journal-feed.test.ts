import { createEmptyDailyEntry, updateNote } from "./daily-entry";
import { buildJournalFeed, journalPeriodOverlaps, resolveJournalDateRange } from "./journal-feed";
import { createEmptyMonthlyReview, updateMonthlyReviewNote } from "./monthly-review";
import { createEmptyWeeklyReview, updateWeeklyReviewNote } from "./weekly-review";

describe("resolveJournalDateRange", () => {
  it("resolves this week as Sunday through Saturday around a midweek date", () => {
    expect(resolveJournalDateRange("thisWeek", "2026-04-01")).toEqual({
      startDate: "2026-03-29",
      endDate: "2026-04-04",
    });
  });

  it("resolves last week as the previous Sunday through Saturday", () => {
    expect(resolveJournalDateRange("lastWeek", "2026-04-01")).toEqual({
      startDate: "2026-03-22",
      endDate: "2026-03-28",
    });
  });

  it("resolves this month as the calendar month of today", () => {
    expect(resolveJournalDateRange("thisMonth", "2026-04-01")).toEqual({
      startDate: "2026-04-01",
      endDate: "2026-04-30",
    });
  });

  it("resolves last month as the previous calendar month", () => {
    expect(resolveJournalDateRange("lastMonth", "2026-04-01")).toEqual({
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });
  });

  it("uses inclusive custom dates and swaps them when start is after end", () => {
    expect(
      resolveJournalDateRange("custom", "2026-04-01", {
        startDate: "2026-04-10",
        endDate: "2026-04-02",
      }),
    ).toEqual({
      startDate: "2026-04-02",
      endDate: "2026-04-10",
    });
  });
});

describe("journalPeriodOverlaps", () => {
  it("includes a week that started in the previous month", () => {
    expect(journalPeriodOverlaps("2026-03-29", "2026-04-04", "2026-04-01", "2026-04-30")).toBe(
      true,
    );
  });

  it("excludes a week entirely before the range", () => {
    expect(journalPeriodOverlaps("2026-03-22", "2026-03-28", "2026-04-01", "2026-04-30")).toBe(
      false,
    );
  });
});

describe("buildJournalFeed", () => {
  const aprilRange = { startDate: "2026-04-01", endDate: "2026-04-30" };

  it("omits periods whose notes are empty or whitespace-only", () => {
    const emptyDaily = createEmptyDailyEntry("2026-04-02");
    const whitespaceDaily = updateNote(
      createEmptyDailyEntry("2026-04-03"),
      "morningIntention",
      "  ",
    );
    const filledDaily = updateNote(
      createEmptyDailyEntry("2026-04-04"),
      "nightReflection",
      "Une vraie note",
    );

    const feed = buildJournalFeed({
      dailyEntries: [emptyDaily, whitespaceDaily, filledDaily],
      weeklyReviews: [createEmptyWeeklyReview("2026-03-29")],
      monthlyReviews: [createEmptyMonthlyReview("2026-04")],
      range: aprilRange,
      kind: "all",
      sort: "olderFirst",
    });

    expect(feed.map((item) => item.id)).toEqual(["2026-04-04"]);
    expect(feed[0]?.fields).toEqual([{ key: "nightReflection", text: "Une vraie note" }]);
  });

  it("keeps ritual field order and skips blank keys on weekly and monthly cards", () => {
    let weekly = createEmptyWeeklyReview("2026-03-29");
    weekly = updateWeeklyReviewNote(weekly, "gtd", "Next actions claires");
    weekly = updateWeeklyReviewNote(weekly, "bilan", "Semaine dense");

    let monthly = createEmptyMonthlyReview("2026-04");
    monthly = updateMonthlyReviewNote(monthly, "developpement", "Lire");
    monthly = updateMonthlyReviewNote(monthly, "bilan", "Mois ouvert");

    const feed = buildJournalFeed({
      dailyEntries: [],
      weeklyReviews: [weekly],
      monthlyReviews: [monthly],
      range: aprilRange,
      kind: "all",
      sort: "olderFirst",
    });

    expect(feed).toHaveLength(2);
    expect(feed[0]?.kind).toBe("weekly");
    expect(feed[0]?.fields.map((field) => field.key)).toEqual(["bilan", "gtd"]);
    expect(feed[1]?.kind).toBe("monthly");
    expect(feed[1]?.fields.map((field) => field.key)).toEqual(["bilan", "developpement"]);
  });

  it("filters by kind and builds edit hrefs", () => {
    const daily = updateNote(createEmptyDailyEntry("2026-04-02"), "morningIntention", "Focus");
    let weekly = createEmptyWeeklyReview("2026-03-29");
    weekly = updateWeeklyReviewNote(weekly, "bilan", "Bilan");
    let monthly = createEmptyMonthlyReview("2026-04");
    monthly = updateMonthlyReviewNote(monthly, "bilan", "Mois");

    const dailyOnly = buildJournalFeed({
      dailyEntries: [daily],
      weeklyReviews: [weekly],
      monthlyReviews: [monthly],
      range: aprilRange,
      kind: "daily",
      sort: "olderFirst",
    });

    expect(dailyOnly).toHaveLength(1);
    expect(dailyOnly[0]).toMatchObject({
      kind: "daily",
      href: "/historique?date=2026-04-02",
    });
  });

  it("sorts older first by period date then daily, weekly, monthly", () => {
    const daily = updateNote(createEmptyDailyEntry("2026-04-01"), "tomorrowFocus", "Demain");
    let weekly = createEmptyWeeklyReview("2026-03-29");
    weekly = updateWeeklyReviewNote(weekly, "bilan", "Semaine");
    let monthly = createEmptyMonthlyReview("2026-04");
    monthly = updateMonthlyReviewNote(monthly, "bilan", "Mois");

    const olderFirst = buildJournalFeed({
      dailyEntries: [daily],
      weeklyReviews: [weekly],
      monthlyReviews: [monthly],
      range: aprilRange,
      kind: "all",
      sort: "olderFirst",
    });

    expect(olderFirst.map((item) => item.kind)).toEqual(["weekly", "daily", "monthly"]);

    const newerFirst = buildJournalFeed({
      dailyEntries: [daily],
      weeklyReviews: [weekly],
      monthlyReviews: [monthly],
      range: aprilRange,
      kind: "all",
      sort: "newerFirst",
    });

    expect(newerFirst.map((item) => item.kind)).toEqual(["monthly", "daily", "weekly"]);
  });

  it("includes a weekly review that overlaps the selected month", () => {
    let weekly = createEmptyWeeklyReview("2026-03-29");
    weekly = updateWeeklyReviewNote(weekly, "bilan", "Chevauche avril");

    const feed = buildJournalFeed({
      dailyEntries: [],
      weeklyReviews: [weekly],
      monthlyReviews: [],
      range: aprilRange,
      kind: "all",
      sort: "olderFirst",
    });

    expect(feed[0]).toMatchObject({
      kind: "weekly",
      id: "2026-03-29",
      href: "/semaine?date=2026-03-29",
    });
  });
});
