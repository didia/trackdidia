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
    const updateSettings = vi.fn().mockResolvedValue(undefined);

    const settings = {
      ...defaultAppSettings(),
      financeEnabled: false,
      financeCategoriesSeededAt: "",
    };

    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: { settings, updateSettings },
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
    expect(updateSettings).toHaveBeenCalledTimes(1);
    const savedArg = updateSettings.mock.calls[0][0](settings);
    expect(savedArg.financeEnabled).toBe(true);
    expect(savedArg.financeCategoriesSeededAt).not.toBe("");
  });

  it("does not reseed when the flag is already enabled and already seeded", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const seedSpy = vi.spyOn(repository, "seedFinanceDefaultCategories");
    const updateSettings = vi.fn().mockResolvedValue(undefined);

    const settings = {
      ...defaultAppSettings(),
      financeEnabled: true,
      financeCategoriesSeededAt: "2024-01-01T00:00:00.000Z",
    };

    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: { settings, updateSettings },
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Enregistrer"));

    expect(seedSpy).not.toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });
});
