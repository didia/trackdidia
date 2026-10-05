import type { AiProposal } from "../../../domain/types";
import { createTaskFromInput } from "../../gtd/engine";
import { gtdAcceptEffectFromProposal, taskForAcceptEffect } from "./accept-effect";

it("keeps a planned task planned when scheduling and preserves its unrelated fields", () => {
  const task = createTaskFromInput({
    title: "planned",
    notes: "keep",
    bucket: "planned",
    contextIds: ["context:test"],
    projectId: "project:test",
  });
  const next = taskForAcceptEffect(task, {
    kind: "gtdTask",
    taskId: task.id,
    action: "schedule",
    scheduledDate: "2026-08-02",
  });
  expect(next).toMatchObject({
    bucket: "planned",
    scheduledFor: "2026-08-02",
    contextIds: task.contextIds,
    notes: "keep",
    projectId: "project:test",
  });
  expect(task.scheduledFor).toBeNull();
});

it.each(["completed", "cancelled"] as const)("does not apply an effect to a %s task", (status) => {
  const task = {
    ...createTaskFromInput({ title: "inactive", bucket: "inbox", contextIds: [] }),
    status,
  };
  expect(
    taskForAcceptEffect(task, {
      kind: "gtdTask",
      taskId: task.id,
      action: "drop",
      scheduledDate: "2026-08-02",
    }),
  ).toBeNull();
});

it.each([
  "{",
  "null",
  '{"taskId":"task","action":"unknown"}',
])("treats invalid GTD payload %s as a no-op effect", (payloadJson) => {
  expect(gtdAcceptEffectFromProposal({ payloadJson } as AiProposal, "2026-08-02")).toBeNull();
});
