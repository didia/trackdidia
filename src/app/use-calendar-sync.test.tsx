import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { requestCalendarSync, useCalendarSync } from "./use-calendar-sync";

const reconcileMock = vi.fn();

vi.mock("../lib/calendar/reconciler", () => ({
  reconcile: (...args: unknown[]) => reconcileMock(...args),
}));

const Mount = ({
  repository,
  browserPreview,
  allowStart,
}: {
  repository: MemoryRepository | null;
  browserPreview: boolean;
  allowStart: boolean;
}) => {
  useCalendarSync(repository, { browserPreview, allowStart });
  return null;
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("useCalendarSync", () => {
  beforeEach(() => {
    reconcileMock.mockReset().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs one reconcile on mount when repository, !browserPreview and allowStart", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    render(<Mount repository={repository} browserPreview={false} allowStart={true} />);
    await flush();

    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(reconcileMock).toHaveBeenCalledWith(repository, "automatic");
  });

  it("never mounts under browser preview (zero reconcile calls)", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    render(<Mount repository={repository} browserPreview={true} allowStart={true} />);
    await flush();

    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("never mounts under the startup fallback (allowStart false, zero reconcile calls)", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    render(<Mount repository={repository} browserPreview={false} allowStart={false} />);
    await flush();

    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("never mounts with no repository", async () => {
    render(<Mount repository={null} browserPreview={false} allowStart={true} />);
    await flush();

    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("requestCalendarSync is a debounced no-op when nothing is registered", () => {
    expect(() => requestCalendarSync()).not.toThrow();
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("debounces requestCalendarSync calls into a single reconcile ~2s later", async () => {
    vi.useFakeTimers();
    const repository = new MemoryRepository();
    await repository.initialize();

    render(<Mount repository={repository} browserPreview={false} allowStart={true} />);
    await act(async () => {
      await Promise.resolve();
    });
    reconcileMock.mockClear();

    act(() => {
      requestCalendarSync();
      requestCalendarSync();
      requestCalendarSync();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });

  it("reconciles again on window focus", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    render(<Mount repository={repository} browserPreview={false} allowStart={true} />);
    await flush();
    reconcileMock.mockClear();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();

    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });

  it("stops requesting after unmount", async () => {
    vi.useFakeTimers();
    const repository = new MemoryRepository();
    await repository.initialize();

    const { unmount } = render(
      <Mount repository={repository} browserPreview={false} allowStart={true} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    reconcileMock.mockClear();
    unmount();

    act(() => {
      requestCalendarSync();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
