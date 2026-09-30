import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearFailedMidWeekDraft, getFailedMidWeekDraft } from "../app/mid-week-decision-saves";
import { createEmptyDailyEntry, defaultAppSettings } from "../domain/daily-entry";
import type { MidWeekLaggingSnapshot } from "../domain/mid-week-review";
import type { AppSettings } from "../domain/types";
import { RescueTimeGoalsService } from "../lib/rescuetime/rescuetime-goals-service";
import { WeeklyObjectivesService } from "../lib/rescuetime/weekly-objectives-service";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { MID_WEEK_SNAPSHOT_WAIT_MS, MidWeekReviewPage } from "./MidWeekReviewPage";

const WEEK = "2026-08-02";
const WEDNESDAY = "2026-08-05";
const FRIDAY = "2026-08-07";
const SUNDAY = "2026-08-09";
const NEXT_WEEK = "2026-08-09";

const seedPomodoros = async (repository: MemoryRepository, values: number[]) => {
  for (const [index, value] of values.entries()) {
    const entry = createEmptyDailyEntry(`2026-08-0${2 + index}`);
    entry.metrics.pomodoris = value;
    await repository.saveDailyEntry(entry);
  }
};

const keyedSettings = (): AppSettings => ({ ...defaultAppSettings(), rescuetimeApiKey: "rt-key" });

const renderPage = async (
  repository: MemoryRepository,
  calendarDay: string,
  settings: AppSettings = defaultAppSettings(),
) => {
  await repository.saveSettings(settings);
  return renderWithApp(<MidWeekReviewPage />, {
    repository,
    route: "/mi-semaine",
    contextOverrides: { calendarDay, settings },
  });
};

const region = (name: string) => screen.getByRole("region", { name });
const editor = () => screen.getByRole("textbox", { name: "Décisions de mi-semaine" });

const snapshotSignal = (asOfDate: string): MidWeekLaggingSnapshot => ({
  version: 1,
  asOfDate,
  completedDays: 3,
  signals: [
    {
      key: "metric:pomodoris",
      category: "metric",
      label: "Pomodoris",
      direction: "more",
      status: "lagging",
      actual: 8,
      expected: 24,
      weekTarget: 56,
      unit: "sessions",
      daysApplicable: 3,
      daysWithData: 3,
      hasFullCoverage: true,
    },
  ],
});

const seedRow = (
  repository: MemoryRepository,
  overrides: Partial<Parameters<MemoryRepository["saveMidWeekDecisions"]>[0]> = {},
) =>
  repository.saveMidWeekDecisions({
    weekStartDate: WEEK,
    decisions: "Avant",
    decidedOnDate: WEDNESDAY,
    updatedAt: "2026-08-05T10:00:00.000Z",
    laggingSnapshot: snapshotSignal(WEDNESDAY),
    ...overrides,
  });

describe("MidWeekReviewPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearFailedMidWeekDraft(WEEK);
    clearFailedMidWeekDraft(NEXT_WEEK);
  });

  describe("pace sections", () => {
    it("lists a lagging signal with its recovery line, not under Dans le vert", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      await seedPomodoros(repository, [8, 0, 0]);
      await renderPage(repository, WEDNESDAY);

      const lagging = await waitFor(() => {
        const section = region("À rattraper");
        expect(within(section).getByText("Pomodoris")).toBeInTheDocument();
        return section;
      });
      expect(
        within(lagging).getByText(/Reste 48 sessions sur 4 jours ≈ 12 sessions\/jour/),
      ).toBeInTheDocument();
      expect(within(region("Dans le vert")).queryByText("Pomodoris")).not.toBeInTheDocument();
    });

    it("caps the lagging list at 5 and expands it", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      for (const date of ["2026-08-02", "2026-08-03", "2026-08-04"]) {
        const entry = createEmptyDailyEntry(date);
        for (const key of Object.keys(entry.principleChecks)) {
          entry.principleChecks[key as keyof typeof entry.principleChecks] = false;
        }
        await repository.saveDailyEntry(entry);
      }
      const user = userEvent.setup();
      await renderPage(repository, WEDNESDAY);

      const section = await waitFor(() => {
        const found = region("À rattraper");
        expect(within(found).getAllByRole("listitem")).toHaveLength(5);
        return found;
      });
      await user.click(within(section).getByRole("button", { name: /tout afficher/i }));
      expect(within(section).getAllByRole("listitem").length).toBeGreaterThan(5);
    });

    it("counts suggested pomodoro and task metrics instead of listing them as unknown", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      const original = repository.getDailyEntry.bind(repository);
      vi.spyOn(repository, "getDailyEntry").mockImplementation(async (date) => {
        const entry = (await original(date)) ?? createEmptyDailyEntry(date);
        if (date < WEDNESDAY) {
          entry.suggestedMetrics = { pomodoris: 8, tachesAjoutes: 3, tachesRealises: 3 };
        }
        return entry;
      });
      await renderPage(repository, WEDNESDAY);

      await waitFor(() => expect(region("Dans le vert")).toBeInTheDocument());
      const unknown = region("Signaux sans données");
      expect(within(unknown).queryByText("Pomodoris")).not.toBeInTheDocument();
      expect(within(unknown).queryByText("Tâches réalisées")).not.toBeInTheDocument();
    });

    it("shows the Sunday state without current-week verdicts", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      await renderPage(repository, SUNDAY);

      expect(await screen.findByTestId("midweek-sunday")).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Où j'en suis" })).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Dans le vert" })).not.toBeInTheDocument();
      expect(screen.getAllByText(/semaine précédente/).length).toBeGreaterThan(0);
    });

    it("renders entry-derived signals with the missing-key banner and settings link", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      await seedPomodoros(repository, [8, 0, 0]);
      await renderPage(repository, WEDNESDAY);

      const unknown = await waitFor(() => region("Signaux sans données"));
      expect(within(unknown).getByText(/Clé RescueTime manquante/)).toBeInTheDocument();
      expect(within(unknown).getByRole("link", { name: "Paramètres" })).toHaveAttribute(
        "href",
        "/parametres",
      );
      expect(await within(region("À rattraper")).findByText("Pomodoris")).toBeInTheDocument();
    });

    it("shows RescueTime failures without hiding other signals", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      await seedPomodoros(repository, [8, 0, 0]);
      vi.spyOn(RescueTimeGoalsService.prototype, "computeGoalsSnapshot").mockResolvedValue({
        weekStartDate: WEEK,
        weekEndDate: "2026-08-08",
        items: [],
        totalAchievement: 0,
        score: null,
        rescuetimeConfigured: true,
        fetchError: "RescueTime hors ligne",
      });
      await renderPage(repository, WEDNESDAY, keyedSettings());

      expect(await screen.findByText("RescueTime hors ligne")).toBeInTheDocument();
      expect(await within(region("À rattraper")).findByText("Pomodoris")).toBeInTheDocument();
    });

    it("uses a neutral notice for cached RescueTime data", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      vi.spyOn(RescueTimeGoalsService.prototype, "computeGoalsSnapshot").mockResolvedValue({
        weekStartDate: WEEK,
        weekEndDate: "2026-08-08",
        items: [],
        totalAchievement: 0,
        score: null,
        rescuetimeConfigured: true,
        cachedAt: "2026-08-05T09:00:00.000Z",
      });
      vi.spyOn(RescueTimeGoalsService.prototype, "computeProductivityPulse").mockResolvedValue({
        weekStartDate: WEEK,
        weekEndDate: "2026-08-08",
        pulse: null,
        rescuetimeConfigured: true,
      });
      vi.spyOn(
        WeeklyObjectivesService.prototype,
        "computeWeeklyObjectivesSnapshot",
      ).mockResolvedValue({
        weekStartDate: WEEK,
        weekEndDate: "2026-08-08",
        items: [],
        totalAchievement: 0,
        score: null,
        rescuetimeConfigured: true,
      });
      await renderPage(repository, WEDNESDAY, keyedSettings());

      expect(await screen.findByText(/Données RescueTime de/)).toBeInTheDocument();
      expect(screen.queryByText(/injoignable/)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Actualiser" })).toBeInTheDocument();
    });

    it("lists only non-empty journal fields, newest first", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      const monday = createEmptyDailyEntry("2026-08-03");
      monday.morningIntention = "Intention lundi";
      const tuesday = createEmptyDailyEntry("2026-08-04");
      tuesday.nightReflection = "Réflexion mardi";
      await repository.saveDailyEntry(monday);
      await repository.saveDailyEntry(tuesday);
      await renderPage(repository, WEDNESDAY);

      const journal = await waitFor(() => {
        const section = region("Journal de la semaine");
        expect(within(section).getByText("Réflexion mardi")).toBeInTheDocument();
        return section;
      });
      const text = journal.textContent ?? "";
      expect(text.indexOf("Réflexion mardi")).toBeLessThan(text.indexOf("Intention lundi"));
      expect(within(journal).queryByText(/Focus de demain/)).not.toBeInTheDocument();
    });
  });

  describe("decisions editor", () => {
    it("saves typed decisions with decidedOnDate and a lagging snapshot, never touching the weekly review", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      await seedPomodoros(repository, [8, 0, 0]);
      const save = vi.spyOn(repository, "saveMidWeekDecisions");
      const weeklySave = vi.spyOn(repository, "saveWeeklyReview");
      const user = userEvent.setup();
      await renderPage(repository, WEDNESDAY);

      await user.type(await waitFor(editorEnabled), "Moins de téléphone");
      await waitFor(() => expect(save).toHaveBeenCalled(), { timeout: 5000 });

      const saved = save.mock.calls[0][0];
      expect(saved).toMatchObject({
        weekStartDate: WEEK,
        decisions: "Moins de téléphone",
        decidedOnDate: WEDNESDAY,
      });
      expect(saved.laggingSnapshot?.signals.map((signal) => signal.key)).toContain(
        "metric:pomodoris",
      );
      expect(weeklySave).not.toHaveBeenCalled();
    });

    it("gates the editor on the decisions read", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      await seedRow(repository, { decisions: "X" });
      const original = repository.getMidWeekDecisions.bind(repository);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(repository, "getMidWeekDecisions").mockImplementation(async (week) => {
        await gate;
        return original(week);
      });
      const save = vi.spyOn(repository, "saveMidWeekDecisions");
      const user = userEvent.setup();
      await renderPage(repository, WEDNESDAY);

      const busy = editor();
      expect(busy).toBeDisabled();
      expect(busy).toHaveAttribute("aria-busy", "true");
      await user.type(busy, "abc");
      expect(save).not.toHaveBeenCalled();

      await act(async () => release());
      await waitFor(() => expect(editor()).toHaveValue("X"));
      expect(editor()).toBeEnabled();
    });

    it("shows an alert with a retry when the read fails, and no editor", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      await seedRow(repository, { decisions: "Stocké" });
      vi.spyOn(repository, "getMidWeekDecisions").mockRejectedValueOnce(new Error("boom"));
      const user = userEvent.setup();
      await renderPage(repository, WEDNESDAY);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Impossible de charger tes décisions");
      expect(
        screen.queryByRole("textbox", { name: "Décisions de mi-semaine" }),
      ).not.toBeInTheDocument();

      await user.click(within(alert).getByRole("button", { name: "Réessayer" }));
      await waitFor(() => expect(editor()).toHaveValue("Stocké"));
    });

    it("renders a seeded row's text", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      await seedRow(repository, { decisions: "Déjà décidé" });
      await renderPage(repository, WEDNESDAY);
      await waitFor(() => expect(editor()).toHaveValue("Déjà décidé"));
    });

    describe("rejected saves", () => {
      it("keeps the text on a rejected debounce save and saves on Réessayer", async () => {
        const repository = new MemoryRepository();
        await repository.initialize();
        const save = vi
          .spyOn(repository, "saveMidWeekDecisions")
          .mockRejectedValueOnce(new Error("disk"));
        const user = userEvent.setup();
        await renderPage(repository, WEDNESDAY);

        await user.type(await waitFor(editorEnabled), "Texte");
        const alert = await screen.findByRole("alert", {}, { timeout: 6000 });
        expect(alert).toHaveTextContent("Décisions non enregistrées");
        expect(editor()).toHaveValue("Texte");

        await user.click(within(alert).getByRole("button", { name: "Réessayer" }));
        await waitFor(() => expect(save).toHaveBeenCalledTimes(2), { timeout: 5000 });
        await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
        await expect(repository.getMidWeekDecisions(WEEK)).resolves.toMatchObject({
          decisions: "Texte",
        });
      }, 15000);

      it("keeps the text on a rejected blur save and saves on Réessayer", async () => {
        const repository = new MemoryRepository();
        await repository.initialize();
        vi.spyOn(repository, "saveMidWeekDecisions").mockRejectedValueOnce(new Error("disk"));
        const user = userEvent.setup();
        await renderPage(repository, WEDNESDAY);

        await user.type(await waitFor(editorEnabled), "Blur");
        await user.tab();
        const alert = await screen.findByRole("alert", {}, { timeout: 6000 });
        expect(editor()).toHaveValue("Blur");
        await user.click(within(alert).getByRole("button", { name: "Réessayer" }));
        await waitFor(
          async () => expect((await repository.getMidWeekDecisions(WEEK))?.decisions).toBe("Blur"),
          { timeout: 5000 },
        );
      }, 15000);

      it("restores an unmount-time failed draft on remount and clears it after a retry", async () => {
        const repository = new MemoryRepository();
        await repository.initialize();
        vi.spyOn(repository, "saveMidWeekDecisions").mockRejectedValueOnce(new Error("disk"));
        const user = userEvent.setup();
        const first = await renderPage(repository, WEDNESDAY);

        await user.type(await waitFor(editorEnabled), "Perdu");
        first.unmount();
        await waitFor(() => expect(getFailedMidWeekDraft(WEEK)?.text).toBe("Perdu"), {
          timeout: 6000,
        });

        const user2 = userEvent.setup();
        await renderPage(repository, WEDNESDAY);
        await waitFor(() => expect(editor()).toHaveValue("Perdu"));
        const alert = await screen.findByRole("alert");
        await user2.click(within(alert).getByRole("button", { name: "Réessayer" }));
        await waitFor(() => expect(getFailedMidWeekDraft(WEEK)).toBeUndefined(), {
          timeout: 6000,
        });
        await expect(repository.getMidWeekDecisions(WEEK)).resolves.toMatchObject({
          decisions: "Perdu",
        });
      }, 20000);
    });

    it("keeps the newer text when an earlier save is still waiting on the snapshot", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      vi.spyOn(
        WeeklyObjectivesService.prototype,
        "computeWeeklyObjectivesSnapshot",
      ).mockImplementation(() => new Promise(() => undefined));
      const user = userEvent.setup();
      const first = await renderPage(repository, WEDNESDAY, keyedSettings());
      await user.type(await waitFor(editorEnabled), "ancien");
      first.unmount(); // flushes "ancien": queued, waiting for the snapshot

      const user2 = userEvent.setup();
      await renderPage(repository, WEDNESDAY, keyedSettings());
      await user2.type(await waitFor(editorEnabled), "nouveau");
      await user2.tab();

      await waitFor(
        async () =>
          expect((await repository.getMidWeekDecisions(WEEK))?.decisions).toContain("nouveau"),
        { timeout: 9000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await repository.getMidWeekDecisions(WEEK))?.decisions).toContain("nouveau");
    }, 20000);

    it("does not reload the decisions resource after a save and updates the last-update line", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      const read = vi.spyOn(repository, "getMidWeekDecisions");
      const user = userEvent.setup();
      await renderPage(repository, WEDNESDAY);

      await user.type(await waitFor(editorEnabled), "Encore");
      await user.tab();
      await waitFor(
        async () => expect((await repository.getMidWeekDecisions(WEEK))?.decisions).toBe("Encore"),
        { timeout: 5000 },
      );
      read.mockClear();
      await waitFor(() => expect(screen.getByText(/dernière mise à jour le/)).toBeInTheDocument());
      expect(read).not.toHaveBeenCalled();
      expect(editor()).toHaveValue("Encore");
    }, 15000);

    describe("snapshot preservation", () => {
      const editAndRead = async (
        repository: MemoryRepository,
        calendarDay: string,
        settings: AppSettings,
        week = WEEK,
      ) => {
        const user = userEvent.setup();
        await renderPage(repository, calendarDay, settings);
        await user.type(await waitFor(editorEnabled), " modif");
        await user.tab();
        await waitFor(
          async () =>
            expect((await repository.getMidWeekDecisions(week))?.decisions).toContain("modif"),
          { timeout: MID_WEEK_SNAPSHOT_WAIT_MS + 4000 },
        );
        return repository.getMidWeekDecisions(week);
      };

      const seeded = async () => {
        const repository = new MemoryRepository();
        await repository.initialize();
        await seedPomodoros(repository, [8, 0, 0, 0, 0]);
        await seedRow(repository);
        return repository;
      };

      it("keeps the Wednesday snapshot when an external load hangs", async () => {
        const repository = await seeded();
        vi.spyOn(RescueTimeGoalsService.prototype, "computeGoalsSnapshot").mockImplementation(
          () => new Promise(() => undefined),
        );
        const row = await editAndRead(repository, FRIDAY, keyedSettings());
        expect(row?.laggingSnapshot?.asOfDate).toBe(WEDNESDAY);
      }, 20000);

      it("keeps it when no summary is ready", async () => {
        const repository = await seeded();
        vi.spyOn(repository, "getDailyEntry").mockImplementation(
          () => new Promise(() => undefined),
        );
        const row = await editAndRead(repository, FRIDAY, defaultAppSettings());
        expect(row?.laggingSnapshot?.asOfDate).toBe(WEDNESDAY);
      }, 20000);

      it("keeps it when RescueTime fails with no cache", async () => {
        const repository = await seeded();
        vi.spyOn(RescueTimeGoalsService.prototype, "computeGoalsSnapshot").mockResolvedValue({
          weekStartDate: WEEK,
          weekEndDate: "2026-08-08",
          items: [],
          totalAchievement: 0,
          score: null,
          rescuetimeConfigured: true,
          fetchError: "offline",
        });
        const row = await editAndRead(repository, FRIDAY, keyedSettings());
        expect(row?.laggingSnapshot?.asOfDate).toBe(WEDNESDAY);
      }, 20000);

      it("keeps the stored snapshot on Sunday", async () => {
        const repository = new MemoryRepository();
        await repository.initialize();
        await seedRow(repository, { weekStartDate: SUNDAY });
        const row = await editAndRead(repository, SUNDAY, defaultAppSettings(), SUNDAY);
        expect(row?.laggingSnapshot?.asOfDate).toBe(WEDNESDAY);
        expect(row?.decidedOnDate).toBe(SUNDAY);
      }, 20000);

      it("replaces the snapshot after a complete load", async () => {
        const repository = await seeded();
        const row = await editAndRead(repository, FRIDAY, defaultAppSettings());
        expect(row?.laggingSnapshot?.asOfDate).toBe(FRIDAY);
      }, 20000);

      it("keeps the stored snapshot when a save happens during an Actualiser refresh", async () => {
        const repository = await seeded();
        let calls = 0;
        vi.spyOn(RescueTimeGoalsService.prototype, "computeGoalsSnapshot").mockImplementation(
          () => {
            calls += 1;
            return calls === 1
              ? Promise.resolve({
                  weekStartDate: WEEK,
                  weekEndDate: "2026-08-08",
                  items: [],
                  totalAchievement: 0,
                  score: null,
                  rescuetimeConfigured: true,
                })
              : new Promise(() => undefined);
          },
        );
        const user = userEvent.setup();
        await renderPage(repository, FRIDAY, keyedSettings());
        await user.click(await screen.findByRole("button", { name: "Actualiser" }));
        await user.type(await waitFor(editorEnabled), " modif");
        await user.tab();
        await waitFor(
          async () =>
            expect((await repository.getMidWeekDecisions(WEEK))?.decisions).toContain("modif"),
          { timeout: 8000 },
        );
        expect((await repository.getMidWeekDecisions(WEEK))?.laggingSnapshot?.asOfDate).toBe(
          WEDNESDAY,
        );
      }, 20000);
    });

    it("targets the right week for two different calendar days", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      await seedRow(repository, { decisions: "Semaine A" });
      await seedRow(repository, { weekStartDate: NEXT_WEEK, decisions: "Semaine B" });
      const first = await renderPage(repository, WEDNESDAY);
      await waitFor(() => expect(editor()).toHaveValue("Semaine A"));
      first.unmount();
      await renderPage(repository, "2026-08-12");
      await waitFor(() => expect(editor()).toHaveValue("Semaine B"));
    });

    it("saves the text without a snapshot patch when the loads never settle", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      vi.spyOn(repository, "getDailyEntry").mockImplementation(() => new Promise(() => undefined));
      const user = userEvent.setup();
      await renderPage(repository, WEDNESDAY);

      await user.type(await waitFor(editorEnabled), "Coincé");
      await user.tab();
      await waitFor(
        async () => expect((await repository.getMidWeekDecisions(WEEK))?.decisions).toBe("Coincé"),
        { timeout: MID_WEEK_SNAPSHOT_WAIT_MS + 4000 },
      );
      expect((await repository.getMidWeekDecisions(WEEK))?.laggingSnapshot).toBeNull();
    }, 20000);

    it("writes text typed before midnight to the old week without the new week's snapshot", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      const user = userEvent.setup();
      const first = await renderPage(repository, "2026-08-08");
      await user.type(await waitFor(editorEnabled), "Avant minuit");
      first.unmount();
      await renderPage(repository, "2026-08-10");

      await waitFor(
        async () =>
          expect((await repository.getMidWeekDecisions(WEEK))?.decisions).toBe("Avant minuit"),
        { timeout: 8000 },
      );
      expect(await repository.getMidWeekDecisions(NEXT_WEEK)).toBeNull();
      const stored = await repository.getMidWeekDecisions(WEEK);
      expect(
        stored?.laggingSnapshot === null || stored?.laggingSnapshot?.asOfDate !== "2026-08-10",
      ).toBe(true);
    }, 20000);
  });
});

function editorEnabled() {
  const box = screen.getByRole("textbox", { name: "Décisions de mi-semaine" });
  expect(box).toBeEnabled();
  return box;
}
