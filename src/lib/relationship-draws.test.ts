import { defaultAppSettings } from "../domain/settings";
import type { Task } from "../domain/types";
import { createTaskFromInput } from "./gtd/engine";
import {
  buildDailyRelationshipDrawPlan,
  buildRelationshipDrawTaskId,
  getRelationshipDrawSeed,
  pickRelationshipDrawActivity,
  relationshipPersonalContextId,
  seededUnit,
} from "./relationship-draws";

const settings = () => ({
  ...defaultAppSettings(),
  relationshipDrawsEnabled: true,
  relationshipDrawChildrenActivities: ["jouer"],
  relationshipDrawSpouseActivities: ["diner"],
});

const activeDrawTask = (category: "children" | "spouse"): Task =>
  createTaskFromInput({
    title: "existing",
    bucket: "next_action",
    contextIds: [],
    sourceExternalId: `relationship-draw:${category}:2026-10-01`,
  });

describe("buildDailyRelationshipDrawPlan", () => {
  it("plans one task per category and advances both processed markers", () => {
    const plan = buildDailyRelationshipDrawPlan("2026-10-03", settings(), []);

    expect(plan.taskInputs).toHaveLength(2);
    expect(plan.taskInputs.map((input) => input.sourceExternalId)).toEqual([
      "relationship-draw:children:2026-10-03",
      "relationship-draw:spouse:2026-10-03",
    ]);
    expect(plan.taskInputs[0]).toMatchObject({
      bucket: "next_action",
      source: "manual",
      contextIds: [relationshipPersonalContextId],
    });
    expect(plan.settings.relationshipDrawChildrenProcessedDate).toBe("2026-10-03");
    expect(plan.settings.relationshipDrawSpouseProcessedDate).toBe("2026-10-03");
  });

  it("stamps createdAt/updatedAt at UTC midnight of the draw date", () => {
    const [input] = buildDailyRelationshipDrawPlan("2026-10-03", settings(), []).taskInputs;
    expect(input.createdAt).toBe("2026-10-03T00:00:00.000Z");
    expect(input.updatedAt).toBe("2026-10-03T00:00:00.000Z");
  });

  it("does not mutate the input settings", () => {
    const input = settings();
    buildDailyRelationshipDrawPlan("2026-10-03", input, []);
    expect(input.relationshipDrawChildrenProcessedDate).toBe("");
  });

  it("returns the same settings object and no tasks when draws are disabled", () => {
    const input = { ...settings(), relationshipDrawsEnabled: false };
    const plan = buildDailyRelationshipDrawPlan("2026-10-03", input, []);
    expect(plan.taskInputs).toEqual([]);
    expect(plan.settings).toBe(input);
  });

  it("skips categories already processed for the day or a later day", () => {
    const input = {
      ...settings(),
      relationshipDrawChildrenProcessedDate: "2026-10-03",
      relationshipDrawSpouseProcessedDate: "2026-10-10",
    };
    const plan = buildDailyRelationshipDrawPlan("2026-10-03", input, []);
    expect(plan.taskInputs).toEqual([]);
    expect(plan.settings).toEqual(input);
  });

  it("creates nothing for a category with an active draw task but still marks it processed", () => {
    const plan = buildDailyRelationshipDrawPlan("2026-10-03", settings(), [
      activeDrawTask("children"),
    ]);
    expect(plan.taskInputs.map((input) => input.sourceExternalId)).toEqual([
      "relationship-draw:spouse:2026-10-03",
    ]);
    expect(plan.settings.relationshipDrawChildrenProcessedDate).toBe("2026-10-03");
  });

  it("leaves a category unmarked when it has no activities to draw", () => {
    const input = { ...settings(), relationshipDrawChildrenActivities: [] };
    const plan = buildDailyRelationshipDrawPlan("2026-10-03", input, []);
    expect(plan.taskInputs).toHaveLength(1);
    expect(plan.settings.relationshipDrawChildrenProcessedDate).toBe("");
    expect(plan.settings.relationshipDrawSpouseProcessedDate).toBe("2026-10-03");
  });
});

// Computed independently (Python) from the documented algorithm: FNV-1a 32, then mulberry32.
const PINNED = ["0.774606", "0.437173", "0.816066"];

describe("deterministic draws", () => {
  const ACTIVITIES = ["jouer", "lire", "dessiner", "cuisiner", "marcher", "chanter", "danser"];

  it("derives the task id from the source_external_id, so two laptops mint one row", () => {
    const [input] = buildDailyRelationshipDrawPlan("2026-10-03", settings(), []).taskInputs;
    expect(input.id).toBe("task:relationship-draw:children:2026-10-03");
    expect(input.id).toBe(buildRelationshipDrawTaskId("children", "2026-10-03"));
    expect(`task:${input.sourceExternalId}`).toBe(input.id);
  });

  it("plans the identical inputs for the same list, category and date, every time", () => {
    const first = buildDailyRelationshipDrawPlan("2026-10-03", settings(), []);
    const second = buildDailyRelationshipDrawPlan("2026-10-03", settings(), []);
    expect(second.taskInputs).toEqual(first.taskInputs);
    const wide = { ...settings(), relationshipDrawChildrenActivities: ACTIVITIES };
    const titles = new Set(
      Array.from({ length: 20 }, () => buildDailyRelationshipDrawPlan("2026-10-09", wide, [])).map(
        (plan) => plan.taskInputs[0]?.title,
      ),
    );
    expect(titles.size).toBe(1);
  });

  it("picks the same activity from the same list whatever the call", () => {
    for (const date of ["2026-10-03", "2026-12-31", "2027-02-28"]) {
      const picks = Array.from({ length: 10 }, () =>
        pickRelationshipDrawActivity([...ACTIVITIES], "spouse", date),
      );
      expect(new Set(picks).size).toBe(1);
      expect(ACTIVITIES).toContain(picks[0]);
    }
  });

  it("varies with the date and with the category", () => {
    const days = Array.from(
      { length: 60 },
      (_, index) => `2026-11-${String((index % 30) + 1).padStart(2, "0")}`,
    );
    const byDate = new Set(
      days.map((date) => pickRelationshipDrawActivity(ACTIVITIES, "children", date)),
    );
    expect(byDate.size).toBeGreaterThan(3);
    const apart = days.filter(
      (date) =>
        pickRelationshipDrawActivity(ACTIVITIES, "children", date) !==
        pickRelationshipDrawActivity(ACTIVITIES, "spouse", date),
    );
    expect(apart.length).toBeGreaterThan(days.length / 2);
  });

  it("spreads over the whole list", () => {
    const seen = new Set<string | null>();
    for (let day = 1; day <= 28; day += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const date = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        seen.add(pickRelationshipDrawActivity(ACTIVITIES, "children", date));
      }
    }
    expect([...seen].sort()).toEqual([...ACTIVITIES].sort());
  });

  it("returns null for an empty list and the only entry for a single one", () => {
    expect(pickRelationshipDrawActivity([], "children", "2026-10-03")).toBeNull();
    expect(pickRelationshipDrawActivity(["seul"], "children", "2026-10-03")).toBe("seul");
  });

  it("is a fixed function of the seed text (the algorithm is part of the sync contract)", () => {
    expect(getRelationshipDrawSeed("children", "2026-10-03")).toBe("children:2026-10-03");
    expect(seededUnit("children:2026-10-03")).toBe(seededUnit("children:2026-10-03"));
    expect(seededUnit("children:2026-10-03")).toBeGreaterThanOrEqual(0);
    expect(seededUnit("children:2026-10-03")).toBeLessThan(1);
    // Pinned values: changing the hash or the generator would make two laptops on different
    // versions draw different activities for the same day.
    expect(
      ["children:2026-10-03", "spouse:2026-10-03", "children:2026-10-04"].map((seed) =>
        seededUnit(seed).toFixed(6),
      ),
    ).toEqual(PINNED);
  });

  it("does not draw a day that already has a row, whatever its status", () => {
    const completed = createTaskFromInput({
      id: "task:random-old",
      title: "old draw",
      bucket: "next_action",
      contextIds: [],
      sourceExternalId: "relationship-draw:children:2026-10-03",
    });
    completed.status = "completed";
    const plan = buildDailyRelationshipDrawPlan("2026-10-03", settings(), [completed]);
    expect(plan.taskInputs.map((input) => input.sourceExternalId)).toEqual([
      "relationship-draw:spouse:2026-10-03",
    ]);
    expect(plan.settings.relationshipDrawChildrenProcessedDate).toBe("2026-10-03");
  });
});
