import { describe, expect, it } from "vitest";
import { defaultEmailTriageGlobalSettings } from "../../domain/email-triage";
import { EmailTriageMemoryStore } from "./email-triage-memory-store";
import { createTaskFromInput } from "../gtd/engine";

describe("email triage settings gmailOAuthClientId", () => {
  it("round-trips gmailOAuthClientId in memory store", () => {
    const store = new EmailTriageMemoryStore({
      getTaskByExternalId: () => undefined,
      createTask: (input) => createTaskFromInput(input),
      saveTask: (task) => task,
      persistEvents: () => undefined,
      getTaskById: () => undefined,
    });
    store.saveGlobalSettings({
      ...defaultEmailTriageGlobalSettings(),
      gmailOAuthClientId: "client-id.apps.googleusercontent.com",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(store.getGlobalSettings().gmailOAuthClientId).toBe(
      "client-id.apps.googleusercontent.com",
    );
  });
});
