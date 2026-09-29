import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAsyncResource, useLatestRequest } from "./use-latest-request";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("useLatestRequest", () => {
  it("only reports the newest run as latest when runs resolve out of order", async () => {
    const { result } = renderHook(() => useLatestRequest());
    const first = deferred<string>();
    const second = deferred<string>();
    const applied: string[] = [];

    const run = (d: ReturnType<typeof deferred<string>>) =>
      result.current.run(async (signal) => {
        const value = await d.promise;
        if (signal.isLatest()) {
          applied.push(value);
        }
      });

    const p1 = run(first);
    const p2 = run(second);
    second.resolve("second");
    await p2;
    first.resolve("first");
    await p1;

    expect(applied).toEqual(["second"]);
  });

  it("marks in-flight runs stale after invalidate and returns the task result", async () => {
    const { result } = renderHook(() => useLatestRequest());
    const gate = deferred<void>();
    let latest: boolean | null = null;
    const promise = result.current.run(async (signal) => {
      await gate.promise;
      latest = signal.isLatest();
      return 42;
    });
    result.current.invalidate();
    gate.resolve();
    await expect(promise).resolves.toBe(42);
    expect(latest).toBe(false);
  });

  it("keeps run and invalidate identities stable across renders", () => {
    const { result, rerender } = renderHook(() => useLatestRequest());
    const before = result.current;
    rerender();
    expect(result.current).toBe(before);
    expect(result.current.run).toBe(before.run);
    expect(result.current.invalidate).toBe(before.invalidate);
  });
});

describe("useAsyncResource", () => {
  it("loads data for the key", async () => {
    const { result } = renderHook(() => useAsyncResource("a", async (key) => `data-${key}`));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe("data-a");
    expect(result.current.error).toBeNull();
  });

  it("ignores a stale response that resolves after a newer key's response", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<string>>>();
    const loader = (key: string) => {
      const d = deferred<string>();
      pending.set(key, d);
      return d.promise;
    };
    const { result, rerender } = renderHook(({ k }) => useAsyncResource(k, loader), {
      initialProps: { k: "a" },
    });
    rerender({ k: "b" });
    await act(async () => {
      pending.get("b")?.resolve("B");
    });
    await act(async () => {
      pending.get("a")?.resolve("A");
    });
    expect(result.current.data).toBe("B");
    expect(result.current.loading).toBe(false);
  });

  it("ignores a stale error from a superseded key", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<string>>>();
    const loader = (key: string) => {
      const d = deferred<string>();
      pending.set(key, d);
      return d.promise;
    };
    const { result, rerender } = renderHook(({ k }) => useAsyncResource(k, loader), {
      initialProps: { k: "a" },
    });
    rerender({ k: "b" });
    await act(async () => {
      pending.get("a")?.reject(new Error("old"));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => {
      pending.get("b")?.resolve("B");
    });
    expect(result.current.data).toBe("B");
  });

  it("surfaces errors", async () => {
    const { result } = renderHook(() =>
      useAsyncResource("a", async () => {
        throw new Error("boom");
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe("boom");
  });

  it("clears data on key change by default", async () => {
    const { result, rerender } = renderHook(
      ({ k }) => useAsyncResource(k, () => new Promise<string>(() => {})),
      { initialProps: { k: "a" } },
    );
    rerender({ k: "b" });
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it("keeps data and sets refreshing on reload when refreshing is enabled", async () => {
    let count = 0;
    let gate = deferred<number>();
    const loader = async () => {
      count += 1;
      if (count === 1) {
        return 1;
      }
      return gate.promise;
    };
    const { result } = renderHook(() => useAsyncResource("a", loader, { refreshing: true }));
    await waitFor(() => expect(result.current.data).toBe(1));

    let reloading!: Promise<void>;
    act(() => {
      reloading = result.current.reload();
    });
    expect(result.current.data).toBe(1);
    expect(result.current.refreshing).toBe(true);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      gate.resolve(2);
      await reloading;
    });
    expect(result.current.data).toBe(2);
    expect(result.current.refreshing).toBe(false);
    gate = deferred<number>();
  });
});
