import type { RecurringTaskTemplate, Task } from "../../domain/types";
import { addDays, toLocalDateString } from "../date";
import {
  buildRecurringPreviewOccurrences,
  cancelActiveTaskForTemplate,
  createRecurringTemplate,
  findProcessingStartDate,
  listDueDatesBetween,
  mergeOccurrenceEdit,
  planDueRecurrenceGeneration,
  planRecurrencePreparation,
  planTemplateUpdateOnTaskClose,
  prepareRecurringGeneration,
  syncActiveTaskWithTemplate,
} from "./engine";

const NOW = "2026-04-10T15:00:00.000Z";

const buildActiveInstance = (
  template: RecurringTaskTemplate,
  overrides: Partial<Task> = {},
): Task => ({
  id: `recurring-task:${template.id}`,
  title: template.title,
  notes: template.notes,
  status: "active",
  bucket: template.targetBucket,
  contextIds: [...template.contextIds],
  projectId: template.projectId,
  parentTaskId: null,
  scheduledFor: null,
  deadline: null,
  recurringTemplateId: template.id,
  recurrenceDueDate: "2026-04-03",
  isRecurringInstance: true,
  completedAt: null,
  recurrenceGroupId: null,
  pendingPastRecurrences: 0,
  plannedOrder: null,
  source: "manual",
  sourceExternalId: null,
  sourceUrl: null,
  createdAt: "2026-04-03T12:00:00.000Z",
  updatedAt: "2026-04-03T12:00:00.000Z",
  ...overrides,
});

describe("recurring engine", () => {
  it("generates weekly due dates on the selected weekdays", () => {
    const template = createRecurringTemplate({
      title: "Revue hebdo",
      startDate: "2026-04-01",
      ruleType: "weekly",
      weeklyInterval: 1,
      weeklyDays: [0, 3],
    });

    expect(listDueDatesBetween(template, "2026-04-01", "2026-04-12")).toEqual([
      "2026-04-01",
      "2026-04-05",
      "2026-04-08",
      "2026-04-12",
    ]);
  });

  it("supports nth weekday monthly rules like first saturday", () => {
    const template = createRecurringTemplate({
      title: "Planification mensuelle",
      startDate: "2026-04-01",
      ruleType: "monthly",
      monthlyMode: "nth_weekday",
      nthWeek: 1,
      weekday: 6,
    });

    expect(listDueDatesBetween(template, "2026-04-01", "2026-06-30")).toEqual([
      "2026-04-04",
      "2026-05-02",
      "2026-06-06",
    ]);
  });

  it("builds future previews without duplicating the active real occurrence", () => {
    const template = createRecurringTemplate({
      id: "recurring-template:1",
      title: "Dashboard",
      startDate: "2026-04-01",
      ruleType: "daily",
      dailyInterval: 1,
      targetBucket: "next_action",
    });

    const tasks: Task[] = [
      {
        id: "recurring-task:1",
        title: "Dashboard",
        notes: "",
        status: "active",
        bucket: "next_action",
        contextIds: [],
        projectId: null,
        parentTaskId: null,
        scheduledFor: null,
        deadline: null,
        recurringTemplateId: "recurring-template:1",
        recurrenceDueDate: "2026-04-01",
        isRecurringInstance: true,
        completedAt: null,
        recurrenceGroupId: null,
        pendingPastRecurrences: 0,
        plannedOrder: null,
        source: "manual",
        sourceExternalId: null,
        sourceUrl: null,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
    ];

    const previews = buildRecurringPreviewOccurrences(
      [template],
      tasks,
      "2026-04-01",
      "2026-04-03",
    );

    expect(previews.map((preview) => preview.dueDate)).toEqual(["2026-04-02", "2026-04-03"]);
  });

  it("subtracts future occurrences when rewinding an active premature instance", () => {
    const template = createRecurringTemplate({
      id: "recurring-template:matin",
      title: "Routine du matin",
      startDate: "2026-08-01",
      ruleType: "daily",
      dailyInterval: 1,
      lastGeneratedForDate: "2026-09-27",
      pendingMissedOccurrences: 26,
    });
    const instance: Task = {
      id: "recurring-task:recurring-template:matin",
      title: "Routine du matin",
      notes: "",
      status: "active",
      bucket: "next_action",
      contextIds: [],
      projectId: null,
      parentTaskId: null,
      scheduledFor: null,
      deadline: null,
      recurringTemplateId: template.id,
      recurrenceDueDate: "2026-09-27",
      isRecurringInstance: true,
      completedAt: null,
      recurrenceGroupId: null,
      pendingPastRecurrences: 26,
      plannedOrder: null,
      source: "manual",
      sourceExternalId: null,
      sourceUrl: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
    };

    const prepared = prepareRecurringGeneration(template, instance, "2026-09-08");
    const futureCount = listDueDatesBetween(template, "2026-09-09", "2026-09-27").length;

    expect(prepared.changed).toBe(true);
    expect(prepared.template.lastGeneratedForDate).toBe("2026-09-08");
    expect(prepared.template.pendingMissedOccurrences).toBe(26 - futureCount);
    expect(prepared.instance).toMatchObject({
      status: "active",
      recurrenceDueDate: "2026-09-08",
      pendingPastRecurrences: 26 - futureCount,
    });
  });

  it("cancels a premature instance when the template has not started yet", () => {
    const template = createRecurringTemplate({
      id: "recurring-template:future",
      title: "Future start",
      startDate: "2026-09-11",
      ruleType: "daily",
      dailyInterval: 1,
      lastGeneratedForDate: "2026-09-11",
    });
    const instance: Task = {
      id: "recurring-task:recurring-template:future",
      title: "Future start",
      notes: "",
      status: "active",
      bucket: "next_action",
      contextIds: [],
      projectId: null,
      parentTaskId: null,
      scheduledFor: null,
      deadline: null,
      recurringTemplateId: template.id,
      recurrenceDueDate: "2026-09-11",
      isRecurringInstance: true,
      completedAt: null,
      recurrenceGroupId: null,
      pendingPastRecurrences: 0,
      plannedOrder: null,
      source: "manual",
      sourceExternalId: null,
      sourceUrl: null,
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:00.000Z",
    };

    const prepared = prepareRecurringGeneration(template, instance, "2026-09-07");

    expect(prepared.changed).toBe(true);
    expect(prepared.template.lastGeneratedForDate).toBeNull();
    expect(prepared.template.pendingMissedOccurrences).toBe(0);
    expect(prepared.instance).toMatchObject({
      status: "cancelled",
      pendingPastRecurrences: 0,
    });
  });
});

describe("recurrence generation planners", () => {
  const dailyTemplate = (overrides: Partial<RecurringTaskTemplate> = {}) =>
    createRecurringTemplate({
      id: "recurring-template:daily",
      title: "Daily",
      notes: "template notes",
      startDate: "2026-04-01",
      ruleType: "daily",
      dailyInterval: 1,
      ...overrides,
    });

  it("collapses multiple missed days into one new instance on the latest due date", () => {
    const template = dailyTemplate();

    const plan = planDueRecurrenceGeneration(template, null, "2026-04-05", NOW);

    expect(plan).not.toBeNull();
    expect(plan?.previousTask).toBeNull();
    expect(plan?.nextTask).toMatchObject({
      id: "recurring-task:recurring-template:daily",
      status: "active",
      recurrenceDueDate: "2026-04-05",
      pendingPastRecurrences: 4,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(plan?.templatePatch).toEqual({
      lastGeneratedForDate: "2026-04-05",
      pendingMissedOccurrences: 4,
      updatedAt: NOW,
    });
  });

  it("starts after lastGeneratedForDate and skips already generated days", () => {
    const template = dailyTemplate({ lastGeneratedForDate: "2026-04-03" });

    const plan = planDueRecurrenceGeneration(template, null, "2026-04-05", NOW);

    expect(plan?.nextTask.recurrenceDueDate).toBe("2026-04-05");
    expect(plan?.nextTask.pendingPastRecurrences).toBe(1);
  });

  it("returns null when nothing is due", () => {
    const template = dailyTemplate({ lastGeneratedForDate: "2026-04-05" });

    expect(planDueRecurrenceGeneration(template, null, "2026-04-05", NOW)).toBeNull();
  });

  it("advances a still-open active instance and accumulates the missed count", () => {
    const template = dailyTemplate({
      contextIds: ["context:new"],
      projectId: "project:new",
    });
    const active = buildActiveInstance(template, {
      title: "Renamed occurrence",
      notes: "occurrence notes",
      contextIds: ["context:old"],
      projectId: null,
      recurrenceDueDate: "2026-04-03",
      pendingPastRecurrences: 2,
    });

    const plan = planDueRecurrenceGeneration(template, active, "2026-04-06", NOW);

    expect(plan?.previousTask).toEqual(active);
    expect(plan?.previousTask).not.toBe(active);
    expect(plan?.nextTask).toMatchObject({
      recurrenceDueDate: "2026-04-06",
      // 2 already pending + 3 newly due dates (04-04, 04-05, 04-06).
      pendingPastRecurrences: 5,
      updatedAt: NOW,
      createdAt: active.createdAt,
      title: "Renamed occurrence",
      notes: "occurrence notes",
      contextIds: ["context:new"],
      projectId: "project:new",
    });
    expect(plan?.templatePatch.pendingMissedOccurrences).toBe(5);
    expect(plan?.templatePatch.lastGeneratedForDate).toBe("2026-04-06");
    expect(active.recurrenceDueDate).toBe("2026-04-03");
  });

  it("does not regenerate while an open instance already sits on the horizon", () => {
    const template = dailyTemplate({ lastGeneratedForDate: "2026-04-03" });
    const active = buildActiveInstance(template, { recurrenceDueDate: "2026-04-03" });

    expect(planDueRecurrenceGeneration(template, active, "2026-04-03", NOW)).toBeNull();
  });

  it("uses the later of template start, watermark, and active due date as the start", () => {
    const template = dailyTemplate({ lastGeneratedForDate: "2026-04-02" });
    const active = buildActiveInstance(template, { recurrenceDueDate: "2026-04-07" });

    expect(findProcessingStartDate(template, null)).toBe("2026-04-03");
    expect(findProcessingStartDate(template, active)).toBe("2026-04-08");
    expect(findProcessingStartDate(dailyTemplate(), null)).toBe("2026-04-01");
  });

  it("does not materialize a template that starts in the future", () => {
    const template = dailyTemplate({ startDate: "2026-05-01" });

    expect(planDueRecurrenceGeneration(template, null, "2026-04-30", NOW)).toBeNull();
    expect(findProcessingStartDate(template, null)).toBe("2026-05-01");

    const plan = planDueRecurrenceGeneration(template, null, "2026-05-01", NOW);
    expect(plan?.nextTask.recurrenceDueDate).toBe("2026-05-01");
    expect(plan?.nextTask.pendingPastRecurrences).toBe(0);
  });

  it("builds a scheduled instance with a local scheduledFor time", () => {
    const template = dailyTemplate({ targetBucket: "scheduled", scheduledTime: "09:30" });

    const plan = planDueRecurrenceGeneration(template, null, "2026-04-02", NOW);
    const scheduledFor = new Date(plan?.nextTask.scheduledFor ?? "");

    expect(plan?.nextTask.bucket).toBe("scheduled");
    expect(toLocalDateString(scheduledFor)).toBe("2026-04-02");
    expect(scheduledFor.getHours()).toBe(9);
    expect(scheduledFor.getMinutes()).toBe(30);
  });

  it("leaves next_action instances unscheduled even when the template has a time", () => {
    const template = dailyTemplate({ targetBucket: "next_action", scheduledTime: "09:30" });

    const plan = planDueRecurrenceGeneration(template, null, "2026-04-02", NOW);

    expect(plan?.nextTask.bucket).toBe("next_action");
    expect(plan?.nextTask.scheduledFor).toBeNull();
  });

  it("re-derives bucket and scheduledFor when an active instance advances", () => {
    const scheduled = dailyTemplate({ targetBucket: "scheduled", scheduledTime: "18:00" });
    const active = buildActiveInstance(scheduled, {
      bucket: "next_action",
      scheduledFor: null,
      recurrenceDueDate: "2026-04-03",
    });

    const toScheduled = planDueRecurrenceGeneration(scheduled, active, "2026-04-04", NOW);
    expect(toScheduled?.nextTask.bucket).toBe("scheduled");
    expect(new Date(toScheduled?.nextTask.scheduledFor ?? "").getHours()).toBe(18);
    expect(toLocalDateString(toScheduled?.nextTask.scheduledFor ?? "")).toBe("2026-04-04");

    const nextAction = dailyTemplate({ targetBucket: "next_action", scheduledTime: "18:00" });
    const scheduledActive = buildActiveInstance(nextAction, {
      bucket: "scheduled",
      scheduledFor: "2026-04-03T22:00:00.000Z",
    });
    const toNextAction = planDueRecurrenceGeneration(
      nextAction,
      scheduledActive,
      "2026-04-04",
      NOW,
    );
    expect(toNextAction?.nextTask.bucket).toBe("next_action");
    expect(toNextAction?.nextTask.scheduledFor).toBeNull();
  });

  describe("DST transitions (America/Toronto)", () => {
    it("lists exactly one daily due date per local day across spring forward", () => {
      const template = dailyTemplate({ startDate: "2026-03-06" });

      expect(listDueDatesBetween(template, "2026-03-06", "2026-03-10")).toEqual([
        "2026-03-06",
        "2026-03-07",
        "2026-03-08",
        "2026-03-09",
        "2026-03-10",
      ]);
      expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
      expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    });

    it("lists exactly one daily due date per local day across fall back", () => {
      const template = dailyTemplate({ startDate: "2026-10-30" });

      expect(listDueDatesBetween(template, "2026-10-30", "2026-11-03")).toEqual([
        "2026-10-30",
        "2026-10-31",
        "2026-11-01",
        "2026-11-02",
        "2026-11-03",
      ]);
      expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    });

    it("counts missed days across the transition without double counting", () => {
      const template = dailyTemplate({ startDate: "2026-03-06" });

      const plan = planDueRecurrenceGeneration(template, null, "2026-03-10", NOW);

      expect(plan?.nextTask.recurrenceDueDate).toBe("2026-03-10");
      expect(plan?.nextTask.pendingPastRecurrences).toBe(4);
      expect(
        findProcessingStartDate({ ...template, lastGeneratedForDate: "2026-03-07" }, null),
      ).toBe("2026-03-08");
    });

    it("keeps the local wall-clock time of a scheduled occurrence on the transition day", () => {
      const template = dailyTemplate({
        startDate: "2026-03-08",
        targetBucket: "scheduled",
        scheduledTime: "09:30",
      });

      const plan = planDueRecurrenceGeneration(template, null, "2026-03-08", NOW);
      const scheduledFor = new Date(plan?.nextTask.scheduledFor ?? "");

      expect(toLocalDateString(scheduledFor)).toBe("2026-03-08");
      expect(scheduledFor.getHours()).toBe(9);
      expect(scheduledFor.getMinutes()).toBe(30);
    });

    it("keeps weekly occurrences on the same weekday across the fall back", () => {
      const template = createRecurringTemplate({
        title: "Weekly",
        startDate: "2026-10-25",
        ruleType: "weekly",
        weeklyDays: [0],
        weeklyInterval: 1,
      });

      expect(listDueDatesBetween(template, "2026-10-25", "2026-11-08")).toEqual([
        "2026-10-25",
        "2026-11-01",
        "2026-11-08",
      ]);
    });
  });
});

describe("recurrence lifecycle planners", () => {
  const template = createRecurringTemplate({
    id: "recurring-template:life",
    title: "Life",
    startDate: "2026-04-01",
    ruleType: "daily",
    lastGeneratedForDate: "2026-04-02",
    pendingMissedOccurrences: 3,
  });

  it("advances the watermark and clears pending on completion", () => {
    const closed = buildActiveInstance(template, {
      recurrenceDueDate: "2026-04-05",
      pendingPastRecurrences: 3,
    });

    const next = planTemplateUpdateOnTaskClose(template, closed, "completed", NOW);

    expect(next).toMatchObject({
      lastGeneratedForDate: "2026-04-05",
      pendingMissedOccurrences: 0,
      updatedAt: NOW,
    });
    expect(template.lastGeneratedForDate).toBe("2026-04-02");
  });

  it("never moves the watermark backwards on completion", () => {
    const closed = buildActiveInstance(template, { recurrenceDueDate: "2026-04-01" });

    expect(
      planTemplateUpdateOnTaskClose(template, closed, "completed", NOW).lastGeneratedForDate,
    ).toBe("2026-04-02");
  });

  it("keeps the watermark and clears pending on cancellation", () => {
    const closed = buildActiveInstance(template, { recurrenceDueDate: "2026-04-09" });

    const next = planTemplateUpdateOnTaskClose(template, closed, "cancelled", NOW);

    expect(next).toMatchObject({
      lastGeneratedForDate: "2026-04-02",
      pendingMissedOccurrences: 0,
      updatedAt: NOW,
    });
  });

  it("merges only the provided occurrence fields", () => {
    const task = buildActiveInstance(template, {
      scheduledFor: "2026-04-03T13:00:00.000Z",
      deadline: "2026-04-04",
      projectId: "project:a",
    });

    const merged = mergeOccurrenceEdit(task, {
      title: "Only this one",
      projectId: null,
      deadline: null,
    });

    expect(merged).toMatchObject({
      title: "Only this one",
      notes: task.notes,
      projectId: null,
      deadline: null,
      scheduledFor: "2026-04-03T13:00:00.000Z",
      bucket: task.bucket,
    });
    expect(mergeOccurrenceEdit(task, {})).toEqual(task);
  });

  it("resyncs title, notes, contexts, and project from the template", () => {
    const edited = createRecurringTemplate({
      ...template,
      title: "Template title",
      notes: "Template notes",
      contextIds: ["context:a"],
      projectId: "project:a",
      targetBucket: "next_action",
    });
    const task = buildActiveInstance(template, {
      title: "Drifted",
      notes: "Drifted notes",
      contextIds: ["context:b"],
      projectId: "project:b",
      bucket: "scheduled",
      scheduledFor: "2026-04-03T13:00:00.000Z",
    });

    expect(syncActiveTaskWithTemplate(task, edited, NOW)).toMatchObject({
      title: "Template title",
      notes: "Template notes",
      contextIds: ["context:a"],
      projectId: "project:a",
      bucket: "next_action",
      scheduledFor: null,
      updatedAt: NOW,
    });
  });

  it("cancels the active task without touching other fields", () => {
    const task = buildActiveInstance(template);

    expect(cancelActiveTaskForTemplate(task, NOW)).toEqual({
      ...task,
      status: "cancelled",
      updatedAt: NOW,
    });
  });

  it("reports no change when the stored watermark is already consistent", () => {
    const stable = createRecurringTemplate({
      ...template,
      lastGeneratedForDate: "2026-04-05",
    });
    const active = buildActiveInstance(stable, { recurrenceDueDate: "2026-04-05" });

    const prepared = planRecurrencePreparation(stable, active, "2026-04-05", NOW);

    expect(prepared.templateChanged).toBe(false);
    expect(prepared.instanceUpdate).toBeNull();
    expect(prepared.template).toBe(stable);
    expect(prepared.activeTask).toBe(active);
  });

  it("returns the rewound instance and stamps timestamps when preparing", () => {
    const premature = createRecurringTemplate({
      id: "recurring-template:future",
      title: "Future",
      startDate: "2026-09-11",
      ruleType: "daily",
      lastGeneratedForDate: "2026-09-11",
    });
    const instance = buildActiveInstance(premature, { recurrenceDueDate: "2026-09-11" });

    const prepared = planRecurrencePreparation(premature, instance, "2026-09-07", NOW);

    expect(prepared.templateChanged).toBe(true);
    expect(prepared.template).toMatchObject({ lastGeneratedForDate: null, updatedAt: NOW });
    expect(prepared.activeTask).toBeNull();
    expect(prepared.instanceUpdate?.previousTask).toEqual(instance);
    expect(prepared.instanceUpdate?.nextTask).toMatchObject({
      status: "cancelled",
      updatedAt: NOW,
    });
  });
});
