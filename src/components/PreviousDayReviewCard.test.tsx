import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEmptyDailyEntry, defaultAppSettings } from "../domain/daily-entry";
import { getTodayDate } from "../lib/date";
import { addDays } from "../lib/gtd/shared";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { MorningRoutinePage } from "../pages/MorningRoutinePage";
import { renderWithApp } from "../test/test-utils";

const yesterday = addDays(getTodayDate(), -1);

describe("PreviousDayReviewCard", () => {
  it("shows only the fields still missing for yesterday", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const seeded = createEmptyDailyEntry(yesterday);
    seeded.metrics.qualiteSommeil = 80;
    seeded.principleChecks.priereDuSoir = false;
    seeded.principleChecks.retroJournalier = null;
    seeded.nightReflection = "";
    await repository.saveDailyEntry(seeded);

    await renderWithApp(<MorningRoutinePage />, { repository });

    const card = await screen.findByRole("region", { name: /finaliser hier/i });
    const yesterdayCard = within(card);

    expect(yesterdayCard.getByText("Marche")).toBeInTheDocument();
    expect(yesterdayCard.getByText("Dépense calorique")).toBeInTheDocument();
    expect(yesterdayCard.getByText("Rétro journalier")).toBeInTheDocument();
    expect(yesterdayCard.getByText("Réflexion du soir")).toBeInTheDocument();

    expect(yesterdayCard.queryByText("Qualité du sommeil")).not.toBeInTheDocument();
    expect(yesterdayCard.queryByText("Prière du soir")).not.toBeInTheDocument();
  });

  it("saves only the missing fields for yesterday and flags the settings, without touching today", async () => {
    const user = userEvent.setup();
    const repository = new MemoryRepository();
    await repository.initialize();
    const seeded = createEmptyDailyEntry(yesterday);
    seeded.metrics.qualiteSommeil = 80;
    seeded.principleChecks.priereDuSoir = false;
    seeded.principleChecks.retroJournalier = null;
    seeded.nightReflection = "";
    await repository.saveDailyEntry(seeded);

    let savedSettings: unknown = null;
    const settings = defaultAppSettings();
    const saveSettings = vi.fn(async (next: typeof settings) => {
      savedSettings = next;
    });

    await renderWithApp(<MorningRoutinePage />, {
      repository,
      contextOverrides: { settings, saveSettings },
    });

    await screen.findByText("Finaliser hier");

    const marcheInput = screen.getByText("Marche").closest("label")?.querySelector("input")!;
    await user.type(marcheInput, "8000");

    const retroGroup = screen.getByRole("group", { name: /rétro journalier/i });
    await user.click(within(retroGroup).getByRole("button", { name: /oui/i }));

    const reflection = screen
      .getByText("Réflexion du soir")
      .closest("label")
      ?.querySelector("textarea")!;
    await user.type(reflection, "Bonne journee.");

    await user.click(screen.getByRole("button", { name: /enregistrer hier/i }));

    const savedYesterday = await repository.getDailyEntry(yesterday);
    expect(savedYesterday?.metrics.marche).toBe(8000);
    expect(savedYesterday?.principleChecks.retroJournalier).toBe(true);
    expect(savedYesterday?.nightReflection).toBe("Bonne journee.");

    const savedToday = await repository.getDailyEntry(getTodayDate());
    expect(savedToday).toBeNull();

    expect(saveSettings).toHaveBeenCalled();
    expect(
      (savedSettings as { previousDayReviewDoneDate: string } | null)?.previousDayReviewDoneDate,
    ).toBe(yesterday);
  });

  it("hides the card when the flag already covers yesterday", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const seeded = createEmptyDailyEntry(yesterday);
    seeded.nightReflection = "";
    await repository.saveDailyEntry(seeded);

    await renderWithApp(<MorningRoutinePage />, {
      repository,
      contextOverrides: {
        settings: { ...defaultAppSettings(), previousDayReviewDoneDate: yesterday },
      },
    });

    await screen.findByRole("textbox", { name: /intention/i });
    expect(screen.queryByText("Finaliser hier")).not.toBeInTheDocument();
  });

  it("auto-hides when nothing is missing for yesterday", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const seeded = createEmptyDailyEntry(yesterday);
    seeded.metrics.course = 30;
    seeded.metrics.marche = 8000;
    seeded.metrics.depenseCalorique = 2200;
    seeded.metrics.pushups = 20;
    seeded.metrics.qualiteSommeil = 80;
    seeded.metrics.tempsEcranTelephone = 60;
    for (const key of Object.keys(seeded.principleChecks) as Array<
      keyof typeof seeded.principleChecks
    >) {
      seeded.principleChecks[key] = true;
    }
    seeded.nightReflection = "Journee cloturee.";
    await repository.saveDailyEntry(seeded);

    await renderWithApp(<MorningRoutinePage />, { repository });

    await screen.findByRole("textbox", { name: /intention/i });
    expect(screen.queryByText("Finaliser hier")).not.toBeInTheDocument();
  });
});
