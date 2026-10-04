import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRecurringTemplate } from "../lib/recurring/engine";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { RecurrencesPage } from "./RecurrencesPage";

const requestCalendarSyncMock = vi.fn();
vi.mock("../app/use-calendar-sync", () => ({
  requestCalendarSync: () => requestCalendarSyncMock(),
}));

describe("RecurrencesPage calendar-sync nudges", () => {
  beforeEach(() => {
    requestCalendarSyncMock.mockClear();
  });

  it("nudges the reconciler after creating a template", async () => {
    const user = userEvent.setup();
    const repository = new MemoryRepository();
    await repository.initialize();

    await renderWithApp(<RecurrencesPage />, { repository });

    await user.type(screen.getByLabelText("Titre"), "Arroser les plantes");
    await user.click(screen.getByRole("button", { name: "Créer la récurrence" }));

    await waitFor(() => expect(requestCalendarSyncMock).toHaveBeenCalled());
  });

  it("nudges the reconciler after pause/resume/cancel", async () => {
    const user = userEvent.setup();
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveRecurringTaskTemplate(
      createRecurringTemplate({
        id: "recurring-template:1",
        title: "Reviewer la semaine",
        ruleType: "daily",
        startDate: "2026-01-01",
        targetBucket: "next_action",
      }),
    );

    await renderWithApp(<RecurrencesPage />, { repository });

    await screen.findByText("Reviewer la semaine");
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(requestCalendarSyncMock).toHaveBeenCalled());

    requestCalendarSyncMock.mockClear();
    await user.click(screen.getByRole("button", { name: "Reprendre" }));
    await waitFor(() => expect(requestCalendarSyncMock).toHaveBeenCalled());

    requestCalendarSyncMock.mockClear();
    await user.click(screen.getByRole("button", { name: "Annuler" }));
    await waitFor(() => expect(requestCalendarSyncMock).toHaveBeenCalled());
  });
});
