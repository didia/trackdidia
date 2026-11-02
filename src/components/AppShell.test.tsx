import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { defaultAppSettings } from "../domain/daily-entry";
import { inertSyncController } from "../app/use-multi-device-sync";
import { renderWithApp } from "../test/test-utils";
import { AppShell } from "./AppShell";

describe("AppShell finance nav gating", () => {
  it("hides the Finances nav link when financeEnabled is false", async () => {
    await renderWithApp(
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<p>today</p>} />
        </Route>
      </Routes>,
      { contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: false } } },
    );

    expect(screen.queryByRole("link", { name: "Finances" })).not.toBeInTheDocument();
  });

  it("shows the Finances nav link when financeEnabled is true", async () => {
    await renderWithApp(
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<p>today</p>} />
        </Route>
      </Routes>,
      { contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } } },
    );

    expect(screen.getByRole("link", { name: "Finances" })).toBeInTheDocument();
  });
});

describe("AppShell sync nav gating", () => {
  const shell = (contextOverrides: Parameters<typeof renderWithApp>[1]) =>
    renderWithApp(
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<p>today</p>} />
        </Route>
      </Routes>,
      contextOverrides,
    );

  it("lists Synchronisation only with debug mode AND sync enabled", async () => {
    for (const [debugEnabled, multiDeviceSyncEnabled, shown] of [
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false],
    ] as const) {
      const view = await shell({
        contextOverrides: {
          debugEnabled,
          settings: { ...defaultAppSettings(), multiDeviceSyncEnabled },
        },
      });
      expect(
        screen.queryByRole("link", { name: "Synchronisation" }) !== null,
        `debug=${debugEnabled} enabled=${multiDeviceSyncEnabled}`,
      ).toBe(shown);
      view.unmount();
    }
  });

  it("links to /sync", async () => {
    await shell({
      contextOverrides: {
        debugEnabled: true,
        settings: { ...defaultAppSettings(), multiDeviceSyncEnabled: true },
      },
    });
    expect(screen.getByRole("link", { name: "Synchronisation" })).toHaveAttribute("href", "/sync");
  });
});

describe("AppShell sync status chip", () => {
  it("shows the chip beside the brand only with debug mode AND sync enabled", async () => {
    for (const [debugEnabled, multiDeviceSyncEnabled, shown] of [
      [true, true, true],
      [true, false, false],
      [false, true, false],
    ] as const) {
      const view = await renderWithApp(
        <Routes>
          <Route path="/" element={<AppShell />}>
            <Route index element={<p>today</p>} />
          </Route>
        </Routes>,
        {
          contextOverrides: {
            debugEnabled,
            browserPreview: false,
            settings: { ...defaultAppSettings(), multiDeviceSyncEnabled },
            sync: { ...inertSyncController, supported: true },
          },
        },
      );
      expect(
        document.querySelector(".sync-chip") !== null,
        `debug=${debugEnabled} enabled=${multiDeviceSyncEnabled}`,
      ).toBe(shown);
      view.unmount();
    }
  });
});
