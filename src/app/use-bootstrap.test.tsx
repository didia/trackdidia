import { act, renderHook, waitFor } from "@testing-library/react";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { BOOTSTRAP_TIMEOUT_MS, useBootstrap } from "./use-bootstrap";

const factory = vi.hoisted(() => ({
  createRepository: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../lib/storage/factory", () => ({
  isTauriRuntime: () => false,
  createRepository: () => factory.createRepository(),
}));

describe("useBootstrap", () => {
  afterEach(() => {
    factory.createRepository.mockReset();
    vi.useRealTimers();
  });

  it("exposes the bootstrapped repository without a warning on success", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    factory.createRepository.mockResolvedValue(repository);

    const { result } = renderHook(() => useBootstrap());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.repository).toBe(repository);
    expect(result.current.startupError).toBeNull();
    expect(result.current.settings.gtdReferencesMigrationDoneAt).not.toBe("");
  });

  it("activates the in-memory fallback with a warning when startup throws", async () => {
    factory.createRepository.mockRejectedValue(new Error("sqlite exploded"));

    const { result } = renderHook(() => useBootstrap());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.repository).toBeInstanceOf(MemoryRepository);
    expect(result.current.startupError).toBe("sqlite exploded");
  });

  it("activates the fallback when a step of bootstrapApplication throws", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    vi.spyOn(repository, "reconcileDay").mockRejectedValue(new Error("step failed"));
    factory.createRepository.mockResolvedValue(repository);

    const { result } = renderHook(() => useBootstrap());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.repository).toBeInstanceOf(MemoryRepository);
    expect(result.current.repository).not.toBe(repository);
    expect(result.current.startupError).toBe("step failed");
  });

  it("activates the fallback after the eight-second timeout and names the stage", async () => {
    vi.useFakeTimers();
    factory.createRepository.mockReturnValue(new Promise(() => undefined));

    const { result } = renderHook(() => useBootstrap());
    expect(result.current.loading).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOTSTRAP_TIMEOUT_MS - 1);
    });
    expect(result.current.loading).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.repository).toBeInstanceOf(MemoryRepository);
    expect(result.current.startupError).toContain("Création du repository");
  });
});
