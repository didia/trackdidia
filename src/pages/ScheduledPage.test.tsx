import { screen, waitFor } from "@testing-library/react";
import { getTodayDate } from "../lib/date";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { ScheduledPage } from "./ScheduledPage";

describe("ScheduledPage planned-bucket exclusion", () => {
  it("shows a Scheduled task with scheduledFor but excludes Planned tasks from every group", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const today = getTodayDate();
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
      scheduledFor: `${today}T09:00:00.000Z`,
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

    await waitFor(() => {
      expect(screen.getByText("Tache vraiment planifiee (bucket scheduled)")).toBeInTheDocument();
    });

    expect(screen.queryByText("Tache projet avec date reutilisee")).not.toBeInTheDocument();
    expect(screen.queryByText("Tache projet avec deadline correspondante")).not.toBeInTheDocument();
  });
});
