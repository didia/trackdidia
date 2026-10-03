import { createSerialQueue } from "./serial-queue";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("serial queue", () => {
  it("orders work and preserves per-call failures without poisoning the tail", async () => {
    const queue = createSerialQueue();
    const gate = deferred();
    const order: string[] = [];
    const first = queue.run(async () => {
      order.push("first start");
      await gate.promise;
      order.push("first end");
      throw new Error("write failed");
    });
    const rejection = expect(first).rejects.toThrow("write failed");
    const second = queue.run(async () => {
      order.push("second");
      return 42;
    });
    await Promise.resolve();
    expect(order).toEqual(["first start"]);
    gate.resolve();
    await rejection;
    await expect(second).resolves.toBe(42);
    await queue.idle();
    expect(order).toEqual(["first start", "first end", "second"]);
  });

  it("idle includes work enqueued while earlier work is in flight", async () => {
    const queue = createSerialQueue();
    const firstGate = deferred();
    const secondGate = deferred();
    void queue.run(() => firstGate.promise);
    let idle = false;
    const settled = queue.idle().then(() => {
      idle = true;
    });
    void queue.run(() => secondGate.promise);
    firstGate.resolve();
    await vi.waitFor(() => expect(idle).toBe(false));
    secondGate.resolve();
    await settled;
    expect(idle).toBe(true);
  });
});
