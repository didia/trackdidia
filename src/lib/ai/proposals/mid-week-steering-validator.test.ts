import { describe, expect, it } from "vitest";
import { validateMidWeekSteeringResponse } from "./mid-week-steering-validator";

const action = (signalKey: string) => ({
  signalKey,
  title: "Deux blocs de focus",
  why: "En retard",
  effort: "medium",
});
const payload = (actions: unknown[]) => ({
  headline: "Semaine à rattraper",
  read: "Le focus est en retard.",
  focusShift: "Réserver du temps",
  actions,
});

describe("validateMidWeekSteeringResponse", () => {
  const actionable = ["metric:pomodoris", "rescuetime:7"];

  it("accepts distinct actionable keys", () => {
    expect(
      validateMidWeekSteeringResponse(
        payload([action("metric:pomodoris"), action("rescuetime:7")]),
        actionable,
      ).ok,
    ).toBe(true);
  });

  it("rejects a green, unknown or absent key", () => {
    // "principle:respectTrc" is not in actionableKeys: it is green, unknown or absent.
    expect(
      validateMidWeekSteeringResponse(payload([action("principle:respectTrc")]), actionable).ok,
    ).toBe(false);
    expect(validateMidWeekSteeringResponse(payload([action("nope")]), actionable).ok).toBe(false);
  });

  it("rejects a repeated key", () => {
    expect(
      validateMidWeekSteeringResponse(
        payload([action("metric:pomodoris"), action("metric:pomodoris")]),
        actionable,
      ).ok,
    ).toBe(false);
  });

  it("accepts only an empty actions array when nothing is actionable", () => {
    expect(validateMidWeekSteeringResponse(payload([]), []).ok).toBe(true);
    expect(validateMidWeekSteeringResponse(payload([action("metric:pomodoris")]), []).ok).toBe(
      false,
    );
  });

  it("rejects an invalid effort or missing fields", () => {
    expect(
      validateMidWeekSteeringResponse(
        payload([{ ...action("metric:pomodoris"), effort: "extreme" }]),
        actionable,
      ).ok,
    ).toBe(false);
    expect(validateMidWeekSteeringResponse({ headline: "x", actions: [] }, []).ok).toBe(false);
  });

  it("skips the key check when no actionable keys are given (stored rows)", () => {
    expect(validateMidWeekSteeringResponse(payload([action("anything")])).ok).toBe(true);
  });
});
