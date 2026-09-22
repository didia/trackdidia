import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSectionSave } from "./useSectionSave";

describe("useSectionSave", () => {
  it("starts idle", () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useSectionSave(save));

    expect(result.current.saving).toBe(false);
    expect(result.current.message).toBe("");
  });

  it("flips saving to true while the save call is in flight, then sets the success message", async () => {
    let resolveSave!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const { result } = renderHook(() => useSectionSave(save));

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run("Saved.", "Failed to save.");
    });

    await waitFor(() => expect(result.current.saving).toBe(true));
    expect(result.current.message).toBe("");

    await act(async () => {
      resolveSave();
      await runPromise;
    });

    expect(result.current.saving).toBe(false);
    expect(result.current.message).toBe("Saved.");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("clears a previous message when a new run starts", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useSectionSave(save));

    await act(async () => {
      await result.current.run("First save.");
    });
    expect(result.current.message).toBe("First save.");

    let resolveSecond!: () => void;
    save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSecond = resolve;
        }),
    );

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run("Second save.");
    });

    await waitFor(() => expect(result.current.message).toBe(""));

    await act(async () => {
      resolveSecond();
      await runPromise;
    });
    expect(result.current.message).toBe("Second save.");
  });

  it("sets the error message from a thrown Error", async () => {
    const save = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useSectionSave(save));

    await act(async () => {
      await result.current.run("Saved.", "Failed to save.");
    });

    expect(result.current.saving).toBe(false);
    expect(result.current.message).toBe("boom");
  });

  it("falls back to the provided error message when the rejection is not an Error", async () => {
    const save = vi.fn().mockRejectedValue("nope");
    const { result } = renderHook(() => useSectionSave(save));

    await act(async () => {
      await result.current.run("Saved.", "Failed to save.");
    });

    expect(result.current.message).toBe("Failed to save.");
  });

  it("defaults the error message to an empty string when no fallback is given", async () => {
    const save = vi.fn().mockRejectedValue("nope");
    const { result } = renderHook(() => useSectionSave(save));

    await act(async () => {
      await result.current.run("Saved.");
    });

    expect(result.current.message).toBe("");
  });
});
