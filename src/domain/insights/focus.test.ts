import type { PomodoroTaskSummary } from "../types";
import { computeFocusFindings } from "./focus";

const now = "2026-02-01T12:00:00.000Z";

const summaries: PomodoroTaskSummary[] = [
  { taskId: "t1", taskTitle: "A", projectId: null, totalSeconds: 1800, sessionCount: 3 },
  { taskId: "t2", taskTitle: "B", projectId: null, totalSeconds: 600, sessionCount: 1 },
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

  it("does not report dispersion when many tasks share the same project", () => {
    const sameProjectSummaries: PomodoroTaskSummary[] = Array.from({ length: 10 }, (_, index) => ({
      taskId: `p-task-${index}`,
      taskTitle: `Tache ${index}`,
      projectId: "project-1",
      totalSeconds: 300,
      sessionCount: 1,
    }));

    const findings = computeFocusFindings(sameProjectSummaries, 10, now);
    const finding = findings.find((item) => item.kind === "task_concentration");

    expect(finding?.value).toBeCloseTo(1);
    expect(finding?.taskCount).toBe(10);
    expect(finding?.projectId).toBe("project-1");
    expect(finding?.severity).toBe("positive");
    expect(finding?.label).toContain("même projet");
  });

  it("still reports dispersion when tasks belong to different (or no) projects", () => {
    const scatteredSummaries: PomodoroTaskSummary[] = [
      { taskId: "a", taskTitle: "A", projectId: "project-1", totalSeconds: 300, sessionCount: 1 },
      { taskId: "b", taskTitle: "B", projectId: "project-2", totalSeconds: 300, sessionCount: 1 },
      { taskId: "c", taskTitle: "C", projectId: null, totalSeconds: 300, sessionCount: 1 },
    ];

    const findings = computeFocusFindings(scatteredSummaries, 3, now);
    const finding = findings.find((item) => item.kind === "task_concentration");

    expect(finding?.value).toBeCloseTo(1 / 3);
    expect(finding?.taskCount).toBe(1);
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
