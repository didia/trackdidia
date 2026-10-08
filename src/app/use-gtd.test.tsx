import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getTodayDate } from "../lib/date";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { notifyGtdExternalChange } from "./gtd-external-change";
import { useGtdWorkspace } from "./use-gtd";

const requestCalendarSyncMock = vi.fn();
vi.mock("./use-calendar-sync", () => ({
  requestCalendarSync: () => requestCalendarSyncMock(),
}));

const Probe = () => {
  const { tasks, taskEvents, loading } = useGtdWorkspace();
  if (loading && tasks.length === 0) {
    return <p>loading</p>;
  }
  return (
    <div>
      <p data-testid="buckets">{tasks.map((task) => `${task.id}:${task.bucket}`).join(",")}</p>
      <p data-testid="events">{taskEvents.map((event) => event.taskId).join(",")}</p>
    </div>
  );
};

describe("useGtdWorkspace", () => {
  it("loads the promotion event for a Scheduled task promoted by day reconciliation", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const task = await repository.createTask({
      title: "Due scheduled",
      bucket: "scheduled",
      scheduledFor: getTodayDate(),
    });
    await repository.reconcileDay(getTodayDate());

    await renderWithApp(<Probe />, { repository });

    await waitFor(() =>
      expect(screen.getByTestId("buckets").textContent).toContain(`${task.id}:next_action`),
    );
    await waitFor(() => expect(screen.getByTestId("events").textContent).toContain(task.id));
  });

  it("does not reconcile or promote on the initial load", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const task = await repository.createTask({
      title: "Due scheduled",
      bucket: "scheduled",
      scheduledFor: getTodayDate(),
    });
    const reconcile = vi.spyOn(repository, "reconcileDay");

    await renderWithApp(<Probe />, { repository });

    await waitFor(() =>
      expect(screen.getByTestId("buckets").textContent).toContain(`${task.id}:scheduled`),
    );
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("nudges the calendar-sync reconciler at the end of load()", async () => {
    requestCalendarSyncMock.mockClear();
    const repository = new MemoryRepository();
    await repository.initialize();

    await renderWithApp(<Probe />, { repository });

    await waitFor(() => expect(requestCalendarSyncMock).toHaveBeenCalled());
  });
  it("reloads when a writer outside the workspace announces an external change", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await renderWithApp(<Probe />, { repository });
    // Wait for the first load (it also seeds the daily relationship tasks).
    await screen.findByTestId("buckets");

    const task = await repository.createTask({ title: "Ajoutée par un LLM", bucket: "inbox" });
    expect(screen.getByTestId("buckets").textContent).not.toContain(task.id);
    act(() => notifyGtdExternalChange());

    await waitFor(() =>
      expect(screen.getByTestId("buckets").textContent).toContain(`${task.id}:inbox`),
    );
  });
});
