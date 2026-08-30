import { resolvePulseSlots, buildPulseScopeKey } from "./slot-resolution";

describe("slot-resolution", () => {
  const date = "2026-08-29";

  it("anchors the open slot to first app open when later than configured hour", () => {
    const result = resolvePulseSlots({
      date,
      nowIso: "2026-08-29T10:30:00",
      slotHours: [5, 13, 20],
      firstOpenAtIso: "2026-08-29T10:00:00",
      processedScopeKeys: new Set()
    });

    expect(result.dueSlot).toEqual({
      stance: "open",
      hour: 5,
      scopeKey: date
    });
    expect(result.missedSlots).toEqual([]);
  });

  it("coalesces at 16:00 to a single steer pulse and marks open as missed", () => {
    const result = resolvePulseSlots({
      date,
      nowIso: "2026-08-29T16:00:00",
      slotHours: [5, 13, 20],
      firstOpenAtIso: "2026-08-29T16:00:00",
      processedScopeKeys: new Set()
    });

    expect(result.dueSlot).toEqual({
      stance: "steer",
      hour: 13,
      scopeKey: `${date}#13`
    });
    expect(result.missedSlots).toEqual([
      {
        stance: "open",
        hour: 5,
        scopeKey: date
      }
    ]);
  });

  it("returns no due slot before first open is recorded", () => {
    const result = resolvePulseSlots({
      date,
      nowIso: "2026-08-29T08:00:00",
      slotHours: [5, 13, 20],
      firstOpenAtIso: null,
      processedScopeKeys: new Set()
    });

    expect(result.dueSlot).toBeNull();
  });

  it("builds hour-based scope keys for steer and wind_down", () => {
    expect(buildPulseScopeKey(date, "open", 5)).toBe(date);
    expect(buildPulseScopeKey(date, "steer", 13)).toBe(`${date}#13`);
    expect(buildPulseScopeKey(date, "wind_down", 20)).toBe(`${date}#20`);
  });

  it("uses only the first three unique stored hours when more are persisted", () => {
    const result = resolvePulseSlots({
      date,
      nowIso: "2026-08-29T21:00:00",
      slotHours: [5, 13, 20, 21],
      firstOpenAtIso: "2026-08-29T06:00:00",
      processedScopeKeys: new Set([date, `${date}#13`])
    });

    expect(result.dueSlot).toEqual({
      stance: "wind_down",
      hour: 20,
      scopeKey: `${date}#20`
    });
    expect(result.missedSlots).toEqual([]);
  });
});
