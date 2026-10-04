// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEmptyAnnualGoal } from "../../../../domain/annual-goals";
import { createEmptyDailyEntry } from "../../../../domain/daily-entry";
import { createEmptyMonthlyReview } from "../../../../domain/monthly-review";
import { createEmptyWeeklyObjective } from "../../../../domain/weekly-objectives";
import { createEmptyWeeklyReview } from "../../../../domain/weekly-review";
import { createTaskFromInput } from "../../../gtd/engine";
import { createRecurringTemplate } from "../../../recurring/engine";
import { createNodeSqliteDatabase } from "../../../../test/mocks/node-sqlite-database";
import { TauriSqliteRepository } from "../../tauri-sqlite-repository";
import * as aiMemories from "./aiMemories";
import * as aiMessages from "./aiMessages";
import * as aiProposals from "./aiProposals";
import * as annualGoals from "./annualGoals";
import * as contexts from "./contexts";
import * as dailyEntries from "./dailyEntries";
import * as emailAccounts from "./emailAccounts";
import * as emailReviews from "./emailReviews";
import * as midWeekDecisions from "./midWeekDecisions";
import * as rescueTimeCache from "./rescueTimeCache";
import * as monthlyReviews from "./monthlyReviews";
import * as pomodoroSegments from "./pomodoroSegments";
import * as pomodoroSessions from "./pomodoroSessions";
import * as projects from "./projects";
import * as recurringTemplates from "./recurringTemplates";
import * as taskEvents from "./taskEvents";
import * as tasks from "./tasks";
import * as weeklyObjectiveResults from "./weeklyObjectiveResults";
import * as weeklyObjectives from "./weeklyObjectives";
import * as weeklyReviews from "./weeklyReviews";

const now = "2026-10-03T12:00:00.000Z";
const date = "2026-10-03";
const repositoryReads = new Map<
  object,
  { table: string; read: (repo: TauriSqliteRepository) => Promise<unknown> }
>([
  [
    dailyEntries,
    { table: "daily_entries", read: (repo) => repo.listDailyEntriesInRange(date, date) },
  ],
  [weeklyReviews, { table: "weekly_reviews", read: (repo) => repo.getWeeklyReview("2026-09-27") }],
  [monthlyReviews, { table: "monthly_reviews", read: (repo) => repo.getMonthlyReview("2026-10") }],
  [annualGoals, { table: "annual_goals", read: (repo) => repo.listAnnualGoals() }],
  [weeklyObjectives, { table: "weekly_objectives", read: (repo) => repo.listWeeklyObjectives() }],
  [
    weeklyObjectiveResults,
    {
      table: "weekly_objective_results",
      read: (repo) => repo.getWeeklyObjectiveResults("2026-09-27"),
    },
  ],
  [contexts, { table: "gtd_contexts", read: (repo) => repo.listContexts() }],
  [projects, { table: "gtd_projects", read: (repo) => repo.listProjects() }],
  [tasks, { table: "gtd_tasks", read: (repo) => repo.listTasks() }],
  [taskEvents, { table: "gtd_task_events", read: (repo) => repo.listTaskEvents() }],
  [
    recurringTemplates,
    { table: "recurring_task_templates", read: (repo) => repo.listRecurringTaskTemplates() },
  ],
  [
    pomodoroSessions,
    { table: "pomodoro_sessions", read: (repo) => repo.listPomodoroSessions(date) },
  ],
  [
    pomodoroSegments,
    {
      table: "pomodoro_segments",
      read: async (repo) =>
        (await repo.listPomodoroSessions(date)).flatMap((session) => session.segments),
    },
  ],
  [aiMessages, { table: "ai_messages", read: (repo) => repo.listAiMessages() }],
  [aiProposals, { table: "ai_proposals", read: (repo) => repo.listAiProposals("message") }],
  [aiMemories, { table: "ai_memories", read: (repo) => repo.listAiMemories() }],
  [
    emailAccounts,
    { table: "email_triage_accounts", read: async (repo) => repo.emailTriage.listAccounts() },
  ],
  [
    emailReviews,
    { table: "email_triage_reviews", read: async (repo) => repo.emailTriage.listReviews() },
  ],
  [
    midWeekDecisions,
    { table: "mid_week_decisions", read: (repo) => repo.getMidWeekDecisions("2026-09-27") },
  ],
  [
    rescueTimeCache,
    {
      table: "rescuetime_snapshot_cache",
      read: (repo) => repo.getRescueTimeSnapshotCache("2026-09-27", "goals", "fingerprint"),
    },
  ],
]);
const roundTrip = <Entity, Row>(
  mapper: { COLUMNS: string; toParams(entity: Entity): unknown[]; fromRow(row: Row): Entity },
  entity: Entity,
) => {
  it("round trips every column through SQLite bindings", async () => {
    const columns = mapper.COLUMNS.split(", ");
    const params = mapper.toParams(entity);
    expect(params).toHaveLength(columns.length);
    const db = createNodeSqliteDatabase();
    const rows = await db.select<Row[]>(
      `SELECT ${columns.map((column, index) => `$${index + 1} AS ${column}`).join(", ")}`,
      params,
    );
    expect(mapper.fromRow(rows[0])).toEqual(entity);
  });
  it("reads every mapped field through the repository's actual SELECT", async () => {
    const db = createNodeSqliteDatabase();
    const repo = new TauriSqliteRepository("sqlite::memory:", async () => db);
    await repo.initialize();
    const mapping = repositoryReads.get(mapper);
    if (!mapping) throw new Error("Missing repository read for mapper");
    const columns = mapper.COLUMNS.split(", ");
    await db.execute(
      `INSERT INTO ${mapping.table} (${mapper.COLUMNS}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
      mapper.toParams(entity),
    );
    if (mapping.table === "pomodoro_segments") {
      // Session details expose segments only when their owning session exists.
      await db.execute(
        "INSERT INTO pomodoro_sessions (id, kind, status, started_at, ends_at, cycle_index, date) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        ["session", "focus", "completed", now, now, 1, date],
      );
    }
    const result = await mapping.read(repo);
    if (Array.isArray(result)) {
      expect(result).toContainEqual(expect.objectContaining(entity));
    } else {
      expect(result).toEqual(entity);
    }
  });
};

describe("daily entries", () =>
  roundTrip(dailyEntries, {
    ...createEmptyDailyEntry(date),
    morningIntention: "Focus",
    nightReflection: "Read",
    tomorrowFocus: "Rest",
  }));
describe("weekly reviews", () => roundTrip(weeklyReviews, createEmptyWeeklyReview("2026-09-27")));
describe("monthly reviews", () => roundTrip(monthlyReviews, createEmptyMonthlyReview("2026-10")));
describe("annual goals", () =>
  roundTrip(
    annualGoals,
    createEmptyAnnualGoal({
      id: "goal",
      title: "Read",
      targetValue: 42.5,
      progressLog: { "2026-09": 3 },
      milestones: [],
    }),
  ));
describe("weekly objectives", () =>
  roundTrip(
    weeklyObjectives,
    createEmptyWeeklyObjective({
      id: "objective",
      title: "Write",
      kind: "time",
      targetHours: 3.5,
      rescuetimeKind: "activity",
      rescuetimeThing: "Editor",
      startsOnWeekStartDate: "2026-09-27",
    }),
  ));
describe("weekly objective results", () =>
  roundTrip(weeklyObjectiveResults, {
    weekStartDate: "2026-09-27",
    objectiveId: "objective",
    achieved: true,
    updatedAt: now,
  }));
describe("contexts", () =>
  roundTrip(contexts, { id: "context", name: "Writing", createdAt: now, updatedAt: now }));
describe("projects", () =>
  roundTrip(projects, {
    id: "project",
    title: "Book",
    status: "active",
    statusChangedAt: now,
    notes: "Notes",
    contextIds: ["context"],
    source: "google_import",
    sourceExternalId: "external",
    createdAt: now,
    updatedAt: now,
  }));
const task = {
  ...createTaskFromInput({
    id: "task",
    title: "Read",
    sourceUrl: "https://example.com",
    contextIds: ["context"],
  }),
  plannedOrder: 4,
  pendingPastRecurrences: 2,
  isRecurringInstance: true,
  recurrenceDueDate: date,
};
describe("tasks", () => roundTrip(tasks, task));
describe("task events", () =>
  roundTrip(taskEvents, {
    id: "event",
    taskId: "task",
    type: "task_created",
    eventDate: date,
    eventAt: now,
    createdAt: now,
    dedupeKey: "once",
    metadata: { from: "inbox" },
  }));
describe("recurring templates", () =>
  roundTrip(
    recurringTemplates,
    createRecurringTemplate({
      id: "template",
      title: "Read",
      startDate: date,
      weeklyDays: [0, 4],
      dailyInterval: 2,
      pendingMissedOccurrences: 3,
      contextIds: ["context"],
    }),
  ));
describe("Pomodoro sessions", () =>
  roundTrip(pomodoroSessions, {
    id: "session",
    kind: "focus",
    status: "paused",
    startedAt: now,
    endsAt: now,
    pausedRemainingMs: 17000,
    completedAt: null,
    cancelledAt: null,
    cycleIndex: 2,
    date,
  }));
describe("Pomodoro segments", () =>
  roundTrip(pomodoroSegments, {
    id: "segment",
    sessionId: "session",
    taskId: "task",
    title: "Read",
    startedAt: now,
    endedAt: null,
  }));
describe("AI messages", () =>
  roundTrip(aiMessages, {
    id: "message",
    surface: "coach_pulse",
    scopeKey: date,
    stance: "open",
    kind: "pulse",
    inputHash: "hash",
    promptVersion: "v1",
    model: "model",
    status: "ok",
    bodyJson: "{}",
    bodyText: null,
    deltaClass: "progress",
    notified: true,
    tokensPrompt: 7,
    tokensCompletion: 2,
    latencyMs: 300,
    createdAt: now,
  }));
describe("AI proposals", () =>
  roundTrip(aiProposals, {
    id: "proposal",
    messageId: "message",
    type: "memory",
    payloadJson: "{}",
    status: "pending",
    appliedEntityId: null,
    decidedAt: null,
    createdAt: now,
  }));
describe("AI memories", () =>
  roundTrip(aiMemories, {
    id: "memory",
    kind: "pattern",
    statement: "Read",
    detail: "Weekly",
    confidence: 0.75,
    source: "ai_extracted",
    status: "active",
    evidenceFrom: date,
    evidenceTo: null,
    createdAt: now,
    lastConfirmedAt: now,
    expiresAt: null,
    pinned: true,
  }));
describe("email accounts", () =>
  roundTrip(emailAccounts, {
    id: "account",
    provider: "gmail",
    providerAccountId: "provider",
    label: "Mail",
    maskedAddress: "a***@example.com",
    generation: 2,
    enabled: true,
    mutationEnabled: false,
    paused: true,
    state: "active",
    recoveryState: "none",
    lastSuccessAt: now,
    lastError: null,
    pollIntervalMinutes: 7,
    syncState: { historyId: "123" },
    createdAt: now,
    updatedAt: now,
  }));
describe("email reviews", () =>
  roundTrip(emailReviews, {
    id: "review",
    accountId: "account",
    conversationId: "conversation",
    messageId: "message",
    expectedDecisionVersion: 2,
    status: "pending",
    reason: "uncertain",
    resolution: null,
    resolvedAt: null,
    createdAt: now,
    sanitizedPreview: {
      subject: "Mail",
      sender: "sender@example.com",
      receivedAt: now,
      sourceUrl: null,
    },
  }));

it("preserves legacy task null defaults and JSON failure behavior", () => {
  const row = Object.fromEntries(
    tasks.COLUMNS.split(", ").map((column, index) => [column, tasks.toParams(task)[index]]),
  ) as unknown as tasks.TaskRow;
  expect(
    tasks.fromRow({
      ...row,
      pending_past_recurrences: null,
      planned_order: null,
      source_url: null,
    } as unknown as tasks.TaskRow),
  ).toMatchObject({ pendingPastRecurrences: 0, plannedOrder: null, sourceUrl: null });
  expect(() => tasks.fromRow({ ...row, context_ids_json: "broken" })).toThrow();
});

it("preserves annual goal safe fallbacks while rejecting malformed required JSON", () => {
  const goal = createEmptyAnnualGoal({ title: "Read" });
  const row = Object.fromEntries(
    annualGoals.COLUMNS.split(", ").map((column, index) => [
      column,
      annualGoals.toParams(goal)[index],
    ]),
  ) as unknown as annualGoals.AnnualGoalRow;
  expect(
    annualGoals.fromRow({ ...row, progress_log_json: "broken", milestones_json: "broken" }),
  ).toMatchObject({ progressLog: {}, milestones: [] });
  expect(() => annualGoals.fromRow({ ...row, evaluations_json: "broken" })).toThrow();
});

it("uses all task columns for imports and preserves conflict modes", async () => {
  const db = createNodeSqliteDatabase();
  await new TauriSqliteRepository("sqlite::memory:", async () => db).initialize();
  await db.execute(tasks.insertSql("ignore"), tasks.toParams(task));
  await db.execute(tasks.insertSql("ignore"), tasks.toParams({ ...task, title: "Ignored" }));
  const read = async () =>
    tasks.fromRow(
      (
        await db.select<tasks.TaskRow[]>(`SELECT ${tasks.COLUMNS} FROM gtd_tasks WHERE id = $1`, [
          task.id,
        ])
      )[0],
    );
  expect(await read()).toEqual(task);
  await db.execute(
    tasks.insertSql("update"),
    tasks.toParams({
      ...task,
      title: "Updated",
      plannedOrder: 8,
      sourceUrl: "https://example.com/new",
    }),
  );
  expect(await read()).toEqual({
    ...task,
    title: "Updated",
    plannedOrder: 8,
    sourceUrl: "https://example.com/new",
  });
});

describe("mid-week decisions", () =>
  roundTrip(midWeekDecisions, {
    weekStartDate: "2026-09-27",
    decisions: "Continue",
    decidedOnDate: date,
    laggingSnapshot: null,
    updatedAt: now,
  }));
describe("RescueTime cache", () =>
  roundTrip(rescueTimeCache, {
    weekStartDate: "2026-09-27",
    kind: "goals",
    credentialFingerprint: "fingerprint",
    payloadJson: "{}",
    fetchedAt: now,
  }));
