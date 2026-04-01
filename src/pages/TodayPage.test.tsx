import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TodayPage } from "./TodayPage";
import { getTodayDate } from "../lib/date";
import { addDays } from "../lib/gtd/shared";
import { renderWithApp } from "../test/test-utils";
import { MemoryRepository } from "../lib/storage/memory-repository";

describe("TodayPage", () => {
  it("shows added and completed tasks when clicking GTD counters", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const today = getTodayDate();
    const yesterday = addDays(today, -1);

    await repository.createTask({
      id: "task-added",
      title: "Nouvelle action du jour",
      bucket: "next_action",
      createdAt: `${today}T09:00:00.000Z`
    });

    await repository.createTask({
      id: "task-completed",
      title: "Action terminee du jour",
      bucket: "next_action",
      createdAt: `${yesterday}T09:00:00.000Z`
    });
    await repository.completeTask("task-completed", `${today}T18:00:00.000Z`);

    const user = userEvent.setup();
    await renderWithApp(<TodayPage />, { repository, route: "/" });

    await user.click(await screen.findByRole("button", { name: /ajoutees/i }));
    expect(await screen.findByText("Nouvelle action du jour")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /realisees/i }));
    expect(await screen.findByText("Action terminee du jour")).toBeInTheDocument();
  });
});
