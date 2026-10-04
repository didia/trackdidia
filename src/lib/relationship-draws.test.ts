import { defaultAppSettings } from "../domain/settings";
import type { Task } from "../domain/types";
import { createTaskFromInput } from "./gtd/engine";
import {
  buildDailyRelationshipDrawPlan,
  relationshipPersonalContextId,
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
