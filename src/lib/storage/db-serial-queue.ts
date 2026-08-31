/** Serializes async work so SQLite writes never overlap on one connection. */
export class DbSerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
