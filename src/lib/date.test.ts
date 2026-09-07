import { afterEach, vi } from "vitest";
import {
  buildIsoFromLocalDateAndTime,
  isPastLocalDate,
  stableAiNowIso,
  toLocalDateInputValue,
  toLocalTimeInputValue,
} from "./date";

describe("date helpers", () => {
  it("round-trips a local scheduled date and time", () => {
    const iso = buildIsoFromLocalDateAndTime("2026-04-03", "14:45");

    expect(toLocalDateInputValue(iso)).toBe("2026-04-03");
    expect(toLocalTimeInputValue(iso)).toBe("14:45");
  });

  it("keeps the previous time when only the date changes", () => {
    const fallbackIso = "2026-04-03T18:20:00.000Z";
    const nextIso = buildIsoFromLocalDateAndTime("2026-04-05", "", fallbackIso);

    expect(toLocalDateInputValue(nextIso)).toBe("2026-04-05");
    expect(toLocalTimeInputValue(nextIso)).toBe(toLocalTimeInputValue(fallbackIso));
  });
});

describe("stableAiNowIso", () => {
  it("pins the clock to local noon for the given calendar date", () => {
    expect(stableAiNowIso("2026-08-08")).toBe("2026-08-08T12:00:00");
  });
});

describe("isPastLocalDate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false for null", () => {
    expect(isPastLocalDate(null)).toBe(false);
  });

  it("is false for today's and future local dates, true only for a date strictly before today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));

    expect(isPastLocalDate(new Date(2026, 5, 14, 23, 59, 0).toISOString())).toBe(true);
    expect(isPastLocalDate(new Date(2026, 5, 15, 0, 5, 0).toISOString())).toBe(false);
    expect(isPastLocalDate(new Date(2026, 5, 16, 0, 5, 0).toISOString())).toBe(false);
  });
});
