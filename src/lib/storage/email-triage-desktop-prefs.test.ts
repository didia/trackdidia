import { describe, expect, it } from "vitest";
import { defaultEmailTriageGlobalSettings } from "../../domain/email-triage";
import { EmailTriageMemoryStore } from "./email-triage-memory-store";
import { createTaskFromInput } from "../gtd/engine";

describe("email triage desktop prefs settings", () => {
  it("round-trips runInTray and launchAtLogin in memory store", () => {
    const store = new EmailTriageMemoryStore({
      getTaskByExternalId: () => undefined,
      createTask: (input) => createTaskFromInput(input),
      saveTask: (task) => task,
      persistEvents: () => undefined,
      getTaskById: () => undefined,
    });
    store.saveGlobalSettings({
      ...defaultEmailTriageGlobalSettings(),
      runInTray: true,
      launchAtLogin: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const settings = store.getGlobalSettings();
    expect(settings.runInTray).toBe(true);
    expect(settings.launchAtLogin).toBe(true);
  });
});
