import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CloseRequestEvent,
  type ExitBridge,
  type QuitWindow,
  registerExitPublish,
  registerQuitPublish,
} from "./quit-publish";

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

/**
 * The tray's Quitter exits the process without closing the window, so the close handler above never
 * runs for it. These tests drive the handshake with a fake event bus and fake commands, and a model of
 * the host side (`desktop_shell.rs`: `request_quit`, the 4 s timer, `desktop_exit`) written from the
 * same contract. The Rust itself is not compiled or run here.
 */
const HOST_TIMEOUT_MS = 4_000;

const fakeHost = () => {
  const log: string[] = [];
  let listener: (() => void) | null = null;
  let handshake = false;
  let exited = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exit = () => {
    exited += 1;
    clearTimeout(timer);
  };
  const bridge: ExitBridge = {
    onQuitRequested: async (handler) => {
      log.push("listen");
      listener = handler;
      return () => {
        log.push("unlisten");
        listener = null;
      };
    },
    setHandshake: async (enabled) => {
      log.push(`handshake:${enabled}`);
      handshake = enabled;
    },
    exit: async () => {
      log.push("exit");
      exit();
    },
  };
  /** The tray's Quitter, as `request_quit` does it. */
  const trayQuit = () => {
    log.push("tray-quit");
    if (!handshake || listener === null) {
      exit();
      return;
    }
    listener();
    timer = setTimeout(exit, HOST_TIMEOUT_MS);
  };
  return {
    bridge,
    log,
    trayQuit,
    handshake: () => handshake,
    listening: () => listener !== null,
    exited: () => exited,
  };
};

describe("registerExitPublish (the tray's Quitter)", () => {
  const removers: (() => void)[] = [];
  const register = async (
    host: ReturnType<typeof fakeHost>,
    quit: (capMs: number) => Promise<void>,
    capMs?: number,
  ) => {
    const remove = await registerExitPublish({
      quit,
      loadBridge: async () => host.bridge,
      ...(capMs === undefined ? {} : { capMs }),
    });
    removers.push(remove);
    return remove;
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const remove of removers.splice(0)) remove();
    vi.useRealTimers();
  });

  it("listens first, then tells the host to wait for it", async () => {
    const host = fakeHost();
    await register(host, async () => undefined);
    expect(host.log).toEqual(["listen", "handshake:true"]);
  });

  it("publishes with the 3 s cap, THEN exits, when the tray's Quitter is chosen", async () => {
    const host = fakeHost();
    let finishPublish: () => void = () => undefined;
    const quit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPublish = resolve;
        }),
    );
    await register(host, quit);

    host.trayQuit();
    await vi.advanceTimersByTimeAsync(0);
    expect(quit).toHaveBeenCalledWith(3_000);
    expect(host.exited()).toBe(0);
    finishPublish();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.log.slice(-2)).toEqual(["tray-quit", "exit"]);
    expect(host.exited()).toBe(1);
  });

  it("exits at the cap when the publish never ends, well before the host's own timer", async () => {
    const host = fakeHost();
    await register(host, () => new Promise<void>(() => undefined));
    host.trayQuit();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(host.exited()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.exited()).toBe(1);
    expect(HOST_TIMEOUT_MS).toBeGreaterThan(3_000);
  });

  it("exits when the publish fails", async () => {
    const host = fakeHost();
    await register(host, async () => {
      throw new Error("the folder is gone");
    });
    host.trayQuit();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.exited()).toBe(1);
  });

  it("a failing exit command leaves the host's timer to exit, and nothing is thrown", async () => {
    const host = fakeHost();
    host.bridge.exit = async () => {
      throw new Error("ipc down");
    };
    await register(host, async () => undefined);
    host.trayQuit();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.exited()).toBe(0);
    await vi.advanceTimersByTimeAsync(HOST_TIMEOUT_MS);
    expect(host.exited()).toBe(1);
  });

  it("a webview that never answers is exited by the host after its timer", async () => {
    const host = fakeHost();
    await register(host, async () => undefined);
    host.bridge.exit = () => new Promise<void>(() => undefined);
    host.trayQuit();
    await vi.advanceTimersByTimeAsync(HOST_TIMEOUT_MS - 1);
    expect(host.exited()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.exited()).toBe(1);
  });

  it("publishes once however many times the event arrives", async () => {
    const host = fakeHost();
    const quit = vi.fn(async () => undefined);
    await register(host, quit);
    host.trayQuit();
    host.trayQuit();
    await vi.advanceTimersByTimeAsync(0);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("switches the handshake off BEFORE it stops listening, so the host never waits for nobody", async () => {
    const host = fakeHost();
    const remove = await register(host, async () => undefined);
    host.log.length = 0;
    remove();
    remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.log).toEqual(["handshake:false", "unlisten"]);
    expect(host.handshake()).toBe(false);
    expect(host.listening()).toBe(false);

    const quit = vi.fn(async () => undefined);
    host.trayQuit();
    expect(host.exited()).toBe(1);
    expect(quit).not.toHaveBeenCalled();
  });

  it("with sync off (never registered) the host is never asked to wait and exits at once", async () => {
    const host = fakeHost();
    host.trayQuit();
    expect(host.exited()).toBe(1);
    expect(host.log).toEqual(["tray-quit"]);
  });

  it("a registration torn down late does not switch off its successor's handshake", async () => {
    const host = fakeHost();
    const first = await register(host, async () => undefined);
    const second = await register(host, async () => undefined);
    first();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.handshake()).toBe(true);
    second();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.handshake()).toBe(false);
  });

  it("without an event bus it registers nothing, calls no command, and never rejects", async () => {
    const remove = await registerExitPublish({
      quit: async () => undefined,
      loadBridge: async () => {
        throw new Error("no tauri runtime");
      },
    });
    expect(() => remove()).not.toThrow();
  });

  it("when the event cannot be listened to, no handshake is requested", async () => {
    const host = fakeHost();
    host.bridge.onQuitRequested = async () => {
      throw new Error("event bus down");
    };
    await register(host, async () => undefined);
    expect(host.log).toEqual([]);
    host.trayQuit();
    expect(host.exited()).toBe(1);
  });

  it("when the handshake command fails the registration is undone and Quitter exits at once", async () => {
    const host = fakeHost();
    const original = host.bridge.setHandshake;
    host.bridge.setHandshake = async (enabled) => {
      if (enabled) throw new Error("command unavailable");
      return original(enabled);
    };
    await register(host, async () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.listening()).toBe(false);
    expect(host.handshake()).toBe(false);
    host.trayQuit();
    expect(host.exited()).toBe(1);
  });
});

/**
 * A rebuilt lifecycle: the old registration is released (its handshake-off command is still in flight)
 * while its successor registers. Quitter in that window reaches every listener still attached; only the
 * successor may publish and exit. The host here keeps ONE flag and a listener set, and the handshake
 * commands complete only when the test says so.
 */
describe("registerExitPublish across a rebuilt lifecycle", () => {
  const removers: (() => void)[] = [];
  const worlds: { settle: () => Promise<void> }[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    for (const remove of removers.splice(0)) remove();
    // The module serializes handshake commands: leave none unfinished for the next test.
    for (const world of worlds.splice(0)) await world.settle();
    vi.useRealTimers();
  });

  const deferredHost = () => {
    const listeners = new Set<() => void>();
    const pending: { enabled: boolean; done: () => void }[] = [];
    const host = { handshake: true, exits: 0, log: [] as string[] };
    const bridge: ExitBridge = {
      onQuitRequested: async (handler) => {
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
        };
      },
      setHandshake: (enabled) =>
        new Promise<void>((resolve) => {
          pending.push({
            enabled,
            done: () => {
              host.handshake = enabled;
              host.log.push(`handshake:${enabled}`);
              resolve();
            },
          });
        }),
      exit: async () => {
        host.exits += 1;
        host.log.push("exit");
      },
    };
    /** The tray's Quitter: the event reaches every attached listener when the host waits. */
    const trayQuit = () => {
      if (!host.handshake) {
        host.exits += 1;
        host.log.push("exit-now");
        return;
      }
      for (const listener of [...listeners]) listener();
    };
    const settle = async () => {
      await vi.advanceTimersByTimeAsync(0);
      while (pending.length > 0) {
        pending.shift()?.done();
        await vi.advanceTimersByTimeAsync(0);
      }
    };
    const world = { bridge, host, trayQuit, settle, listeners, pending };
    worlds.push(world);
    return world;
  };

  it("Quitter during the old teardown: the successor publishes first and exits once; the old one does nothing", async () => {
    const world = deferredHost();
    const oldQuit = vi.fn(async () => undefined);
    const registeringOld = registerExitPublish({
      quit: oldQuit,
      loadBridge: async () => world.bridge,
    });
    await vi.advanceTimersByTimeAsync(0);
    await world.settle();
    const releaseOld = await registeringOld;
    expect(world.host.handshake).toBe(true);

    // The settings changed: the old registration is released (handshake-off is now in flight)...
    releaseOld();
    let finishNewPublish: () => void = () => undefined;
    const newQuit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishNewPublish = resolve;
        }),
    );
    // ... and the successor registers meanwhile.
    const registeringNew = registerExitPublish({
      quit: newQuit,
      loadBridge: async () => world.bridge,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(world.listeners.size).toBe(2);
    expect(world.host.handshake).toBe(true);

    // Quitter arrives while the native flag is still true and both listeners are attached.
    world.trayQuit();
    await vi.advanceTimersByTimeAsync(0);
    expect(oldQuit).not.toHaveBeenCalled();
    expect(newQuit).toHaveBeenCalledTimes(1);
    expect(world.host.exits).toBe(0);

    // The successor's publish is still unresolved: nothing may have exited. Then it finishes.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(world.host.exits).toBe(0);
    finishNewPublish();
    await vi.advanceTimersByTimeAsync(0);
    expect(world.host.exits).toBe(1);
    expect(world.host.log.at(-1)).toBe("exit");

    await world.settle();
    removers.push(await registeringNew);
    expect(world.host.exits).toBe(1);
  });

  it("when the released registration was the only one, its late listener does nothing; once the host flag is off Quitter exits at once", async () => {
    const world = deferredHost();
    const quit = vi.fn(async () => undefined);
    const registering = registerExitPublish({ quit, loadBridge: async () => world.bridge });
    await vi.advanceTimersByTimeAsync(0);
    await world.settle();
    const release = await registering;

    release();
    // The handshake-off command has not completed: the listener is still attached but inert.
    expect(world.listeners.size).toBe(1);
    world.trayQuit();
    await vi.advanceTimersByTimeAsync(3_500);
    expect(quit).not.toHaveBeenCalled();
    expect(world.host.exits).toBe(0); // the host's own 4 s timer is what ends this quit

    await world.settle();
    expect(world.host.handshake).toBe(false);
    expect(world.listeners.size).toBe(0);
    world.trayQuit();
    expect(world.host.exits).toBe(1);
    expect(world.host.log.at(-1)).toBe("exit-now");
    expect(quit).not.toHaveBeenCalled();
  });
});
