import { createEmptyDailyEntry, updateNote } from "../../domain/daily-entry";
import { createEmptyAnnualGoal } from "../../domain/annual-goals";
// @vitest-environment node
import type { AiProposal } from "../../domain/types";
import { createEmptyWeeklyReview } from "../../domain/weekly-review";
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { MemoryRepository } from "./memory-repository";
import { TauriSqliteRepository } from "./tauri-sqlite-repository";

const proposal = (id: string): AiProposal => ({
  id,
  messageId: "message:test",
  type: "gtd_action",
  payloadJson: "{}",
  status: "pending",
  appliedEntityId: null,
  decidedAt: null,
  createdAt: "2026-08-02T12:00:00.000Z",
});

const fixtures = [
  {
    name: "memory",
    create: async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      return {
        repository,
        failDecision: () => {
          const map = (repository as unknown as { aiProposals: Map<string, AiProposal> })
            .aiProposals;
          const spy = vi.spyOn(map, "set").mockImplementationOnce(() => {
            throw new Error("decision failed");
          });
          return () => spy.mockRestore();
        },
      };
    },
  },
  {
    name: "SQLite",
    create: async () => {
      const db = createNodeSqliteDatabase();
      const repository = new TauriSqliteRepository("sqlite::memory:", async () => db);
      await repository.initialize();
      return {
        repository,
        failDecision: () => {
          const originalExecute = db.execute.bind(db);
          const spy = vi.spyOn(db, "execute").mockImplementation(async (sql, values) => {
            if (sql.startsWith("UPDATE ai_proposals SET status = 'accepted'"))
              throw new Error("decision failed");
            return originalExecute(sql, values);
          });
          return () => spy.mockRestore();
        },
      };
    },
  },
];

for (const fixture of fixtures) {
  describe(`${fixture.name} atomic proposal acceptance`, () => {
    it("rolls back daily notes and the decision together, then permits retry", async () => {
      const { repository, failDecision } = await fixture.create();
      const original = createEmptyDailyEntry("2026-08-02");
      original.metrics.pushups = 17;
      await repository.saveDailyEntry(original);
      const before = await repository.getDailyEntry(original.date);
      const row = { ...proposal("proposal:daily"), type: "intention_draft" as const };
      await repository.saveAiProposal(row);
      const effect = {
        kind: "dailyEntry" as const,
        entry: updateNote(before!, "morningIntention", "Focus"),
      };
      const restore = failDecision();
      await expect(repository.acceptAiProposal(row.id, effect)).rejects.toThrow("decision failed");
      restore();
      expect(await repository.getDailyEntry(original.date)).toEqual(before);
      expect((await repository.listAiProposals(row.messageId))[0].status).toBe("pending");
      await repository.acceptAiProposal(row.id, effect);
      expect(await repository.getDailyEntry(original.date)).toMatchObject({
        morningIntention: "Focus",
        metrics: { pushups: 17 },
      });
    });

    it("rolls back goal evaluations and reads the current goal on later accepts", async () => {
      const { repository, failDecision } = await fixture.create();
      const goal = await repository.saveAnnualGoal(
        createEmptyAnnualGoal({ id: "goal:atomic", title: "Read", description: "Keep" }),
      );
      const row = { ...proposal("proposal:goal"), type: "goal_evaluation" as const };
      await repository.saveAiProposal(row);
      const effect = {
        kind: "goalEvaluation" as const,
        goalId: goal.id,
        monthKey: "2026-08",
        evaluation: { score: 80, notes: "Good" },
      };
      const restore = failDecision();
      await expect(repository.acceptAiProposal(row.id, effect)).rejects.toThrow("decision failed");
      restore();
      expect((await repository.listAnnualGoals())[0]).toEqual(goal);
      expect((await repository.listAiProposals(row.messageId))[0].status).toBe("pending");
      await repository.acceptAiProposal(row.id, effect);
      const second = { ...row, id: "proposal:goal:second" };
      await repository.saveAiProposal(second);
      await repository.acceptAiProposal(second.id, {
        ...effect,
        monthKey: "2026-09",
        evaluation: { score: 90 },
      });
      expect((await repository.listAnnualGoals())[0]).toMatchObject({
        description: "Keep",
        evaluations: { "2026-08": { score: 80, notes: "Good" }, "2026-09": { score: 90 } },
      });
    });

    it("keeps dismissed proposals from mutating data", async () => {
      const { repository } = await fixture.create();
      const row = proposal("proposal:dismissed");
      await repository.saveAiProposal(row);
      await repository.decideAiProposal(row.id, "dismissed");
      const result = await repository.acceptAiProposal(row.id, {
        kind: "dailyEntry",
        entry: createEmptyDailyEntry("2026-08-02"),
      });
      expect(result.appliedEntityId).toBeNull();
      expect(await repository.getDailyEntry("2026-08-02")).toBeNull();
      expect(result.proposal.status).toBe("dismissed");
    });

    it("rolls back task lifecycle changes and leaves the proposal pending when the decision fails", async () => {
      const { repository, failDecision } = await fixture.create();
      const task = await repository.createTask({ title: "task", bucket: "inbox", contextIds: [] });
      const beforeEvents = await repository.listTaskEvents();
      const row = proposal("proposal:rollback");
      await repository.saveAiProposal(row);
      const restore = failDecision();
      const effect = {
        kind: "gtdTask" as const,
        taskId: task.id,
        action: "drop" as const,
        scheduledDate: "2026-08-02",
      };
      await expect(repository.acceptAiProposal(row.id, effect)).rejects.toThrow("decision failed");
      restore();
      expect(
        (await repository.listTasks({ includeCompleted: true })).find(
          (item) => item.id === task.id,
        ),
      ).toMatchObject({ status: "active" });
      expect(await repository.listTaskEvents()).toEqual(beforeEvents);
      expect((await repository.listAiProposals(row.messageId))[0].status).toBe("pending");
      const retried = await repository.acceptAiProposal(row.id, effect);
      expect(retried.proposal.status).toBe("accepted");
      expect(retried.appliedEntityId).toBe(task.id);
    });

    it("rolls back a review write if its proposal decision fails", async () => {
      const { repository, failDecision } = await fixture.create();
      const row = { ...proposal("proposal:review"), type: "review_section_draft" as const };
      await repository.saveAiProposal(row);
      const restore = failDecision();
      await expect(
        repository.acceptAiProposal(row.id, {
          kind: "weeklyReview",
          review: createEmptyWeeklyReview("2026-08-02"),
        }),
      ).rejects.toThrow("decision failed");
      restore();
      expect(await repository.getWeeklyReview("2026-08-02")).toBeNull();
      expect((await repository.listAiProposals(row.messageId))[0].status).toBe("pending");
    });

    it("retains the first applied review on re-accept and resolves concurrent accepts identically", async () => {
      const { repository } = await fixture.create();
      const row = { ...proposal("proposal:repeat"), type: "review_section_draft" as const };
      await repository.saveAiProposal(row);
      const original = createEmptyWeeklyReview("2026-08-02");
      original.notes.bilan = "accepted first";
      const changed = { ...original, notes: { ...original.notes, bilan: "should not replace" } };
      const [first, second] = await Promise.all([
        repository.acceptAiProposal(row.id, { kind: "weeklyReview", review: original }),
        repository.acceptAiProposal(row.id, { kind: "weeklyReview", review: changed }),
      ]);
      expect(second).toEqual(first);
      expect((await repository.getWeeklyReview("2026-08-02"))?.notes.bilan).toBe("accepted first");
    });

    it("resets missed occurrences on drop and rolls back that reset on a failed decision", async () => {
      const { repository, failDecision } = await fixture.create();
      const timestamp = "2026-08-02T12:00:00.000Z";
      const template = await repository.saveRecurringTaskTemplate({
        id: "template:test",
        title: "recurring",
        notes: "",
        targetBucket: "next_action",
        contextIds: [],
        projectId: null,
        ruleType: "daily",
        dailyInterval: 1,
        weeklyInterval: 1,
        weeklyDays: [0],
        monthlyMode: "day_of_month",
        dayOfMonth: 1,
        nthWeek: 1,
        weekday: 6,
        scheduledTime: null,
        startDate: "2026-08-02",
        status: "paused",
        lastGeneratedForDate: "2026-08-02",
        pendingMissedOccurrences: 7,
        statusChangedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const task = await repository.createTask({
        title: "recurring task",
        bucket: "next_action",
        contextIds: [],
      });
      await repository.saveTask({
        ...task,
        recurringTemplateId: template.id,
        isRecurringInstance: true,
        recurrenceDueDate: "2026-08-02",
      });
      const row = proposal("proposal:recurring");
      await repository.saveAiProposal(row);
      const effect = {
        kind: "gtdTask" as const,
        taskId: task.id,
        action: "drop" as const,
        scheduledDate: "2026-08-02",
      };
      const restore = failDecision();
      await expect(repository.acceptAiProposal(row.id, effect)).rejects.toThrow("decision failed");
      restore();
      expect(
        (await repository.listRecurringTaskTemplates()).find((item) => item.id === template.id)
          ?.pendingMissedOccurrences,
      ).toBe(7);
      await repository.acceptAiProposal(row.id, effect);
      expect(
        (await repository.listRecurringTaskTemplates()).find((item) => item.id === template.id)
          ?.pendingMissedOccurrences,
      ).toBe(0);
    });

    it("leaves a missing task pending and throws for a missing proposal", async () => {
      const { repository } = await fixture.create();
      const row = proposal("proposal:missing-task");
      await repository.saveAiProposal(row);
      const result = await repository.acceptAiProposal(row.id, {
        kind: "gtdTask",
        taskId: "missing",
        action: "drop",
        scheduledDate: "2026-08-02",
      });
      expect(result).toMatchObject({ appliedEntityId: null, proposal: { status: "pending" } });
      await expect(repository.acceptAiProposal("missing", null)).rejects.toThrow(
        "AI proposal not found",
      );
    });
  });
}
