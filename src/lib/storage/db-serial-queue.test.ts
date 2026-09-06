import { vi } from "vitest";
import { DbSerialQueue } from "./db-serial-queue";

describe("DbSerialQueue", () => {
  it("runs operations one at a time", async () => {
    const queue = new DbSerialQueue();
    const order: number[] = [];

    const first = queue.run(async () => {
      order.push(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(2);
    });

    const second = queue.run(async () => {
      order.push(3);
    });

    await Promise.all([first, second]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("keeps serializing later operations after an earlier one throws", async () => {
    const queue = new DbSerialQueue();
    const order: string[] = [];

    const first = queue.run(async () => {
      order.push("first-start");
      throw new Error("boom");
    });

    const second = queue.run(async () => {
      order.push("second");
    });

    await expect(first).rejects.toThrow("boom");
    await second;
    expect(order).toEqual(["first-start", "second"]);
  });

  it("never lets transaction-shaped operations (BEGIN/write/COMMIT) overlap", async () => {
    const queue = new DbSerialQueue();
    let activeCount = 0;
    let maxActiveCount = 0;

    const runFakeTransaction = (label: string) =>
      queue.run(async () => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5)); // BEGIN IMMEDIATE
          await new Promise((resolve) => setTimeout(resolve, 5)); // write statement(s)
          await new Promise((resolve) => setTimeout(resolve, 5)); // COMMIT
          return label;
        } finally {
          activeCount -= 1;
        }
      });

    const results = await Promise.all([
      runFakeTransaction("a"),
      runFakeTransaction("b"),
      runFakeTransaction("c"),
    ]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(maxActiveCount).toBe(1);
  });

  it("eventually times out instead of hanging forever when run() is called reentrantly", async () => {
    vi.useFakeTimers();
    try {
      const queue = new DbSerialQueue();

      const outer = queue.run(async () => {
        // Calling run() again from inside an already-executing operation deadlocks the
        // tail chain: the inner call can't start until the outer call's slot frees up,
        // but the outer call is awaiting the inner call's result. The watchdog breaks
        // the cycle by rejecting the inner call once it's clearly never going to start.
        return queue.run(async () => "inner");
      });

      const assertion = expect(outer).rejects.toThrow(/did not start within/);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues an independently-enqueued operation behind one already in flight, without throwing", async () => {
    // This is ordinary concurrency, not reentrancy: two unrelated callers enqueue work,
    // and the second happens to land while the first is still running. Both must queue
    // and resolve normally — this is the queue's entire reason to exist.
    const queue = new DbSerialQueue();
    const order: string[] = [];

    const first = queue.run(async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first-end");
      return "a";
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = queue.run(async () => {
      order.push("second");
      return "b";
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe("a");
    expect(secondResult).toBe("b");
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});
