import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEmptyDailyEntry, updateNote } from "../domain/daily-entry";
import { createEmptyMonthlyReview, updateMonthlyReviewNote } from "../domain/monthly-review";
import { createEmptyWeeklyReview, updateWeeklyReviewNote } from "../domain/weekly-review";
import { formatDateLong } from "../lib/date";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { JournalPage } from "./JournalPage";

const openLinks = () => screen.getAllByRole("link", { name: /Ouvrir/ });

const seedJournalEntries = async (repository: MemoryRepository) => {
  await repository.saveDailyEntry(
    updateNote(createEmptyDailyEntry("2026-04-02"), "morningIntention", "Intention du jeudi"),
  );

  let weekly = createEmptyWeeklyReview("2026-03-29");
  weekly = updateWeeklyReviewNote(weekly, "bilan", "Bilan hebdo");
  await repository.saveWeeklyReview(weekly);

  let monthly = createEmptyMonthlyReview("2026-04");
  monthly = updateMonthlyReviewNote(monthly, "bilan", "Bilan mois");
  await repository.saveMonthlyReview(monthly);
};

describe("JournalPage", () => {
  const renderJournal = (repository: MemoryRepository) =>
    renderWithApp(<JournalPage />, {
      repository,
      route: "/journal",
      contextOverrides: { calendarDay: "2026-04-01" },
    });

  it("shows an empty state when the selected period has no journal text", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    await renderJournal(repository);

    expect(
      await screen.findByText("Aucune entrée de journal pour cette période."),
    ).toBeInTheDocument();
  });

  it("keeps filter controls mounted while an empty period reloads", async () => {
    const user = userEvent.setup();
    const repository = new MemoryRepository();
    await repository.initialize();

    await renderJournal(repository);
    expect(
      await screen.findByText("Aucune entrée de journal pour cette période."),
    ).toBeInTheDocument();

    const periodSelect = screen.getByLabelText("Période");
    await user.selectOptions(periodSelect, "lastWeek");

    expect(periodSelect).toBeInTheDocument();
    expect(periodSelect).toHaveValue("lastWeek");
    expect(
      await screen.findByText("Aucune entrée de journal pour cette période."),
    ).toBeInTheDocument();
  });

  it("lists daily, weekly and monthly cards with edit links", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedJournalEntries(repository);

    await renderJournal(repository);

    expect(await screen.findByText("Intention du jeudi")).toBeInTheDocument();
    expect(screen.getByText("Bilan hebdo")).toBeInTheDocument();
    expect(screen.getByText("Bilan mois")).toBeInTheDocument();

    const dailyOpen = `Ouvrir ${formatDateLong("2026-04-02")}`;
    const weeklyOpen = `Ouvrir Semaine du ${formatDateLong("2026-03-29")} au ${formatDateLong("2026-04-04")}`;
    expect(screen.getByRole("link", { name: dailyOpen })).toHaveAttribute(
      "href",
      "/historique?date=2026-04-02",
    );
    expect(screen.getByRole("link", { name: /Ouvrir avril 2026/ })).toHaveAttribute(
      "href",
      "/mois?month=2026-04",
    );
    expect(screen.getByRole("link", { name: weeklyOpen })).toHaveAttribute(
      "href",
      "/semaine?date=2026-03-29",
    );
    expect(screen.getByRole("article", { name: formatDateLong("2026-04-02") })).toBeInTheDocument();
    expect(openLinks().map((link) => link.getAttribute("href"))).toEqual([
      "/historique?date=2026-04-02",
      "/mois?month=2026-04",
      "/semaine?date=2026-03-29",
    ]);
  });

  it("filters to daily entries only", async () => {
    const user = userEvent.setup();
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedJournalEntries(repository);

    await renderJournal(repository);
    await screen.findByText("Intention du jeudi");

    await user.selectOptions(screen.getByLabelText("Journaux"), "daily");

    await waitFor(() => {
      expect(screen.queryByText("Bilan hebdo")).not.toBeInTheDocument();
      expect(screen.queryByText("Bilan mois")).not.toBeInTheDocument();
      expect(screen.getByText("Intention du jeudi")).toBeInTheDocument();
    });
  });

  it("sorts older first by period date", async () => {
    const user = userEvent.setup();
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedJournalEntries(repository);

    await renderJournal(repository);
    await screen.findByText("Intention du jeudi");

    await user.selectOptions(screen.getByLabelText("Tri"), "olderFirst");

    await waitFor(() => {
      expect(openLinks().map((link) => link.getAttribute("href"))).toEqual([
        "/semaine?date=2026-03-29",
        "/mois?month=2026-04",
        "/historique?date=2026-04-02",
      ]);
    });
  });

  it("uses a custom date range to show older daily notes", async () => {
    const user = userEvent.setup();
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveDailyEntry(
      updateNote(createEmptyDailyEntry("2026-03-15"), "nightReflection", "Note de mars"),
    );
    await seedJournalEntries(repository);

    await renderJournal(repository);
    await screen.findByText("Intention du jeudi");

    await user.selectOptions(screen.getByLabelText("Période"), "custom");
    const start = await screen.findByLabelText("Date de début");
    const end = screen.getByLabelText("Date de fin");
    await user.clear(start);
    await user.type(start, "2026-03-01");
    await user.clear(end);
    await user.type(end, "2026-03-31");

    expect(await screen.findByText("Note de mars")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("Intention du jeudi")).not.toBeInTheDocument();
    });
  });

  it("asks for both custom dates instead of showing another period's notes", async () => {
    const user = userEvent.setup();
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedJournalEntries(repository);

    await renderJournal(repository);
    await screen.findByText("Intention du jeudi");

    await user.selectOptions(screen.getByLabelText("Période"), "custom");
    await user.clear(await screen.findByLabelText("Date de début"));

    expect(
      await screen.findByText("Choisissez une date de début et une date de fin."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Intention du jeudi")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Période")).toHaveValue("custom");
  });
});
