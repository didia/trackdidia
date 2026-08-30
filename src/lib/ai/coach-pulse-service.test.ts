import { createEmptyDailyEntry, defaultAppSettings } from "../../domain/daily-entry";
import type { CoachPulseResponse } from "../../domain/types";
import { MemoryRepository } from "../storage/memory-repository";
import { CoachPulseService } from "./coach-pulse-service";
import type { DailySnapshotInputs } from "./context/daily-snapshot";
import type { AiProvider } from "./provider";

const buildSnapshotInputs = (entry = createEmptyDailyEntry("2026-08-29")): DailySnapshotInputs => ({
  date: entry.date,
  entry,
  historyEntries: [entry],
  tasks: [],
  projects: [],
  pomodoroTaskSummaries: [],
  completedFocusSessionCount: 0,
  productivityPulseWeekToDate: null,
  rescuetimeConfigured: false,
  now: "2026-08-29T12:00:00.000Z"
});

describe("CoachPulseService", () => {
  it("returns local guidance when AI is disabled", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn()
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new CoachPulseService(provider);
    const settings = defaultAppSettings();

    const result = await service.buildPulse(repository, {
      stance: "open",
      entry: createEmptyDailyEntry("2026-08-29"),
      settings,
      snapshotInputs: buildSnapshotInputs(),
      trigger: "explicit"
    });

    expect(result.source).toBe("local");
    expect(provider.generateStructured).not.toHaveBeenCalled();
  });

  it("uses cache on identical input hash", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          stance: "open",
          headline: "IA",
          read: "Signal",
          move: null
        }),
        model: "test-model",
        usage: { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 100 }
      }))
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new CoachPulseService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";
    const entry = createEmptyDailyEntry("2026-08-29");
    const snapshotInputs = buildSnapshotInputs(entry);

    const first = await service.buildPulse(repository, {
      stance: "open",
      entry,
      settings,
      snapshotInputs,
      trigger: "explicit"
    });
    const second = await service.buildPulse(repository, {
      stance: "open",
      entry,
      settings,
      snapshotInputs,
      trigger: "explicit"
    });

    expect(first.source).toBe("ai");
    expect(second.source).toBe("cache");
    expect(provider.generateStructured).toHaveBeenCalledOnce();
  });

  it("falls back when validation fails after repair", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({ headline: "bad" }),
        model: "test-model",
        usage: { tokensPrompt: 1, tokensCompletion: 1, latencyMs: 1 }
      }))
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new CoachPulseService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";

    const result = await service.buildPulse(repository, {
      stance: "open",
      entry: createEmptyDailyEntry("2026-08-29"),
      settings,
      snapshotInputs: buildSnapshotInputs(),
      trigger: "explicit"
    });

    expect(result.source).toBe("fallback");
    expect(provider.generateStructured).toHaveBeenCalledTimes(2);
  });

  it("calls the provider on auto trigger when AI is configured", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          stance: "open",
          headline: "IA",
          read: "Signal",
          move: null
        }),
        model: "test-model",
        usage: { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 100 }
      }))
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new CoachPulseService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";

    const result = await service.buildPulse(repository, {
      stance: "open",
      entry: createEmptyDailyEntry("2026-08-29"),
      settings,
      snapshotInputs: buildSnapshotInputs(),
      trigger: "auto"
    });

    expect(result.source).toBe("ai");
    expect(provider.generateStructured).toHaveBeenCalledOnce();
  });

  it("returns ephemeral local auto results without proposals", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn()
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new CoachPulseService(provider);
    const settings = defaultAppSettings();

    const result = await service.buildPulse(repository, {
      stance: "open",
      entry: createEmptyDailyEntry("2026-08-29"),
      settings,
      snapshotInputs: buildSnapshotInputs(),
      trigger: "auto",
      localOnly: true
    });

    expect(result.source).toBe("local");
    expect(result.proposals).toEqual([]);
    expect(provider.generateStructured).not.toHaveBeenCalled();
  });

  it("appends a new message id on bypassCache regenerate", async () => {
    const provider: AiProvider = {
      generateStructured: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            stance: "open",
            headline: "Premier",
            read: "Signal initial",
            move: null,
            intentionDraft: "Focus initial"
          }),
          model: "test-model",
          usage: { tokensPrompt: 5, tokensCompletion: 10, latencyMs: 50 }
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({
            stance: "open",
            headline: "Regenere",
            read: "Signal regenere",
            move: null,
            intentionDraft: "Focus regenere"
          }),
          model: "test-model",
          usage: { tokensPrompt: 6, tokensCompletion: 11, latencyMs: 60 }
        })
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new CoachPulseService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";
    const entry = createEmptyDailyEntry("2026-08-29");
    const snapshotInputs = buildSnapshotInputs(entry);

    const first = await service.buildPulse(repository, {
      stance: "open",
      entry,
      settings,
      snapshotInputs,
      trigger: "explicit"
    });
    const regenerated = await service.buildPulse(repository, {
      stance: "open",
      entry,
      settings,
      snapshotInputs,
      trigger: "explicit",
      bypassCache: true
    });

    expect(regenerated.message.id).not.toBe(first.message.id);
    expect(regenerated.proposals).toHaveLength(1);
    expect(regenerated.proposals[0].messageId).toBe(regenerated.message.id);
    expect(JSON.parse(regenerated.proposals[0].payloadJson)).toEqual({ text: "Focus regenere" });
    await expect(repository.listAiProposals(first.message.id)).resolves.toHaveLength(1);
    await expect(repository.listAiProposals(regenerated.message.id)).resolves.toHaveLength(1);
    expect(provider.generateStructured).toHaveBeenCalledTimes(2);
  });

  it("reuses cache after a proposal is accepted", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          stance: "open",
          headline: "IA",
          read: "Signal",
          move: null,
          intentionDraft: "Focus"
        }),
        model: "test-model",
        usage: { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 100 }
      }))
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new CoachPulseService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";
    const entry = createEmptyDailyEntry("2026-08-29");
    const snapshotInputs = buildSnapshotInputs(entry);

    const first = await service.buildPulse(repository, {
      stance: "open",
      entry,
      settings,
      snapshotInputs,
      trigger: "auto"
    });

    await repository.decideAiProposal(first.proposals[0].id, "accepted", entry.date);

    const second = await service.buildPulse(repository, {
      stance: "open",
      entry,
      settings,
      snapshotInputs,
      trigger: "auto"
    });

    expect(second.source).toBe("cache");
    expect(provider.generateStructured).toHaveBeenCalledOnce();
  });

  it("does not reuse skipped rows as AI cache after enabling AI", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          stance: "open",
          headline: "IA",
          read: "Signal",
          move: null
        }),
        model: "test-model",
        usage: { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 100 }
      }))
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new CoachPulseService(provider);
    const disabledSettings = defaultAppSettings();
    const enabledSettings = defaultAppSettings();
    enabledSettings.aiEnabled = true;
    enabledSettings.aiApiKey = "secret";
    const entry = createEmptyDailyEntry("2026-08-29");
    const snapshotInputs = buildSnapshotInputs(entry);

    await service.buildPulse(repository, {
      stance: "open",
      entry,
      settings: disabledSettings,
      snapshotInputs,
      trigger: "explicit"
    });

    const result = await service.buildPulse(repository, {
      stance: "open",
      entry,
      settings: enabledSettings,
      snapshotInputs,
      trigger: "auto"
    });

    expect(result.source).toBe("ai");
    expect(provider.generateStructured).toHaveBeenCalledOnce();
  });
});

describe("MemoryRepository ai_messages", () => {
  it("persists and retrieves ai messages and proposals", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const message = {
      id: "ai-message:test",
      surface: "coach_pulse" as const,
      scopeKey: "2026-08-29",
      stance: "open" as const,
      kind: "open",
      inputHash: "abc123",
      promptVersion: "coach_pulse.v1",
      model: "local",
      status: "skipped" as const,
      bodyJson: JSON.stringify({ stance: "open", headline: "Test", read: "Lecture", move: null }),
      bodyText: "Test",
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt: "2026-08-29T08:00:00.000Z"
    };

    await repository.saveAiMessage(message);
    await repository.saveAiProposal({
      id: "ai-proposal:test",
      messageId: message.id,
      type: "intention_draft",
      payloadJson: JSON.stringify({ text: "Focus" }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: "2026-08-29T08:00:00.000Z"
    });

    await expect(repository.getAiMessage("coach_pulse", "2026-08-29", "abc123")).resolves.toBeNull();
    await expect(repository.listAiMessagesForDate("2026-08-29")).resolves.toHaveLength(1);
    await expect(repository.listAiProposals(message.id)).resolves.toHaveLength(1);

    const decided = await repository.decideAiProposal("ai-proposal:test", "accepted", "2026-08-29");
    expect(decided.status).toBe("accepted");
  });

  it("persists coach pulse episodes atomically", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const message = {
      id: "ai-message:episode",
      surface: "coach_pulse" as const,
      scopeKey: "2026-08-29",
      stance: "open" as const,
      kind: "open",
      inputHash: "hash",
      promptVersion: "coach_pulse.v1",
      model: "test",
      status: "ok" as const,
      bodyJson: JSON.stringify({
        stance: "open",
        headline: "Coach",
        read: "Lecture",
        move: null,
        intentionDraft: "Focus"
      } satisfies CoachPulseResponse),
      bodyText: "Coach",
      deltaClass: null,
      notified: false,
      tokensPrompt: 1,
      tokensCompletion: 2,
      latencyMs: 3,
      createdAt: "2026-08-29T08:00:00.000Z"
    };

    const saved = await repository.saveCoachPulseEpisode(message, [
      {
        id: "ai-proposal:episode",
        messageId: message.id,
        type: "intention_draft",
        payloadJson: JSON.stringify({ text: "Focus" }),
        status: "pending",
        appliedEntityId: null,
        decidedAt: null,
        createdAt: "2026-08-29T08:00:00.000Z"
      }
    ]);

    expect(saved.proposals).toHaveLength(1);
    await expect(repository.listAiProposals(message.id)).resolves.toHaveLength(1);
  });
});
