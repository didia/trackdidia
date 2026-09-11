import { describe, expect, it } from "vitest";
import { defaultEmailTriageGlobalSettings } from "../../domain/email-triage";
import { EmailTriageMemoryStore } from "./email-triage-memory-store";
import { createTaskFromInput } from "../gtd/engine";

describe("email triage settings microsoftOAuthClientId", () => {
  it("round-trips microsoftOAuthClientId in memory store", () => {
    const store = new EmailTriageMemoryStore({
      getTaskByExternalId: () => undefined,
      createTask: (input) => createTaskFromInput(input),
      saveTask: (task) => task,
      persistEvents: () => undefined,
      getTaskById: () => undefined,
    });
    store.saveGlobalSettings({
      ...defaultEmailTriageGlobalSettings(),
      microsoftOAuthClientId: "00000000-0000-0000-0000-000000000000",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(store.getGlobalSettings().microsoftOAuthClientId).toBe(
      "00000000-0000-0000-0000-000000000000",
    );
  });
});
