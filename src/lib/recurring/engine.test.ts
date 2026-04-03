import { buildRecurringPreviewOccurrences, createRecurringTemplate, listDueDatesBetween } from "./engine";
import type { Task } from "../../domain/types";

describe("recurring engine", () => {
  it("generates weekly due dates on the selected weekdays", () => {
    const template = createRecurringTemplate({
      title: "Revue hebdo",
      startDate: "2026-04-01",
      ruleType: "weekly",
      weeklyInterval: 1,
      weeklyDays: [0, 3]
    });

    expect(listDueDatesBetween(template, "2026-04-01", "2026-04-12")).toEqual([
      "2026-04-01",
      "2026-04-05",
      "2026-04-08",
      "2026-04-12"
    ]);
  });

  it("supports nth weekday monthly rules like first saturday", () => {
    const template = createRecurringTemplate({
      title: "Planification mensuelle",
      startDate: "2026-04-01",
      ruleType: "monthly",
      monthlyMode: "nth_weekday",
      nthWeek: 1,
      weekday: 6
    });

    expect(listDueDatesBetween(template, "2026-04-01", "2026-06-30")).toEqual([
      "2026-04-04",
      "2026-05-02",
      "2026-06-06"
    ]);
  });

  it("builds future previews without duplicating the active real occurrence", () => {
    const template = createRecurringTemplate({
      id: "recurring-template:1",
      title: "Dashboard",
      startDate: "2026-04-01",
      ruleType: "daily",
      dailyInterval: 1,
      targetBucket: "next_action"
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
        source: "manual",
        sourceExternalId: null,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z"
      }
    ];

    const previews = buildRecurringPreviewOccurrences([template], tasks, "2026-04-01", "2026-04-03");

    expect(previews.map((preview) => preview.dueDate)).toEqual(["2026-04-02", "2026-04-03"]);
  });
});
