import { createEmptyDailyEntry, updateMetric, updateNote, updatePrinciple } from "../../../domain/daily-entry";
import type { PomodoroTaskSummary, Project, Task } from "../../../domain/types";
import { buildDailySnapshot, type DailySnapshotInputs } from "./daily-snapshot";

const now = "2026-02-01T12:00:00.000Z";

const buildEntry = () => {
  let entry = createEmptyDailyEntry("2026-02-01");
  entry = updateMetric(entry, "pomodoris", 6);
  entry = updatePrinciple(entry, "priereDuMatin", true);
  entry = updateNote(entry, "morningIntention", "Ecrire le module d'insights.");
  entry = updateNote(entry, "nightReflection", "Bonne avancee aujourd'hui.");
  entry = updateNote(entry, "tomorrowFocus", "Terminer le context builder.");
  return entry;
};

const buildProject = (overrides: Partial<Project>): Project => ({
  id: overrides.id ?? "project:default",
  title: "Projet sans next action",
  status: "active",
  statusChangedAt: now,
  notes: "",
  contextIds: [],
  source: "manual",
  sourceExternalId: null,
  createdAt: now,
  updatedAt: now,
  ...overrides
});

const buildTask = (overrides: Partial<Task>): Task => ({
  id: overrides.id ?? "task:default",
  title: "Tache",
  notes: "",
  status: "active",
  bucket: "next_action",
  contextIds: [],
  projectId: null,
  parentTaskId: null,
  scheduledFor: null,
  deadline: null,
  recurringTemplateId: null,
  recurrenceDueDate: null,
  isRecurringInstance: false,
  completedAt: null,
  recurrenceGroupId: null,
  pendingPastRecurrences: 0,
  source: "manual",
  sourceExternalId: null,
  createdAt: now,
  updatedAt: now,
  ...overrides
});

const buildInputs = (): DailySnapshotInputs => {
  const entry = buildEntry();
  const projectWithoutNextAction = buildProject({ id: "project:without-next-action" });
  const projectWithNextAction = buildProject({ id: "project:with-next-action", title: "Projet actif" });
  const tasks: Task[] = [
    buildTask({ id: "task:next-action", bucket: "next_action", projectId: projectWithNextAction.id })
  ];
  const pomodoroTaskSummaries: PomodoroTaskSummary[] = [
    { taskId: "task:next-action", taskTitle: "Tache prioritaire", totalSeconds: 3000, sessionCount: 4 },
    { taskId: "task:other", taskTitle: "Autre tache", totalSeconds: 600, sessionCount: 1 }
  ];

  return {
    date: "2026-02-01",
    entry,
    historyEntries: [entry],
    tasks,
    projects: [projectWithoutNextAction, projectWithNextAction],
    pomodoroTaskSummaries,
    completedFocusSessionCount: 5,
    productivityPulseWeekToDate: 70,
    rescuetimeConfigured: true,
    now
  };
};

describe("daily snapshot context builder", () => {
  it("always includes numbers, aggregates, principle booleans and findings", () => {
    const snapshot = buildDailySnapshot(buildInputs(), "metrics");

    expect(snapshot.metrics.find((metric) => metric.key === "pomodoris")?.todayValue).toBe(6);
    expect(snapshot.principles.find((principle) => principle.key === "priereDuMatin")?.todayValue).toBe(true);
    expect(snapshot.gtd.projectsWithoutNextAction).toBe(1);
    expect(snapshot.findings.length).toBeGreaterThan(0);
  });

  it("omits free text and titles at the metrics scope", () => {
    const snapshot = buildDailySnapshot(buildInputs(), "metrics");
    const json = JSON.parse(JSON.stringify(snapshot));

    expect("notes" in json).toBe(false);
    expect(json.gtd.projectsWithoutNextActionSample.every((item: { title?: string }) => !("title" in item))).toBe(
      true
    );
    expect("title" in json.pomodoro.topTask).toBe(false);
  });

  it("never leaks raw task/project identifiers through findings at the metrics scope", () => {
    // Isolated from `buildInputs()` on purpose: `projectsWithoutNextActionSample`/`pomodoro.topTask`
    // already expose a capped, always-present raw id at every scope (only their `title` is scope-gated,
    // by existing design) — this fixture avoids both so the only remaining source of a "task:"/"project:"
    // substring is the raw `taskIds`/`projectIds` carried by `gtd-health.ts` findings.
    const entry = buildEntry();
    const projectWithNextAction = buildProject({ id: "project:with-next-action" });
    const tasks: Task[] = [
      buildTask({ id: "task:next-action", bucket: "next_action", projectId: projectWithNextAction.id }),
      buildTask({ id: "task:scheduled", bucket: "scheduled" }),
      buildTask({ id: "task:completed", status: "completed", bucket: "next_action", completedAt: now })
    ];
    const inputs: DailySnapshotInputs = {
      date: "2026-02-01",
      entry,
      historyEntries: [entry],
      tasks,
      projects: [projectWithNextAction],
      pomodoroTaskSummaries: [],
      completedFocusSessionCount: 5,
      productivityPulseWeekToDate: 70,
      rescuetimeConfigured: true,
      now
    };

    const snapshot = buildDailySnapshot(inputs, "metrics");
    const json = JSON.stringify(snapshot);

    expect(json).not.toContain("task:");
    expect(json).not.toContain("project:");
    // Sanity check: the scheduled-vs-completed finding that normally carries these ids is actually
    // present with a non-empty population, so the assertion above exercises the redaction rather
    // than an empty findings array.
    const ratioFinding = snapshot.findings.find((finding) => finding.id.startsWith("gtd_health:scheduled_vs_completed_ratio"));
    expect(ratioFinding).toBeDefined();
    expect(ratioFinding?.sampleSize).toBeGreaterThan(0);
  });

  it("keeps raw task identifiers in findings at the metrics_and_structure scope", () => {
    const entry = buildEntry();
    const tasks: Task[] = [
      buildTask({ id: "task:scheduled", bucket: "scheduled" }),
      buildTask({ id: "task:completed", status: "completed", bucket: "next_action", completedAt: now })
    ];
    const inputs: DailySnapshotInputs = {
      date: "2026-02-01",
      entry,
      historyEntries: [entry],
      tasks,
      projects: [],
      pomodoroTaskSummaries: [],
      completedFocusSessionCount: 5,
      productivityPulseWeekToDate: 70,
      rescuetimeConfigured: true,
      now
    };

    const snapshot = buildDailySnapshot(inputs, "metrics_and_structure");
    const json = JSON.stringify(snapshot);

    expect(json).toContain("task:");
  });

  it("includes task titles and project names at the metrics_and_structure scope, but not free text", () => {
    const snapshot = buildDailySnapshot(buildInputs(), "metrics_and_structure");
    const json = JSON.parse(JSON.stringify(snapshot));

    expect("notes" in json).toBe(false);
    expect(json.gtd.projectsWithoutNextActionSample[0].title).toBe("Projet sans next action");
    expect(json.pomodoro.topTask.title).toBe("Tache prioritaire");
  });

  it("includes notes, reflections and titles at the full scope", () => {
    const snapshot = buildDailySnapshot(buildInputs(), "full");
    const json = JSON.parse(JSON.stringify(snapshot));

    expect(json.notes.morningIntention).toBe("Ecrire le module d'insights.");
    expect(json.notes.nightReflection).toBe("Bonne avancee aujourd'hui.");
    expect(json.notes.tomorrowFocus).toBe("Terminer le context builder.");
    expect(json.pomodoro.topTask.title).toBe("Tache prioritaire");
  });

  it("reports the top pomodoro task by total focus seconds", () => {
    const snapshot = buildDailySnapshot(buildInputs(), "full");

    expect(snapshot.pomodoro.topTask?.taskId).toBe("task:next-action");
    expect(snapshot.pomodoro.totalFocusMinutes).toBe(60);
  });

  it("labels the RescueTime pulse as week-to-date rather than a same-day figure", () => {
    const snapshot = buildDailySnapshot(buildInputs(), "full");

    expect(snapshot.rescueTime.productivityPulseWeekToDate).toBe(70);
    expect("productivityPulse" in snapshot.rescueTime).toBe(false);
  });
});
