import { buildGoogleTasksImport } from "./google-tasks-import";

describe("buildGoogleTasksImport", () => {
  it("normalizes Google lists into GTD buckets, contexts, and projects", () => {
    const result = buildGoogleTasksImport({
      items: [
        {
          id: "list-1",
          title: "Next Tech Articles to Read",
          items: [
            {
              id: "task-1",
              title: "Lire article vector db",
              status: "needsAction",
              scheduled_time: [{ current: true, start: "2026-03-31T10:00:00.000Z" }],
              updated: "2026-03-31T10:00:00.000Z"
            }
          ]
        },
        {
          id: "list-2",
          title: "Projects - AfricaHeroes",
          items: [
            {
              id: "project-1",
              title: "Lancer la nouvelle cohort",
              status: "needsAction",
              updated: "2026-03-31T10:00:00.000Z"
            }
          ]
        }
      ]
    });

    expect(result.tasks[0]).toMatchObject({
      bucket: "scheduled",
      contextIds: expect.arrayContaining(["context:reading", "context:tech"]),
      scheduledFor: "2026-03-31T10:00:00.000Z"
    });
    expect(result.projects[0]).toMatchObject({
      title: "Lancer la nouvelle cohort",
      contextIds: ["context:africaheroes"],
      statusChangedAt: "2026-03-31T10:00:00.000Z"
    });
    expect(result.contexts.map((context) => context.name)).toEqual(
      expect.arrayContaining(["Reading", "Tech", "AfricaHeroes"])
    );
  });

  it("collapses recurring active tasks into a single latest task", () => {
    const result = buildGoogleTasksImport({
      items: [
        {
          id: "list-1",
          title: "Next Actions - Perso (3)",
          items: [
            {
              id: "task-old",
              title: "Retro hebdomadaire",
              status: "needsAction",
              task_recurrence_id: "rec-1",
              scheduled_time: [{ current: true, start: "2026-03-22T10:00:00.000Z" }],
              updated: "2026-03-22T10:00:00.000Z"
            },
            {
              id: "task-new",
              title: "Retro hebdomadaire",
              status: "needsAction",
              task_recurrence_id: "rec-1",
              scheduled_time: [{ current: true, start: "2026-03-29T10:00:00.000Z" }],
              updated: "2026-03-29T10:00:00.000Z"
            }
          ]
        }
      ]
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: "google-recurrence:rec-1",
      sourceExternalId: "rec-1",
      recurrenceGroupId: "rec-1",
      pendingPastRecurrences: 1,
      scheduledFor: "2026-03-29T10:00:00.000Z"
    });
  });
});
