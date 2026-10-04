import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getTodayDate } from "../lib/date";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { useGtdWorkspace } from "./use-gtd";

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
});
