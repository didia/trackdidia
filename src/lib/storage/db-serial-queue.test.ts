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
});
