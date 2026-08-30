import { buildLocalCoachPulse, hasMeaningfulEvidence, pickTopFinding } from "./coach-pulse-fallback";
import type { Finding } from "../../../domain/insights/types";

const zeroSampleFinding = (label: string): Finding => ({
  id: "finding:test",
  severity: "info",
  evidenceWindow: { from: "2026-08-01", to: "2026-08-29", days: 29 },
  sampleSize: 0,
  value: 0,
  label
});

describe("coach-pulse-fallback", () => {
  it("ignores findings without meaningful sample sizes", () => {
    expect(hasMeaningfulEvidence(zeroSampleFinding("priereDuMatin"))).toBe(false);
    expect(pickTopFinding([zeroSampleFinding("priereDuMatin")])).toBeNull();
  });

  it("uses the no-signal copy when only zero-sample findings exist", () => {
    const pulse = buildLocalCoachPulse("open", [zeroSampleFinding("priereDuMatin")]);
    expect(pulse.read).toContain("Pas assez de signal");
    expect(pulse.intentionDraft).toBeUndefined();
  });
});
