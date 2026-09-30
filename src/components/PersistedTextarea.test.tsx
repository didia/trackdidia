import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { PersistedTextarea, type PersistedTextareaHandle } from "./PersistedTextarea";

describe("PersistedTextarea", () => {
  it("flushes a pending debounced value on unmount", async () => {
    const onPersist = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(
      <PersistedTextarea aria-label="Notes" savedValue="" debounceMs={450} onPersist={onPersist} />,
    );

    await user.type(screen.getByLabelText("Notes"), "hello");
    expect(onPersist).not.toHaveBeenCalled();

    unmount();

    expect(onPersist).toHaveBeenCalledWith("hello");
  });

  describe("acknowledged saves", () => {
    const deferred = () => {
      let resolve: () => void = () => undefined;
      let reject: (error: Error) => void = () => undefined;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    it("keeps void callbacks behaving as before (confirmed immediately, no state events)", async () => {
      const onPersist = vi.fn();
      const onState = vi.fn();
      const user = userEvent.setup();
      render(
        <PersistedTextarea
          aria-label="Notes"
          savedValue=""
          debounceMs={0}
          onPersist={onPersist}
          onPersistStateChange={onState}
        />,
      );
      const field = screen.getByLabelText("Notes");
      await user.type(field, "a");
      await user.tab();
      expect(onPersist).toHaveBeenCalledTimes(1);
      expect(onState).not.toHaveBeenCalled();
    });

    it("confirms the value only after the promise resolves", async () => {
      const save = deferred();
      const onPersist = vi.fn(() => save.promise);
      const onState = vi.fn();
      const user = userEvent.setup();
      render(
        <PersistedTextarea
          aria-label="Notes"
          savedValue=""
          debounceMs={0}
          onPersist={onPersist}
          onPersistStateChange={onState}
        />,
      );
      await user.type(screen.getByLabelText("Notes"), "a");
      expect(onState).toHaveBeenLastCalledWith("saving");
      await act(async () => {
        save.resolve();
        await save.promise;
      });
      expect(onState).toHaveBeenLastCalledWith("saved");
      await user.tab(); // unchanged blur: nothing more to save
      expect(onPersist).toHaveBeenCalledTimes(1);
    });

    it("keeps a rejected debounce save dirty, reports error and retries on blur", async () => {
      const onPersist = vi
        .fn<(value: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error("disk"))
        .mockResolvedValue(undefined);
      const onState = vi.fn();
      const user = userEvent.setup();
      render(
        <PersistedTextarea
          aria-label="Notes"
          savedValue=""
          debounceMs={0}
          onPersist={onPersist}
          onPersistStateChange={onState}
        />,
      );
      await user.type(screen.getByLabelText("Notes"), "a");
      await vi.waitFor(() => expect(onState).toHaveBeenCalledWith("error", expect.any(Error)));
      expect(screen.getByLabelText("Notes")).toHaveValue("a");

      await user.tab();
      await vi.waitFor(() => expect(onPersist).toHaveBeenCalledTimes(2));
      expect(onPersist).toHaveBeenLastCalledWith("a");
    });

    it("retries a rejected blur save on the next flush()", async () => {
      const onPersist = vi
        .fn<(value: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error("disk"))
        .mockResolvedValue(undefined);
      const onState = vi.fn();
      const ref = createRef<PersistedTextareaHandle>();
      const user = userEvent.setup();
      render(
        <PersistedTextarea
          ref={ref}
          aria-label="Notes"
          savedValue=""
          debounceMs={1000}
          onPersist={onPersist}
          onPersistStateChange={onState}
        />,
      );
      await user.type(screen.getByLabelText("Notes"), "a");
      await user.tab();
      await vi.waitFor(() => expect(onState).toHaveBeenCalledWith("error", expect.any(Error)));

      act(() => ref.current?.flush());
      await vi.waitFor(() => expect(onPersist).toHaveBeenCalledTimes(2));
    });

    it("reports a rejected unmount save after unmount", async () => {
      const onPersist = vi.fn(() => Promise.reject(new Error("disk")));
      const onState = vi.fn();
      const user = userEvent.setup();
      const { unmount } = render(
        <PersistedTextarea
          aria-label="Notes"
          savedValue=""
          debounceMs={1000}
          onPersist={onPersist}
          onPersistStateChange={onState}
        />,
      );
      await user.type(screen.getByLabelText("Notes"), "a");
      unmount();
      expect(onPersist).toHaveBeenCalledWith("a");
      await vi.waitFor(() => expect(onState).toHaveBeenCalledWith("error", expect.any(Error)));
    });

    it("sends only the newest value after an in-flight save settles", async () => {
      const first = deferred();
      const onPersist = vi
        .fn<(value: string) => Promise<void>>()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue(undefined);
      const ref = createRef<PersistedTextareaHandle>();
      const user = userEvent.setup();
      render(
        <PersistedTextarea
          ref={ref}
          aria-label="Notes"
          savedValue=""
          debounceMs={0}
          onPersist={onPersist}
        />,
      );
      const field = screen.getByLabelText("Notes");
      await user.type(field, "a");
      await user.type(field, "b");
      await user.type(field, "c");
      expect(onPersist).toHaveBeenCalledTimes(1);
      expect(onPersist).toHaveBeenCalledWith("a");

      await act(async () => {
        first.resolve();
        await first.promise;
      });
      await vi.waitFor(() => expect(onPersist).toHaveBeenCalledTimes(2));
      expect(onPersist).toHaveBeenLastCalledWith("abc");
    });

    it("issues no second write for a blur or unmount with the in-flight value", async () => {
      const first = deferred();
      const onPersist = vi.fn(() => first.promise);
      const user = userEvent.setup();
      const { unmount } = render(
        <PersistedTextarea aria-label="Notes" savedValue="" debounceMs={0} onPersist={onPersist} />,
      );
      await user.type(screen.getByLabelText("Notes"), "a");
      await user.tab();
      unmount();
      expect(onPersist).toHaveBeenCalledTimes(1);
    });

    it("does not replace the draft when savedValue changes during an unconfirmed save", async () => {
      const first = deferred();
      const onPersist = vi.fn(() => first.promise);
      const user = userEvent.setup();
      const { rerender } = render(
        <PersistedTextarea aria-label="Notes" savedValue="" debounceMs={0} onPersist={onPersist} />,
      );
      await user.type(screen.getByLabelText("Notes"), "mine");
      rerender(
        <PersistedTextarea
          aria-label="Notes"
          savedValue="server"
          debounceMs={0}
          onPersist={onPersist}
        />,
      );
      expect(screen.getByLabelText("Notes")).toHaveValue("mine");
    });
  });
});
