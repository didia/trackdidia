import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { defaultAppSettings } from "../domain/daily-entry";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { SettingsPage } from "./SettingsPage";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

describe("SettingsPage finance section", () => {
  it("seeds default categories on the false -> true transition and saves settings once", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const seedSpy = vi.spyOn(repository, "seedFinanceDefaultCategories");
    const saveSettings = vi.fn().mockResolvedValue(undefined);

    const settings = {
      ...defaultAppSettings(),
      financeEnabled: false,
      financeCategoriesSeededAt: "",
    };

    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: { settings, saveSettings },
    });

    const user = userEvent.setup();
    const toggle = screen
      .getByText("Activer les finances")
      .closest("label")
      ?.querySelector("input");
    expect(toggle).not.toBeNull();
    if (toggle) {
      await user.click(toggle);
    }

    await user.click(screen.getByText("Enregistrer"));

    expect(seedSpy).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    const savedArg = saveSettings.mock.calls[0][0];
    expect(savedArg.financeEnabled).toBe(true);
    expect(savedArg.financeCategoriesSeededAt).not.toBe("");
  });

  it("does not reseed when the flag is already enabled and already seeded", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const seedSpy = vi.spyOn(repository, "seedFinanceDefaultCategories");
    const saveSettings = vi.fn().mockResolvedValue(undefined);

    const settings = {
      ...defaultAppSettings(),
      financeEnabled: true,
      financeCategoriesSeededAt: "2024-01-01T00:00:00.000Z",
    };

    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: { settings, saveSettings },
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Enregistrer"));

    expect(seedSpy).not.toHaveBeenCalled();
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("saves the alerts/notify flags and parses the safety buffer into minor units", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const saveSettings = vi.fn().mockResolvedValue(undefined);

    const settings = {
      ...defaultAppSettings(),
      financeEnabled: true,
      financeCategoriesSeededAt: "2024-01-01T00:00:00.000Z",
      financeAlertsOnToday: false,
      financeNotifyRunout: false,
      financeSafetyBufferMinor: 0,
    };

    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: { settings, saveSettings },
    });

    const user = userEvent.setup();
    const alertsToggle = screen
      .getByText("Afficher les alertes sur la page Aujourd'hui")
      .closest("label")
      ?.querySelector("input");
    const notifyToggle = screen
      .getByText("Notifications de dépassement/manque de liquidités")
      .closest("label")
      ?.querySelector("input");
    expect(alertsToggle).not.toBeNull();
    expect(notifyToggle).not.toBeNull();
    if (alertsToggle) {
      await user.click(alertsToggle);
    }
    if (notifyToggle) {
      await user.click(notifyToggle);
    }

    const bufferInput = screen.getByPlaceholderText("0,00");
    await user.clear(bufferInput);
    await user.type(bufferInput, "250.00");

    await user.click(screen.getByText("Enregistrer"));

    expect(saveSettings).toHaveBeenCalledTimes(1);
    const savedArg = saveSettings.mock.calls[0][0];
    expect(savedArg.financeAlertsOnToday).toBe(true);
    expect(savedArg.financeNotifyRunout).toBe(true);
    expect(savedArg.financeSafetyBufferMinor).toBe(25_000);
  });

  it("disables the finance AI sub-settings while aiEnabled is false, but still saves other finance changes", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const saveSettings = vi.fn().mockResolvedValue(undefined);

    const settings = {
      ...defaultAppSettings(),
      financeEnabled: true,
      financeCategoriesSeededAt: "2024-01-01T00:00:00.000Z",
      aiEnabled: false,
    };

    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: { settings, saveSettings },
    });

    const categorizationToggle = screen
      .getByText("Activer la catégorisation IA des marchands inconnus")
      .closest("label")
      ?.querySelector("input");
    expect(categorizationToggle).toBeDisabled();

    await userEvent.setup().click(screen.getByText("Enregistrer"));
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("saves the finance AI categorization settings and parses the auto-apply confidence", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const saveSettings = vi.fn().mockResolvedValue(undefined);

    const settings = {
      ...defaultAppSettings(),
      financeEnabled: true,
      financeCategoriesSeededAt: "2024-01-01T00:00:00.000Z",
      aiEnabled: true,
      aiApiKey: "secret",
      financeAiCategorizationEnabled: false,
      financeAiAutoApplyEnabled: false,
      financeAiAutoApplyMinConfidence: 0.9,
    };

    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: { settings, saveSettings },
    });

    const user = userEvent.setup();
    const categorizationToggle = screen
      .getByText("Activer la catégorisation IA des marchands inconnus")
      .closest("label")
      ?.querySelector("input");
    const autoApplyToggle = screen
      .getByText("Appliquer automatiquement les suggestions IA à confiance élevée")
      .closest("label")
      ?.querySelector("input");
    expect(categorizationToggle).not.toBeDisabled();
    if (categorizationToggle) {
      await user.click(categorizationToggle);
    }
    if (autoApplyToggle) {
      await user.click(autoApplyToggle);
    }

    const confidenceInput = screen.getByPlaceholderText("0,90");
    await user.clear(confidenceInput);
    await user.type(confidenceInput, "0.95");

    await user.click(screen.getByText("Enregistrer"));

    expect(saveSettings).toHaveBeenCalledTimes(1);
    const savedArg = saveSettings.mock.calls[0][0];
    expect(savedArg.financeAiCategorizationEnabled).toBe(true);
    expect(savedArg.financeAiAutoApplyEnabled).toBe(true);
    expect(savedArg.financeAiAutoApplyMinConfidence).toBe(0.95);
  });
});
