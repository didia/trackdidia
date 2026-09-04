import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEmptyDailyEntry, defaultAppSettings } from "../domain/daily-entry";
import { getTodayDate } from "../lib/date";
import { addDays } from "../lib/gtd/shared";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { MorningRoutinePage } from "./MorningRoutinePage";

const hidePreviousDayReview = {
  contextOverrides: {
    settings: { ...defaultAppSettings(), previousDayReviewDoneDate: addDays(getTodayDate(), -1) },
  },
};

describe("MorningRoutinePage", () => {
  it("keeps today's morning metrics distinct from yesterday's catch-up fields", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveDailyEntry(createEmptyDailyEntry(addDays(getTodayDate(), -1)));

    await renderWithApp(<MorningRoutinePage />, { repository });

    const yesterday = await screen.findByRole("region", { name: /finaliser hier/i });
    const morningMetrics = await screen.findByRole("region", { name: /chiffres du matin/i });

    expect(within(yesterday).getByText("Course")).toBeInTheDocument();
    expect(within(yesterday).getByText("Temps d'écran téléphone")).toBeInTheDocument();
    expect(within(morningMetrics).queryByText("Course")).not.toBeInTheDocument();
    expect(within(morningMetrics).queryByText("Temps d'écran téléphone")).not.toBeInTheDocument();

    const fields = within(morningMetrics).getAllByRole("spinbutton");
    expect(fields).toHaveLength(2);
    expect(fields[0]).toHaveAccessibleName(/qualité du sommeil/i);
    expect(fields[1]).toHaveAccessibleName(/pushups/i);

    expect(screen.getAllByRole("spinbutton", { name: /qualité du sommeil/i })).toHaveLength(2);
    expect(screen.getAllByRole("spinbutton", { name: /pushups/i })).toHaveLength(2);
  });

  it("shows sleep quality then pushups, keeps GTD, and omits evening-only metrics", async () => {
    await renderWithApp(<MorningRoutinePage />, hidePreviousDayReview);

    const metricsSection = await screen.findByRole("region", { name: /chiffres du matin/i });
    const metrics = within(metricsSection);

    const fields = metrics.getAllByRole("spinbutton");

    expect(fields).toHaveLength(2);
    expect(fields[0]).toHaveAccessibleName(/qualité du sommeil/i);
    expect(fields[1]).toHaveAccessibleName(/pushups/i);

    expect(screen.getByRole("heading", { name: /charge de travail gtd/i })).toBeInTheDocument();
    expect(screen.queryByText("Course")).not.toBeInTheDocument();
    expect(screen.queryByText("Temps d'écran téléphone")).not.toBeInTheDocument();
  });

  it("saves morning sleep quality and pushups when completing the morning", async () => {
    const user = userEvent.setup();
    const { repository } = await renderWithApp(<MorningRoutinePage />, hidePreviousDayReview);

    const metricsSection = await screen.findByRole("region", { name: /chiffres du matin/i });
    const metrics = within(metricsSection);

    await user.type(metrics.getByRole("spinbutton", { name: /qualité du sommeil/i }), "75");
    await user.type(metrics.getByRole("spinbutton", { name: /pushups/i }), "40");
    await user.click(screen.getByRole("button", { name: /marquer le matin comme complété/i }));

    const saved = await repository.getDailyEntry(getTodayDate());
    expect(saved?.metrics.qualiteSommeil).toBe(75);
    expect(saved?.metrics.pushups).toBe(40);
    expect(saved?.status).toBe("morning_done");
  });

  it("shows only the six morning anchor principles", async () => {
    await renderWithApp(<MorningRoutinePage />);

    const anchorsSection = await screen.findByRole("region", { name: /ancrages du matin/i });
    const anchors = within(anchorsSection);

    expect(anchors.getByText("Respect réveil")).toBeInTheDocument();
    expect(anchors.getByText("Prière du matin")).toBeInTheDocument();
    expect(anchors.getByText("Ocytocine du matin")).toBeInTheDocument();
    expect(anchors.getByText("Avoir lu mes principes")).toBeInTheDocument();
    expect(anchors.getByText("Écriture")).toBeInTheDocument();
    expect(anchors.getByText("Apprentissage")).toBeInTheDocument();

    expect(anchors.queryByText("Managed solitude")).not.toBeInTheDocument();
    expect(anchors.queryByText("Respect de vie comme Jésus")).not.toBeInTheDocument();
  });

  it("saves the intention and completes the morning status", async () => {
    const user = userEvent.setup();
    const { repository } = await renderWithApp(<MorningRoutinePage />);

    const intention = await screen.findByRole("textbox", { name: /intention/i });
    await user.type(intention, "Je garde un rythme calme.");
    await user.click(screen.getByRole("button", { name: /marquer le matin comme complété/i }));

    const saved = await repository.getDailyEntry(getTodayDate());
    expect(saved?.morningIntention).toContain("Je garde un rythme calme.");
    expect(saved?.status).toBe("morning_done");
  });
});
