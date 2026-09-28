import type { Task } from "../../domain/types";
import {
  buildRecurringPreviewOccurrences,
  createRecurringTemplate,
  listDueDatesBetween,
  prepareRecurringGeneration,
} from "./engine";

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
