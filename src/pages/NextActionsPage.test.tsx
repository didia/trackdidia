import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { Task } from "../domain/types";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { NextActionsPage, sortNextActionTasks } from "./NextActionsPage";

const buildTask = (overrides: Partial<Task> = {}): Task => ({
  id: "task:default",
  title: "Action",
  notes: "",
  status: "active",
  bucket: "next_action",
  contextIds: [],
  projectId: null,
  parentTaskId: null,
  scheduledFor: null,
  deadline: null,
  recurringTemplateId: null,
  recurrenceDueDate: null,
  isRecurringInstance: false,
  completedAt: null,
  recurrenceGroupId: null,
  pendingPastRecurrences: 0,
  plannedOrder: null,
  source: "manual",
  sourceExternalId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const older = buildTask({
  id: "task:older",
  title: "Ancienne action",
  createdAt: "2026-01-01T10:00:00.000Z",
  updatedAt: "2026-01-02T10:00:00.000Z",
  deadline: "2026-12-31",
});
const newer = buildTask({
  id: "task:newer",
  title: "Recente action",
  createdAt: "2026-06-01T10:00:00.000Z",
  updatedAt: "2026-06-02T10:00:00.000Z",
  deadline: "2026-01-15",
});

describe("sortNextActionTasks", () => {
  it("puts the oldest createdAt first in created mode even when a newer task has an earlier deadline", () => {
    expect(sortNextActionTasks([newer, older], "created").map((task) => task.id)).toEqual([
      "task:older",
      "task:newer",
    ]);
  });

  it("breaks createdAt ties with id", () => {
    const zebra = buildTask({ id: "task:z", createdAt: "2026-01-01T10:00:00.000Z" });
    const alpha = buildTask({ id: "task:a", createdAt: "2026-01-01T10:00:00.000Z" });

    expect(sortNextActionTasks([zebra, alpha], "created").map((task) => task.id)).toEqual([
      "task:a",
      "task:z",
    ]);
  });

  it("still sorts nearest deadline first in deadline_asc mode", () => {
    expect(sortNextActionTasks([older, newer], "deadline_asc").map((task) => task.id)).toEqual([
      "task:newer",
      "task:older",
    ]);
  });

  it("still sorts farthest deadline first in deadline_desc mode", () => {
    expect(sortNextActionTasks([newer, older], "deadline_desc").map((task) => task.id)).toEqual([
      "task:older",
      "task:newer",
    ]);
  });

  it("still sorts last update first in updated mode", () => {
    expect(sortNextActionTasks([older, newer], "updated").map((task) => task.id)).toEqual([
      "task:newer",
      "task:older",
    ]);
  });
});

const visibleTitles = () =>
  [...document.querySelectorAll(".task-card__title")].map((node) => node.textContent);

describe("NextActionsPage default order", () => {
  it("lists next actions oldest-first by default and reorders when nearest deadline is selected", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = await repository.getSettings();
    await repository.saveSettings({ ...settings, relationshipDrawsEnabled: false });
    await repository.createTask({
      title: newer.title,
      bucket: "next_action",
      createdAt: newer.createdAt,
      updatedAt: newer.updatedAt,
      deadline: newer.deadline,
    });
    await repository.createTask({
      title: older.title,
      bucket: "next_action",
      createdAt: older.createdAt,
      updatedAt: older.updatedAt,
      deadline: older.deadline,
    });

    await renderWithApp(<NextActionsPage />, { repository });

    await waitFor(() => {
      expect(visibleTitles()).toEqual(["Ancienne action", "Recente action"]);
    });

    const sortSelect = screen.getByLabelText("Trier par");
    expect(sortSelect).toHaveValue("created");

    fireEvent.change(sortSelect, { target: { value: "deadline_asc" } });

    await waitFor(() => {
      expect(visibleTitles()).toEqual(["Recente action", "Ancienne action"]);
    });
  });
});
