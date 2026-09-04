import type { Project, Task } from "../types";
import { computeGtdHealthFindings } from "./gtd-health";

const now = "2026-02-01T12:00:00.000Z";

const buildTask = (overrides: Partial<Task>): Task => ({
  id: overrides.id ?? "task:default",
  title: "Task",
  notes: "",
  status: "active",
  bucket: "inbox",
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
  ...overrides,
});

const buildProject = (overrides: Partial<Project>): Project => ({
  id: overrides.id ?? "project:default",
  title: "Project",
  status: "active",
  statusChangedAt: now,
  notes: "",
  contextIds: [],
  source: "manual",
  sourceExternalId: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const findKind = (
  findings: ReturnType<typeof computeGtdHealthFindings>,
  kind: ReturnType<typeof computeGtdHealthFindings>[number]["kind"],
) => findings.find((finding) => finding.kind === kind);

describe("gtd-health insight module", () => {
  it("counts the inbox backlog", () => {
    const tasks = [
      buildTask({ id: "t1", bucket: "inbox" }),
      buildTask({ id: "t2", bucket: "next_action" }),
    ];

    const finding = findKind(computeGtdHealthFindings(tasks, [], now), "inbox_backlog");

    expect(finding?.value).toBe(1);
    expect(finding?.sampleSize).toBe(2);
    expect(finding?.taskIds).toEqual(["t1"]);
  });

  it("finds active projects without an active next action", () => {
    const projects = [buildProject({ id: "p1" }), buildProject({ id: "p2" })];
    const tasks = [buildTask({ id: "t1", bucket: "next_action", projectId: "p2" })];

    const finding = findKind(
      computeGtdHealthFindings(tasks, projects, now),
      "projects_without_next_action",
    );

    expect(finding?.value).toBe(1);
    expect(finding?.projectIds).toEqual(["p1"]);
  });

  it("flags next actions untouched for more than the stale threshold", () => {
    const tasks = [
      buildTask({ id: "stale", bucket: "next_action", updatedAt: "2026-01-22T12:00:00.000Z" }),
      buildTask({ id: "fresh", bucket: "next_action", updatedAt: now }),
    ];

    const finding = findKind(computeGtdHealthFindings(tasks, [], now), "stale_next_actions");

    expect(finding?.value).toBe(1);
    expect(finding?.sampleSize).toBe(2);
    expect(finding?.taskIds).toEqual(["stale"]);
  });

  it("flags waiting-for items aging beyond the threshold", () => {
    const tasks = [
      buildTask({ id: "aging", bucket: "waiting_for", updatedAt: "2026-01-12T12:00:00.000Z" }),
      buildTask({ id: "recent", bucket: "waiting_for", updatedAt: "2026-01-27T12:00:00.000Z" }),
    ];

    const finding = findKind(computeGtdHealthFindings(tasks, [], now), "aging_waiting_for");

    expect(finding?.value).toBe(1);
    expect(finding?.taskIds).toEqual(["aging"]);
  });

  it("flags overdue deadlines", () => {
    const tasks = [
      buildTask({ id: "overdue", bucket: "next_action", deadline: "2026-01-27" }),
      buildTask({ id: "future", bucket: "next_action", deadline: "2026-02-06" }),
    ];

    const finding = findKind(computeGtdHealthFindings(tasks, [], now), "overdue_deadlines");

    expect(finding?.value).toBe(1);
    expect(finding?.taskIds).toEqual(["overdue"]);
  });

  it("computes the scheduled-vs-completed ratio over the trailing window", () => {
    const tasks = [
      buildTask({ id: "scheduled", bucket: "scheduled" }),
      buildTask({
        id: "completed-recent",
        status: "completed",
        completedAt: "2026-01-20T12:00:00.000Z",
      }),
      buildTask({
        id: "completed-old",
        status: "completed",
        completedAt: "2025-12-01T12:00:00.000Z",
      }),
    ];

    const finding = findKind(
      computeGtdHealthFindings(tasks, [], now),
      "scheduled_vs_completed_ratio",
    );

    expect(finding?.value).toBeCloseTo(1);
    expect(finding?.taskIds).toEqual(expect.arrayContaining(["scheduled", "completed-recent"]));
    expect(finding?.taskIds).not.toContain("completed-old");
  });

  it("handles empty task and project lists without throwing", () => {
    const findings = computeGtdHealthFindings([], [], now);

    expect(findings.every((finding) => finding.value === 0)).toBe(true);
  });
});
