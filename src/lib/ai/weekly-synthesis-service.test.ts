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

  it("allocates a fresh message id when bypassing cache after an ok result", async () => {
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
    const regenerated = await service.buildSynthesis(repository, {
      weekStartDate: "2026-08-02",
      settings,
      snapshotInputs,
      trigger: "explicit",
      bypassCache: true
    });

    expect(regenerated.message.id).not.toBe(first.message.id);
    const episodes = await repository.listAiMessages("weekly_synthesis");
    expect(episodes.some((message) => message.id === first.message.id)).toBe(true);
    expect(episodes.some((message) => message.id === regenerated.message.id)).toBe(true);
  });

  it("retries after a persisted fallback instead of treating it as cache", async () => {
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
        usage: { tokensPrompt: 1, tokensCompletion: 2, latencyMs: 3 }
      }))
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new WeeklySynthesisService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";
    const snapshotInputs = buildWeeklyInputs();

    await repository.saveAiMessage({
      id: "ai-message:fallback",
      surface: "weekly_synthesis",
      scopeKey: "2026-08-02",
      stance: null,
      kind: "weekly",
      inputHash: "ignored",
      promptVersion: "weekly_synthesis.v1",
      model: "test-model",
      status: "fallback",
      bodyJson: JSON.stringify({
        headline: "Fallback",
        scoreExplanation: "Local",
        strongestAxis: "Discipline",
        weakestAxes: ["Sommeil", "Pomodoris"],
        sectionDrafts: { bilan: "Old" },
        nextWeekObjectives: [],
        gtdActions: []
      }),
      bodyText: "Fallback",
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt: "2026-08-08T12:00:00.000Z"
    });

    const result = await service.buildSynthesis(repository, {
      weekStartDate: "2026-08-02",
      settings,
      snapshotInputs,
      trigger: "auto"
    });

    expect(result.source).toBe("ai");
    expect(provider.generateStructured).toHaveBeenCalledOnce();
  });

  it("persists multiple section drafts through saveCoachPulseEpisode", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn()
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new WeeklySynthesisService(provider);
    const settings = defaultAppSettings();
    const snapshotInputs = buildWeeklyInputs();

    const result = await service.buildSynthesis(repository, {
      weekStartDate: "2026-08-02",
      settings,
      snapshotInputs,
      trigger: "auto"
    });

    const sectionDrafts = result.proposals.filter((proposal) => proposal.type === "review_section_draft");
    expect(sectionDrafts.length).toBeGreaterThanOrEqual(2);
  });
});
