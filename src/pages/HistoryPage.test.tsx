import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEmptyDailyEntry } from "../domain/daily-entry";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { HistoryPage } from "./HistoryPage";
import { renderWithApp } from "../test/test-utils";

describe("HistoryPage", () => {
  it("loads an existing day and saves edits", async () => {
    const user = userEvent.setup();
    const seeded = createEmptyDailyEntry("2026-03-29");
    seeded.morningIntention = "Ancienne intention";
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveDailyEntry(seeded);

    await renderWithApp(<HistoryPage />, { repository });

    const dateInput = await screen.findByLabelText(/date à ouvrir/i);
    await user.clear(dateInput);
    await user.type(dateInput, "2026-03-29");
    await user.click(screen.getByRole("button", { name: /charger la date/i }));

    const field = await screen.findByDisplayValue("Ancienne intention");
    await user.clear(field);
    await user.type(field, "Version corrigee");
    await user.click(screen.getByRole("button", { name: /enregistrer les modifications/i }));

    const saved = await repository.getDailyEntry("2026-03-29");
    expect(saved?.morningIntention).toBe("Version corrigee");
  });

  it("auto-saves note fields on blur", async () => {
    const user = userEvent.setup();
    const seeded = createEmptyDailyEntry("2026-03-29");
    seeded.nightReflection = "Reflexion initiale";
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveDailyEntry(seeded);

    await renderWithApp(<HistoryPage />, { repository });

    const dateInput = await screen.findByLabelText(/date à ouvrir/i);
    await user.clear(dateInput);
    await user.type(dateInput, "2026-03-29");
    await user.click(screen.getByRole("button", { name: /charger la date/i }));

    const field = await screen.findByDisplayValue("Reflexion initiale");
    await user.clear(field);
    await user.type(field, "Reflexion mise a jour");
    await user.tab();

    const saved = await repository.getDailyEntry("2026-03-29");
    expect(saved?.nightReflection).toBe("Reflexion mise a jour");
  });
});
