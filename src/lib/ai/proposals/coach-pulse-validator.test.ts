import type { CoachPulseResponse } from "../../../domain/types";
import { validateCoachPulseResponse, parseCoachPulseJson } from "./coach-pulse-validator";

const validOpen: CoachPulseResponse = {
  stance: "open",
  headline: "Cap clair",
  read: "La discipline tient.",
  move: { what: "Ecrire l'intention", why: "Ancrer le debut", horizon: "now" },
  intentionDraft: "Rester net"
};

const validClose: CoachPulseResponse = {
  stance: "close",
  headline: "Bilan",
  read: "Journee solide.",
  move: { what: "Choisir demain", why: "Refermer proprement", horizon: "tomorrow" },
  tomorrowFocusDraft: "Dormir tot"
};

describe("coach-pulse-validator", () => {
  it("accepts a valid open response", () => {
    expect(validateCoachPulseResponse(validOpen, "open")).toEqual({ ok: true, value: validOpen });
  });

  it("accepts a valid close response", () => {
    expect(validateCoachPulseResponse(validClose, "close")).toEqual({ ok: true, value: validClose });
  });

  it("rejects a close response missing tomorrowFocusDraft", () => {
    const { tomorrowFocusDraft: _removed, ...invalid } = validClose;
    expect(validateCoachPulseResponse(invalid, "close")).toEqual({
      ok: false,
      error: "tomorrowFocusDraft is required for close stance"
    });
  });

  it("rejects stance mismatches", () => {
    expect(validateCoachPulseResponse(validOpen, "close").ok).toBe(false);
  });

  it("parses JSON strings", () => {
    expect(parseCoachPulseJson(JSON.stringify(validOpen), "open")).toEqual({ ok: true, value: validOpen });
  });
});
