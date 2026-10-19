import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithApp } from "../../test/test-utils";
import { DesktopShellSection } from "./DesktopShellSection";

const applyDesktopShellPrefsMock = vi.fn();

vi.mock("../../lib/desktop-shell", () => ({
  applyDesktopShellPrefs: (...args: unknown[]) => applyDesktopShellPrefsMock(...args),
}));

describe("DesktopShellSection", () => {
  beforeEach(() => {
    applyDesktopShellPrefsMock.mockReset();
    applyDesktopShellPrefsMock.mockResolvedValue({ autostartError: null, trayError: null });
  });

  it("is read-only in browser preview", async () => {
    await renderWithApp(<DesktopShellSection />, { contextOverrides: { browserPreview: true } });

    expect(screen.getByText("Disponible uniquement dans l'application de bureau.")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Enregistrer l'application de bureau",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("saves both preferences and applies them to the native host", async () => {
    const { repository } = await renderWithApp(<DesktopShellSection />, {
      contextOverrides: { browserPreview: false },
    });

    fireEvent.click(screen.getByLabelText("Réduire dans la barre système à la fermeture"));
    fireEvent.click(screen.getByLabelText("Lancer TrackDidia à l'ouverture de session"));
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer l'application de bureau" }));

    await waitFor(async () => {
      const saved = await repository.getSettings();
      expect(saved.runInTray).toBe(true);
      expect(saved.launchAtLogin).toBe(true);
    });
    expect(applyDesktopShellPrefsMock).toHaveBeenCalledWith(
      { runInTray: true, launchAtLogin: true },
      false,
    );
    expect(
      await screen.findByText("Préférences de l'application de bureau enregistrées."),
    ).toBeTruthy();
  });

  it("keeps the saved settings but reports a tray failure", async () => {
    applyDesktopShellPrefsMock.mockResolvedValue({ autostartError: null, trayError: "boom" });
    const { repository } = await renderWithApp(<DesktopShellSection />, {
      contextOverrides: { browserPreview: false },
    });

    fireEvent.click(screen.getByLabelText("Réduire dans la barre système à la fermeture"));
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer l'application de bureau" }));

    expect(
      await screen.findByText("Impossible d'appliquer les préférences de la barre système."),
    ).toBeTruthy();
    expect((await repository.getSettings()).runInTray).toBe(true);
  });
});
