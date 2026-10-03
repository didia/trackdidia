import { createLatestValueSaver } from "./use-latest-value-saver";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("latest value saver", () => {
  it("keeps the latest edit and waits for writes submitted during settlement", async () => {
    const firstGate = deferred();
    const latestGate = deferred();
    const save = vi
      .fn()
      .mockImplementationOnce(() => firstGate.promise)
      .mockImplementation(() => latestGate.promise);
    const saver = createLatestValueSaver<string, string>(save);
    saver.hydrate("week", "stored");
    expect(saver.isDirty("week")).toBe(false);
    const first = saver.set("week", "first");
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith("first"));
    let finished = false;
    const settled = saver.settled("week").then(() => {
      finished = true;
    });
    const second = saver.set("week", "second");
    const third = saver.set("week", "latest");
    expect(saver.get("week")).toBe("latest");
    firstGate.resolve();
    await first;
    await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith("latest"));
    expect(finished).toBe(false);
    expect(saver.isDirty("week")).toBe(true);
    latestGate.resolve();
    await Promise.all([second, third, settled]);
    expect(finished).toBe(true);
    expect(saver.isDirty("week")).toBe(false);
    expect(save.mock.calls.map(([value]) => value)).toEqual(["first", "latest", "latest"]);
  });

  it("isolates keys so a blocked old date cannot redirect or block a new date's save", async () => {
    const gate = deferred();
    const save = vi.fn(async (value: string) => {
      if (value === "old date") await gate.promise;
    });
    const saver = createLatestValueSaver<string, string>(save);
    const oldSave = saver.set("old", "old date");
    const newSave = saver.set("new", "new date");
    await newSave;
    expect(saver.isDirty("old")).toBe(true);
    expect(saver.isDirty("new")).toBe(false);
    gate.resolve();
    await oldSave;
    expect(save.mock.calls).toEqual([["old date"], ["new date"]]);
  });

  it("retains a failed draft and permits a subsequent save and settlement", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const saver = createLatestValueSaver<string, string>(save);
    await expect(saver.set("day", "draft")).rejects.toThrow("disk full");
    await expect(saver.settled("day")).rejects.toThrow("disk full");
    expect(saver.isDirty("day")).toBe(true);
    expect(saver.get("day")).toBe("draft");
    await saver.set("day", "retry");
    await saver.settled("day");
    expect(saver.isDirty("day")).toBe(false);
  });

  it("does not mark an edit after an externally accepted snapshot as saved", () => {
    const saver = createLatestValueSaver<string, string>(async () => undefined);
    saver.remember("week", "proposal");
    const acceptedVersion = saver.version("week");
    saver.remember("week", "user edit");
    saver.markSaved("week", acceptedVersion);
    expect(saver.isDirty("week")).toBe(true);
    expect(saver.get("week")).toBe("user edit");
  });
});
