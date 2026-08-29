import { createEmptyDailyEntry, defaultAppSettings, updateNote } from "../../domain/daily-entry";
import { buildWeekDates } from "../../domain/weekly-review";
import { MemoryRepository } from "../storage/memory-repository";
import { buildWeeklySnapshot, type WeeklySnapshotInputs } from "./context/weekly-snapshot";
import { WeeklySynthesisService } from "./weekly-synthesis-service";
import type { AiProvider } from "./provider";

const buildWeeklyInputs = (weekStartDate = "2026-08-02"): WeeklySnapshotInputs => {
  const weekDates = ["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08"];
  const weekEntries = weekDates.map((date) => {
    let entry = createEmptyDailyEntry(date);
    entry = updateNote(entry, "morningIntention", `Intention ${date}`);
    return entry;
  });

  return {
    weekStartDate: buildWeekDates(weekStartDate),
    summary: {
      weekStartDate: buildWeekDates(weekStartDate),
      weekEndDate: "2026-08-08",
      sleepAverage: 80,
      sleepQuality: 80,
      trcDaysRespected: 5,
      respectTrc: (5 / 7) * 100,
      screenTimeTotalMinutes: 700,
      phoneScreenTime: 90,
      pomodorisTotal: 20,
      pomodoris: 70,
      disciplineAverage: 0.8,
      discipline: 80,
      tasksAddedTotal: 10,
      tasksCompletedTotal: 8,
      tasksCompletionRate: 80,
      calorieAverage: 3000,
      physicalActivity: 78,
      productivityPulse: null,
      rescueTimeGoalsScore: null,
      weeklyScore: 0.75,
      days: []
    },
    weekEntries,
    historyEntries: weekEntries,
    review: null,
    tasks: [],
    projects: [],
    pomodoroTaskSummaries: [],
    completedFocusSessionCount: 0,
    productivityPulse: null,
    rescueTimeGoalsScore: null,
    rescuetimeConfigured: false,
    now: "2026-08-08T12:00:00.000Z"
  };
};

describe("buildWeeklySnapshot redaction", () => {
  it("omits review notes below full scope", () => {
    const inputs = buildWeeklyInputs();
    inputs.review = {
      weekStartDate: inputs.weekStartDate,
      weekEndDate: inputs.summary.weekEndDate,
      status: "draft",
      notes: {
        bilan: "Notes libres",
        budget: "",
        tempsEtPlan: "",
        collecte: "",
        calendrier: "",
        gtd: "",
        alignement: "",
        dimanche: ""
      },
      ritualChecklist: {
        bilan: false,
        budget: false,
        tempsEtPlan: false,
        collecte: false,
        calendrier: false,
        gtd: false,
        alignement: false,
        dimanche: false
      },
      updatedAt: "2026-08-08T12:00:00.000Z"
    };

    const metricsSnapshot = buildWeeklySnapshot(inputs, "metrics");
    const fullSnapshot = buildWeeklySnapshot(inputs, "full");

    expect(metricsSnapshot.notes).toBeUndefined();
    expect(fullSnapshot.notes?.bilan).toBe("Notes libres");
  });
});

describe("WeeklySynthesisService", () => {
  it("returns local synthesis when AI is disabled", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn()
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new WeeklySynthesisService(provider);
    const settings = defaultAppSettings();

    const result = await service.buildSynthesis(repository, {
      weekStartDate: "2026-08-02",
      settings,
      snapshotInputs: buildWeeklyInputs(),
      trigger: "explicit"
    });

    expect(result.source).toBe("local");
    expect(result.synthesis.weakestAxes).toHaveLength(2);
    expect(provider.generateStructured).not.toHaveBeenCalled();
  });

  it("persists local proposals on auto trigger when AI is disabled", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn()
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new WeeklySynthesisService(provider);
    const settings = defaultAppSettings();
    const snapshotInputs = buildWeeklyInputs();

    const first = await service.buildSynthesis(repository, {
      weekStartDate: "2026-08-02",
      settings,
      snapshotInputs,
      trigger: "auto"
    });

    expect(first.source).toBe("local");
    const persisted = await repository.listAiProposals(first.message.id);
    expect(persisted.length).toBeGreaterThan(0);

    const second = await service.buildSynthesis(repository, {
      weekStartDate: "2026-08-02",
      settings,
      snapshotInputs,
      trigger: "auto"
    });

    expect(second.source).toBe("cache");
    expect(provider.generateStructured).not.toHaveBeenCalled();
  });

  it("uses cache on identical input hash", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          headline: "IA",
          scoreExplanation: "Score",
          strongestAxis: "Discipline",
          weakestAxes: ["Sommeil", "Pomodoris"],
          sectionDrafts: {},
          nextWeekObjectives: [],
          gtdActions: []
        }),
        model: "test-model",
        usage: { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 100 }
      }))
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new WeeklySynthesisService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";
    const snapshotInputs = buildWeeklyInputs();

    const first = await service.buildSynthesis(repository, {
      weekStartDate: "2026-08-02",
      settings,
      snapshotInputs,
      trigger: "explicit"
    });
    const second = await service.buildSynthesis(repository, {
      weekStartDate: "2026-08-02",
      settings,
      snapshotInputs,
      trigger: "explicit"
    });

    expect(first.source).toBe("ai");
    expect(second.source).toBe("cache");
    expect(provider.generateStructured).toHaveBeenCalledOnce();
  });
});
