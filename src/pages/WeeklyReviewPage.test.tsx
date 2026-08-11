import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEmptyDailyEntry } from "../domain/daily-entry";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { WeeklyReviewPage } from "./WeeklyReviewPage";

describe("WeeklyReviewPage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });
  it("loads a week summary and saves ritual notes and checklist", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const weekDates = [
      "2026-03-29",
      "2026-03-30",
      "2026-03-31",
      "2026-04-01",
      "2026-04-02",
      "2026-04-03",
      "2026-04-04"
    ];

    for (const date of weekDates) {
      const entry = createEmptyDailyEntry(date);
      entry.metrics.qualiteSommeil = 80;
      entry.metrics.tempsEcranTelephone = 100;
      entry.metrics.pomodoris = 4;
      entry.metrics.tachesAjoutes = 4;
      entry.metrics.tachesRealises = 3;
      entry.principleChecks.priereDuMatin = true;
      entry.principleChecks.respectTrc = true;
      await repository.saveDailyEntry(entry);
    }

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/debut de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, "2026-03-29");
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    expect(await screen.findByText("Score hebdo")).toBeInTheDocument();
    expect(await screen.findByText("21 / 28")).toBeInTheDocument();

    await user.click(screen.getByLabelText(/marquer bilan comme fait/i));
    const bilanField = screen.getByLabelText(/notes bilan/i);
    await user.type(bilanField, "Semaine solide.");

    await waitFor(async () => {
      await expect(repository.getWeeklyReview("2026-03-29")).resolves.toMatchObject({
        ritualChecklist: expect.objectContaining({
          bilan: true
        }),
        notes: expect.objectContaining({
          bilan: "Semaine solide."
        })
      });
    });
  });

  it("renders RescueTime goals score", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);

      if (url.includes("/api/resource/goals")) {
        return Response.json([
          {
            id: 1,
            display_name: "more than 2h on Personal (24x7)",
            amount_seconds: 7200,
            is_more: true,
            enabled: true,
            taxon_id: 15,
            taxonomy_name: "overview",
            schedule_name: "24x7",
            overview: { name: "Personal" }
          }
        ]);
      }

      if (url.includes("restrict_kind=overview")) {
        return Response.json({
          row_headers: ["Rank", "Time Spent (seconds)", "Category"],
          rows: [[1, 12600, "Personal"]]
        });
      }

      return Response.json({ project_times: [] });
    }) as typeof fetch;

    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key"
    });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/debut de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, "2026-08-02");
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    expect(await screen.findByText("Objectifs de la semaine")).toBeInTheDocument();
    expect(await screen.findByText("more than 2h on Personal (24x7)")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("0.25/1")).toBeInTheDocument();
    });
  });
});
