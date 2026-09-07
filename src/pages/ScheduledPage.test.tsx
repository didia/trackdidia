import { fireEvent, screen, waitFor } from "@testing-library/react";
import { buildIsoFromLocalDateAndTime, getTodayDate, toLocalDateInputValue } from "../lib/date";
import { addDays } from "../lib/gtd/shared";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { ScheduledPage } from "./ScheduledPage";

describe("ScheduledPage planned-bucket exclusion", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("shows a Scheduled task with scheduledFor but excludes Planned tasks from every group", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const today = getTodayDate();
    const tomorrow = addDays(today, 1);
    const projectId = "project:scheduled-exclusion";
    await repository.saveProject({
      id: projectId,
      title: "Projet",
      status: "active",
      statusChangedAt: `${today}T00:00:00.000Z`,
      notes: "",
      contextIds: [],
      source: "manual",
      sourceExternalId: null,
      createdAt: `${today}T00:00:00.000Z`,
      updatedAt: `${today}T00:00:00.000Z`,
    });
    // Block auto-promotion so the Planned fixtures below stay Planned.
    await repository.createTask({
      title: "Bloqueur next action",
      bucket: "next_action",
      projectId,
    });

    await repository.createTask({
      title: "Tache vraiment planifiee (bucket scheduled)",
      bucket: "scheduled",
      scheduledFor: `${tomorrow}T12:00:00`,
    });

    await repository.createTask({
      title: "Tache projet avec date reutilisee",
      bucket: "planned",
      projectId,
      scheduledFor: `${today}T09:00:00.000Z`,
    });

    await repository.createTask({
      title: "Tache projet avec deadline correspondante",
      bucket: "planned",
      projectId,
      deadline: today,
    });

    await renderWithApp(<ScheduledPage />, { repository });

    fireEvent.change(screen.getByDisplayValue(today), { target: { value: tomorrow } });

    await waitFor(() => {
      expect(screen.getByText("Tache vraiment planifiee (bucket scheduled)")).toBeInTheDocument();
    });

    expect(screen.queryByText("Tache projet avec date reutilisee")).not.toBeInTheDocument();
    expect(screen.queryByText("Tache projet avec deadline correspondante")).not.toBeInTheDocument();
  });

  it("groups a locally entered evening time on the local calendar date when the ISO instant is the next UTC day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 7, 12, 0, 0));

    const repository = new MemoryRepository();
    await repository.initialize();
    const localDate = "2026-09-08";
    const iso = buildIsoFromLocalDateAndTime(localDate, "21:00");
    expect(iso).toBe("2026-09-09T01:00:00.000Z");
    expect(toLocalDateInputValue(iso)).toBe(localDate);

    await repository.createTask({
      title: "Soiree locale",
      bucket: "scheduled",
      scheduledFor: iso,
    });

    await renderWithApp(<ScheduledPage />, { repository });

    fireEvent.change(screen.getByDisplayValue("2026-09-07"), { target: { value: localDate } });

    await waitFor(() => {
      expect(screen.getByText("Soiree locale")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByDisplayValue(localDate), { target: { value: "2026-09-09" } });

    await waitFor(() => {
      expect(screen.queryByText("Soiree locale")).not.toBeInTheDocument();
    });
  });
});
