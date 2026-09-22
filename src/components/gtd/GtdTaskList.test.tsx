import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { Task } from "../../domain/types";
import { GtdTaskList, type GtdTaskListWorkspace } from "./GtdTaskList";

const now = "2026-03-01T10:00:00.000Z";

const buildTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
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
  sourceUrl: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const buildWorkspace = (overrides: Partial<GtdTaskListWorkspace> = {}): GtdTaskListWorkspace => ({
  contexts: [],
  projects: [],
  saveTask: vi.fn(async () => undefined),
  saveContext: vi.fn(async (context) => context),
  applyRecurringEditScope: vi.fn(async () => buildTask("x")),
  completeTask: vi.fn(async () => "ignored"),
  cancelTask: vi.fn(async () => undefined),
  clearPastRecurrences: vi.fn(async () => undefined),
  ...overrides,
});

describe("GtdTaskList", () => {
  it("routes card actions to the workspace handlers", async () => {
    const user = userEvent.setup();
    const workspace = buildWorkspace();
    render(<GtdTaskList tasks={[buildTask("a"), buildTask("b")]} workspace={workspace} />);

    await user.click(screen.getAllByRole("button", { name: "Terminée" })[1]);

    expect(workspace.completeTask).toHaveBeenCalledWith("b");
  });

  it("renders selection checkboxes only when a selection is provided", async () => {
    const user = userEvent.setup();
    const toggleTask = vi.fn();
    const tasks = [buildTask("a")];
    const workspace = buildWorkspace();
    const { rerender } = render(<GtdTaskList tasks={tasks} workspace={workspace} />);
    expect(screen.queryByRole("checkbox")).toBeNull();

    rerender(
      <GtdTaskList
        tasks={tasks}
        workspace={workspace}
        selection={{ isSelected: (id) => id === "a", toggleTask }}
      />,
    );
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    expect(toggleTask).toHaveBeenCalledWith("a");
  });

  it("shows planned controls with first/last disabled states only when requested", () => {
    const tasks = [
      buildTask("a", { bucket: "planned", projectId: "project:p", plannedOrder: 1 }),
      buildTask("b", { bucket: "planned", projectId: "project:p", plannedOrder: 2 }),
    ];
    const workspace = buildWorkspace({
      promotePlannedTask: vi.fn(async () => undefined),
      movePlannedTask: vi.fn(async () => undefined),
    });
    const { rerender } = render(<GtdTaskList tasks={tasks} workspace={workspace} />);
    expect(screen.queryByRole("button", { name: /Monter/ })).toBeNull();

    rerender(<GtdTaskList tasks={tasks} workspace={workspace} showPlannedControls />);
    const up = screen.getAllByRole("button", { name: /Monter/ });
    expect(up[0]).toBeDisabled();
    expect(up[1]).toBeEnabled();
  });
});
