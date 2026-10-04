import {
  addDays,
  addMonths,
  buildIsoFromLocalDateAndTime,
  clampAiAsOfDate,
  getDayRange,
  getWeekStartSunday,
  isPastLocalDate,
  isSunday,
  msUntilNextLocalMidnight,
  stableAiNowIso,
  toLocalDateInputValue,
  toLocalDateString,
  toLocalTimeInputValue,
  toMonthKey,
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

describe("clampAiAsOfDate", () => {
  it("keeps today while the period is still open", () => {
    expect(clampAiAsOfDate("2026-08-05", "2026-08-08")).toBe("2026-08-05");
  });

  it("freezes at the period end after it closes", () => {
    expect(clampAiAsOfDate("2026-08-09", "2026-08-08")).toBe("2026-08-08");
    expect(clampAiAsOfDate("2026-05-01", "2026-04-30")).toBe("2026-04-30");
    expect(clampAiAsOfDate("2027-01-02", "2026-12-31")).toBe("2026-12-31");
  });
});

describe("msUntilNextLocalMidnight", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is the remaining local time until the next calendar day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 7, 23, 59, 0, 0));

    expect(msUntilNextLocalMidnight()).toBe(60_000);
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

const originalTimeZone = process.env.TZ;

afterEach(() => {
  if (originalTimeZone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimeZone;
  }
});

describe("local calendar helpers", () => {
  it("matches the former local-noon day increment across a full year", () => {
    for (const timeZone of ["America/Toronto", "Pacific/Kiritimati", "Etc/GMT+12"]) {
      process.env.TZ = timeZone;
      for (let day = 0; day < 365; day += 1) {
        const current = new Date(2026, 0, day + 1, 12);
        const date = toLocalDateString(current);
        const oldNext = new Date(`${date}T12:00:00`);
        oldNext.setDate(oldNext.getDate() + 1);
        expect(addDays(date, 1)).toBe(toLocalDateString(oldNext));
      }
    }
  });

  it("uses local dates at extreme UTC offsets and across year boundaries", () => {
    process.env.TZ = "Pacific/Kiritimati";
    expect(toLocalDateString("2026-01-01T10:30:00.000Z")).toBe("2026-01-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(getWeekStartSunday("2027-01-01")).toBe("2026-12-27");
    expect(isSunday("2026-12-27")).toBe(true);

    process.env.TZ = "Etc/GMT+12";
    expect(toLocalDateString("2026-01-01T10:30:00.000Z")).toBe("2025-12-31");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(toMonthKey("2026-08-15")).toBe("2026-08");
  });

  it("keeps midnight day ranges at 23 and 25 hours through DST", () => {
    process.env.TZ = "America/Toronto";
    const spring = getDayRange("2026-03-08");
    const fall = getDayRange("2026-11-01");
    expect(spring.endMs - spring.startMs).toBe(23 * 60 * 60 * 1000);
    expect(fall.endMs - fall.startMs).toBe(25 * 60 * 60 * 1000);
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
  });
});
