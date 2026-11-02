import { describe, expect, it, vi } from "vitest";
import { type CloseRequestEvent, type QuitWindow, registerQuitPublish } from "./quit-publish";

/** A fake window that keeps the handler so a test can send a close request. */
const fakeWindow = () => {
  let handler: ((event: CloseRequestEvent) => Promise<void> | void) | null = null;
  const unlisten = vi.fn();
  const window: QuitWindow = {
    onCloseRequested: async (next) => {
      handler = next;
      return unlisten;
    },
  };
  const close = async () => {
    const event = { preventDefault: vi.fn() };
    await handler?.(event);
    return event;
  };
  return { window, close, unlisten, registered: () => handler !== null };
};

describe("registerQuitPublish", () => {
  it("publishes with the 3 s cap when the window is closed, and does not prevent the close", async () => {
    const fake = fakeWindow();
    const quit = vi.fn(async () => undefined);
    await registerQuitPublish({
      quit,
      isTrayMode: () => false,
      loadWindow: async () => fake.window,
    });
    const event = await fake.close();
    expect(quit).toHaveBeenCalledWith(3_000);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("closes anyway when the publish fails", async () => {
    const fake = fakeWindow();
    await registerQuitPublish({
      quit: async () => {
        throw new Error("the folder is gone");
      },
      isTrayMode: () => false,
      loadWindow: async () => fake.window,
    });
    const event = await fake.close();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("in tray mode it keeps the window alive (the native handler hides it) and publishes nothing", async () => {
    const fake = fakeWindow();
    const quit = vi.fn(async () => undefined);
    await registerQuitPublish({
      quit,
      isTrayMode: () => true,
      loadWindow: async () => fake.window,
    });
    const event = await fake.close();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it("reads the tray preference at close time, not at registration", async () => {
    const fake = fakeWindow();
    let tray = false;
    const quit = vi.fn(async () => undefined);
    await registerQuitPublish({
      quit,
      isTrayMode: () => tray,
      loadWindow: async () => fake.window,
    });
    tray = true;
    await fake.close();
    expect(quit).not.toHaveBeenCalled();
  });

  it("returns the function that removes the listener", async () => {
    const fake = fakeWindow();
    const remove = await registerQuitPublish({
      quit: async () => undefined,
      isTrayMode: () => false,
      loadWindow: async () => fake.window,
    });
    remove();
    expect(fake.unlisten).toHaveBeenCalledTimes(1);
  });

  it("never rejects when there is no window to listen to", async () => {
    const remove = await registerQuitPublish({
      quit: async () => undefined,
      isTrayMode: () => false,
      loadWindow: async () => {
        throw new Error("no tauri runtime");
      },
    });
    expect(() => remove()).not.toThrow();
  });
});
