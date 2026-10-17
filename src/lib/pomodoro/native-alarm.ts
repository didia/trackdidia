import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logDebug } from "../debug";
import { isTauriRuntime } from "../storage/factory";

const ALARM_FIRED_EVENT = "pomodoro-alarm-fired";

// Tauri does not guarantee that two in-flight invokes reach the host in call order. A "clear"
// from an effect cleanup overtaking the "set" of the next effect would cancel the new alarm,
// so host calls are sent strictly one after another.
let hostCalls: Promise<unknown> = Promise.resolve();
const inOrder = <T>(call: () => Promise<T>): Promise<T> => {
  const result = hostCalls.then(call, call);
  hostCalls = result.catch(() => {});
  return result;
};

/**
 * Arms the native deadline alarm. The Rust host then sends the completion notification (with
 * its system sound) on time even while the webview's JS timers are throttled in the background.
 * Resolves false in the browser preview or when the host call fails, so the caller keeps
 * announcing from JS.
 */
export const armNativePomodoroAlarm = async (alarm: {
  endsAtMs: number;
  title: string;
  body: string;
}): Promise<boolean> => {
  if (!isTauriRuntime()) {
    return false;
  }
  try {
    await inOrder(() => invoke("pomodoro_alarm_set", alarm));
    return true;
  } catch (error) {
    logDebug("error", "pomodoro.alarm", "Alarme native indisponible", error);
    return false;
  }
};

/** Cancels the native alarm if its deadline is still in the future. */
export const clearNativePomodoroAlarm = async (): Promise<void> => {
  if (!isTauriRuntime()) {
    return;
  }
  try {
    await inOrder(() => invoke("pomodoro_alarm_clear"));
  } catch (error) {
    logDebug("error", "pomodoro.alarm", "Annulation de l'alarme native impossible", error);
  }
};

/** Calls `handler` when the native alarm fires; returns an unsubscribe function. */
export const listenNativePomodoroAlarm = (handler: () => void): (() => void) => {
  if (!isTauriRuntime()) {
    return () => {};
  }
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void listen(ALARM_FIRED_EVENT, handler)
    .then((dispose) => {
      if (disposed) {
        dispose();
      } else {
        unlisten = dispose;
      }
    })
    .catch((error) => {
      logDebug("error", "pomodoro.alarm", "Ecoute de l'alarme native impossible", error);
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
};
