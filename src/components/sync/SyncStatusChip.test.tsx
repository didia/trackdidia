import { screen } from "@testing-library/react";
import { defaultAppSettings } from "../../domain/daily-entry";
import { inertSyncController } from "../../app/use-multi-device-sync";
import type { SyncChip } from "../../lib/sync/lifecycle-policy";
import { renderWithApp } from "../../test/test-utils";
import { SyncStatusChip } from "./SyncStatusChip";

const chipView = (
  chip: SyncChip,
  overrides: {
    debugEnabled?: boolean;
    multiDeviceSyncEnabled?: boolean;
    supported?: boolean;
    browserPreview?: boolean;
  } = {},
) =>
  renderWithApp(<SyncStatusChip />, {
    contextOverrides: {
      debugEnabled: overrides.debugEnabled ?? true,
      browserPreview: overrides.browserPreview ?? false,
      settings: {
        ...defaultAppSettings(),
        multiDeviceSyncEnabled: overrides.multiDeviceSyncEnabled ?? true,
      },
      sync: { ...inertSyncController, supported: overrides.supported ?? true, chip },
    },
  });

describe("SyncStatusChip", () => {
  it.each([
    ["syncing", "Synchronisation…"],
    ["error", "Erreur de synchro"],
    ["backfill", "Initialisation du suivi"],
    ["paused", "Synchro en pause"],
  ] as const)("shows the %s state in French and links to /sync", async (state, text) => {
    await chipView({ state, lastOkAtMs: null, retryAtMs: null });
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/sync");
    expect(link).toHaveAttribute("data-state", state);
    expect(screen.getByRole("status")).toHaveTextContent(text);
  });

  it("says when it was last up to date, or just that it is", async () => {
    const view = await chipView({ state: "idle", lastOkAtMs: null, retryAtMs: null });
    expect(screen.getByRole("status")).toHaveTextContent("À jour");
    view.unmount();
    await chipView({ state: "idle", lastOkAtMs: Date.now() - 5 * 60_000, retryAtMs: null });
    expect(screen.getByRole("status")).toHaveTextContent(/À jour depuis 5 min/);
  });

  it("names the time of the next try while an error is backing off", async () => {
    await chipView({
      state: "error",
      lastOkAtMs: null,
      retryAtMs: new Date(2026, 10, 2, 14, 7).getTime(),
    });
    expect(screen.getByRole("status")).toHaveTextContent("Erreur de synchro, nouvel essai à 14:07");
    expect(screen.getByRole("link")).toHaveAccessibleName(/Ouvrir la page Synchronisation/);
  });

  it("renders nothing with sync off, in browser preview, or when unsupported", async () => {
    for (const overrides of [
      { multiDeviceSyncEnabled: false },
      { browserPreview: true },
      { supported: false },
    ]) {
      const view = await chipView(
        { state: "syncing", lastOkAtMs: null, retryAtMs: null },
        overrides,
      );
      expect(screen.queryByRole("link"), JSON.stringify(overrides)).toBeNull();
      view.unmount();
    }
  });
});
