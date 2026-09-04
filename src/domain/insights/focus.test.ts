import type { PomodoroTaskSummary } from "../types";
import { computeFocusFindings } from "./focus";

const now = "2026-02-01T12:00:00.000Z";

const summaries: PomodoroTaskSummary[] = [
  { taskId: "t1", taskTitle: "A", totalSeconds: 1800, sessionCount: 3 },
  { taskId: "t2", taskTitle: "B", totalSeconds: 600, sessionCount: 1 },
];

describe("focus insight module", () => {
  it("reports pomodoro totals", () => {
    const findings = computeFocusFindings(summaries, 4, now);
    const finding = findings.find((item) => item.kind === "focus_totals");

    expect(finding?.value).toBe(4);
    expect(finding?.sampleSize).toBe(4);
  });

  it("reports task concentration as the share of focus time in the top task", () => {
    const findings = computeFocusFindings(summaries, 4, now);
    const finding = findings.find((item) => item.kind === "task_concentration");

    expect(finding?.value).toBeCloseTo(0.75);
    expect(finding?.severity).toBe("positive");
  });

  it("omits task concentration when there is no focus time at all", () => {
    const findings = computeFocusFindings([], 0, now);

    expect(findings.find((item) => item.kind === "task_concentration")).toBeUndefined();
  });

  it("classifies focus/pulse alignment as aligned_high when both are strong", () => {
    const findings = computeFocusFindings(summaries, 5, now, 80);
    const finding = findings.find((item) => item.kind === "focus_pulse_alignment");

    expect(finding?.alignment).toBe("aligned_high");
    expect(finding?.severity).toBe("positive");
  });

  it("classifies focus/pulse alignment as aligned_low when both are weak", () => {
    const findings = computeFocusFindings(summaries, 1, now, 10);
    const finding = findings.find((item) => item.kind === "focus_pulse_alignment");

    expect(finding?.alignment).toBe("aligned_low");
    expect(finding?.severity).toBe("watch");
  });

  it("classifies a divergence between focus and RescueTime pulse", () => {
    const findings = computeFocusFindings(summaries, 8, now, 10);
    const finding = findings.find((item) => item.kind === "focus_pulse_alignment");

    expect(finding?.alignment).toBe("focus_high_pulse_low");
  });

  it("omits the alignment finding when RescueTime is not configured", () => {
    const findings = computeFocusFindings(summaries, 4, now, null);

    expect(findings.find((item) => item.kind === "focus_pulse_alignment")).toBeUndefined();
  });

  it("labels the pulse-alignment finding as an approximate, mismatched-period comparison", () => {
    const findings = computeFocusFindings(summaries, 5, now, 80);
    const finding = findings.find((item) => item.kind === "focus_pulse_alignment");

    expect(finding?.label).toContain("périodes différentes");
    expect(finding?.label).toContain("semaine en cours");
  });
});
