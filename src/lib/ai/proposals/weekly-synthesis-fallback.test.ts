import type { WeeklySnapshot } from "../context/weekly-snapshot";
import { buildLocalWeeklySynthesis } from "./weekly-synthesis-fallback";

const baseSnapshot: WeeklySnapshot = {
  surface: "weekly",
  scope: "full",
  weekStartDate: "2026-08-02",
  weekEndDate: "2026-08-08",
  reviewStatus: "draft",
  weeklyScore: 0.7,
  axes: [
    { key: "sleepQuality", label: "Sommeil", score: 80 },
    { key: "discipline", label: "Discipline", score: 70 },
  ],
  metrics: [],
  principles: [],
  gtd: {
    inboxBacklog: 0,
    projectsWithoutNextAction: 0,
    projectsWithoutNextActionSample: [],
    staleNextActions: 1,
    staleNextActionsSample: [{ id: "task-1", title: "Relancer le fournisseur" }],
    agingWaitingFor: 0,
    overdueDeadlines: 0,
    scheduledVsCompletedRatio: 0,
  },
  focus: {
    completedFocusSessionCount: 0,
    totalFocusMinutes: 0,
    taskConcentration: null,
    topTask: null,
    productivityPulse: null,
    rescueTimeConfigured: false,
  },
  rescueTimeGoals: [],
  findings: [],
};

describe("buildLocalWeeklySynthesis", () => {
  it("names the stale task in the fallback gtdAction", () => {
    const synthesis = buildLocalWeeklySynthesis(baseSnapshot);

    expect(synthesis.gtdActions).toEqual([
      expect.objectContaining({ taskId: "task-1", taskTitle: "Relancer le fournisseur" }),
    ]);
  });

  it("mentions a poorly achieved RescueTime goal in the tempsEtPlan draft", () => {
    const snapshot: WeeklySnapshot = {
      ...baseSnapshot,
      gtd: { ...baseSnapshot.gtd, staleNextActions: 0, staleNextActionsSample: [] },
      rescueTimeGoals: [
        {
          title: "Deep work",
          isMore: true,
          actualHours: 3,
          weeklyTargetHours: 10,
          achievement: 0.3,
        },
      ],
    };

    const synthesis = buildLocalWeeklySynthesis(snapshot);

    expect(synthesis.sectionDrafts.tempsEtPlan).toContain("Deep work");
    expect(synthesis.sectionDrafts.tempsEtPlan).toContain("30%");
  });

  it("does not mention RescueTime goals that were fully achieved", () => {
    const snapshot: WeeklySnapshot = {
      ...baseSnapshot,
      gtd: { ...baseSnapshot.gtd, staleNextActions: 0, staleNextActionsSample: [] },
      rescueTimeGoals: [
        {
          title: "Deep work",
          isMore: true,
          actualHours: 12,
          weeklyTargetHours: 10,
          achievement: 1,
        },
      ],
    };

    const synthesis = buildLocalWeeklySynthesis(snapshot);

    expect(synthesis.sectionDrafts.tempsEtPlan ?? "").not.toContain("Deep work");
  });
});
