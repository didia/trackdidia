import { describe, expect, it } from "vitest";
import { defaultEmailTriageGlobalSettings } from "../../domain/email-triage";
import { EmailTriageMemoryStore } from "./email-triage-memory-store";
import { createTaskFromInput } from "../gtd/engine";

describe("email triage settings material classifier change", () => {
  it("clears automationEnabled when saving a changed model", () => {
    const store = new EmailTriageMemoryStore({
      getTaskByExternalId: () => undefined,
      createTask: (input) => createTaskFromInput(input),
      saveTask: (task) => task,
      persistEvents: () => undefined,
      getTaskById: () => undefined,
    });
    store.saveGlobalSettings({
      ...defaultEmailTriageGlobalSettings(),
      automationEnabled: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    store.saveGlobalSettings({
      ...store.getGlobalSettings(),
      classifierModel: "other/model",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(store.getGlobalSettings().automationEnabled).toBe(false);
  });
});
