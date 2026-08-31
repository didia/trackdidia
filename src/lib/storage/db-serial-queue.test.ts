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
});
