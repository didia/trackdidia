import { buildIsoFromLocalDateAndTime, toLocalDateInputValue, toLocalTimeInputValue } from "./date";

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
