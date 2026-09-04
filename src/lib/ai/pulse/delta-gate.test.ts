import { classifyPulseWindow, computeMaxContinuousOpenMs } from "./delta-gate";

describe("delta-gate", () => {
  const baseInput = {
    sinceIso: "2026-08-29T08:00:00.000Z",
    nowIso: "2026-08-29T13:00:00.000Z",
    focusSessions: [],
    tasks: [],
    appOpenIntervals: [] as Array<{ startedAt: string; endedAt: string }>,
    dayOfWeek: 5,
  };

  it("classifies movement as progress", () => {
    const result = classifyPulseWindow({
      ...baseInput,
      focusSessions: [
        {
          id: "p1",
          kind: "focus",
          status: "completed",
          startedAt: "2026-08-29T09:00:00.000Z",
          completedAt: "2026-08-29T09:25:00.000Z",
          endsAt: "2026-08-29T09:25:00.000Z",
          pausedRemainingMs: null,
          cancelledAt: null,
          date: "2026-08-29",
          cycleIndex: 1,
          segments: [],
          activeTaskId: null,
          activeLabel: null,
          taskIds: [],
        },
      ],
    });

    expect(result.deltaClass).toBe("progress");
  });

  it("classifies sustained open without movement as stall on weekdays", () => {
    const result = classifyPulseWindow({
      ...baseInput,
      appOpenIntervals: [
        {
          startedAt: "2026-08-29T08:00:00.000Z",
          endedAt: "2026-08-29T13:00:00.000Z",
        },
      ],
    });

    expect(result.deltaClass).toBe("stall");
  });

  it("classifies short open without movement as unknown", () => {
    const result = classifyPulseWindow({
      ...baseInput,
      nowIso: "2026-08-29T08:20:00.000Z",
      appOpenIntervals: [
        {
          startedAt: "2026-08-29T08:00:00.000Z",
          endedAt: "2026-08-29T08:20:00.000Z",
        },
      ],
    });

    expect(result.deltaClass).toBe("unknown");
  });

  it("downgrades weekend no-movement to idle", () => {
    const result = classifyPulseWindow({
      ...baseInput,
      dayOfWeek: 6,
      appOpenIntervals: [
        {
          startedAt: "2026-08-29T08:00:00.000Z",
          endedAt: "2026-08-29T13:00:00.000Z",
        },
      ],
    });

    expect(result.deltaClass).toBe("idle");
  });

  it("classifies no app open as idle", () => {
    expect(classifyPulseWindow(baseInput).deltaClass).toBe("idle");
  });

  it("computes max continuous open duration", () => {
    const maxMs = computeMaxContinuousOpenMs(
      "2026-08-29T08:00:00.000Z",
      "2026-08-29T13:00:00.000Z",
      [
        { startedAt: "2026-08-29T08:00:00.000Z", endedAt: "2026-08-29T09:00:00.000Z" },
        { startedAt: "2026-08-29T09:30:00.000Z", endedAt: "2026-08-29T11:00:00.000Z" },
      ],
    );

    expect(maxMs).toBe(90 * 60 * 1000);
  });
});
