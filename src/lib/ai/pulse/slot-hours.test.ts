import { DEFAULT_PULSE_SLOT_HOURS } from "./constants";
import { normalizeStoredSlotHours, parsePulseSlotHours } from "./slot-hours";

describe("slot-hours", () => {
  it("accepts three unique valid hours", () => {
    expect(parsePulseSlotHours("5, 13, 20")).toEqual({ ok: true, hours: [5, 13, 20] });
    expect(parsePulseSlotHours("20,5,13")).toEqual({ ok: true, hours: [5, 13, 20] });
  });

  it("rejects duplicates", () => {
    expect(parsePulseSlotHours("5, 5, 20")).toEqual({
      ok: false,
      error: "Les trois heures doivent etre uniques."
    });
  });

  it("rejects two values", () => {
    expect(parsePulseSlotHours("5, 13")).toEqual({
      ok: false,
      error: "Entrez exactement trois heures locales (open, steer, wind_down)."
    });
  });

  it("rejects four values", () => {
    expect(parsePulseSlotHours("5, 13, 20, 21")).toEqual({
      ok: false,
      error: "Entrez exactement trois heures locales (open, steer, wind_down)."
    });
  });

  it("rejects empty input", () => {
    expect(parsePulseSlotHours("")).toEqual({
      ok: false,
      error: "Entrez exactement trois heures (0–23), separees par des virgules."
    });
    expect(parsePulseSlotHours("   ")).toEqual({
      ok: false,
      error: "Entrez exactement trois heures (0–23), separees par des virgules."
    });
  });

  it("rejects out-of-range hours", () => {
    expect(parsePulseSlotHours("5, 13, 24")).toEqual({
      ok: false,
      error: "Heure invalide : « 24 » (0–23 attendu)."
    });
    expect(parsePulseSlotHours("5, -1, 20")).toEqual({
      ok: false,
      error: "Heure invalide : « -1 » (0–23 attendu)."
    });
  });

  it("caps stored hours at three unique sorted values", () => {
    expect(normalizeStoredSlotHours([5, 13, 20, 21])).toEqual([5, 13, 20]);
    expect(normalizeStoredSlotHours([])).toEqual([...DEFAULT_PULSE_SLOT_HOURS]);
  });
});
