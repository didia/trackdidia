import type { CalendarSyncSettings } from "../../domain/calendar-sync";
import { nowIso } from "../gtd/shared";
import { createSerialQueue } from "../serial-queue";
import type { AppRepository } from "../storage/repository";

// Shared across Settings mounts: OAuth and its vault/settings commit are one mutation.
const mutations = createSerialQueue();
export const runCalendarSyncMutation = mutations.run;

export const saveCalendarSyncPreferences = (
  repository: AppRepository,
  preferences: Pick<CalendarSyncSettings, "enabled" | "oauthClientId">,
): Promise<CalendarSyncSettings> =>
  runCalendarSyncMutation(async () => {
    const current = await repository.getCalendarSyncSettings();
    return repository.saveCalendarSyncSettings({
      ...current,
      enabled: preferences.enabled,
      oauthClientId: preferences.oauthClientId.trim(),
      updatedAt: nowIso(),
    });
  });
