const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { armNativePomodoroAlarm, clearNativePomodoroAlarm } from "./native-alarm";

describe("native pomodoro alarm", () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invokeMock.mockReset();
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("sends host calls one at a time, in call order", async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    invokeMock.mockImplementation(
      (command: string) =>
        new Promise<void>((resolve) => {
          started.push(command);
          releases.push(resolve);
        }),
    );

    const cleared = clearNativePomodoroAlarm();
    const armed = armNativePomodoroAlarm({ endsAtMs: 1, title: "t", body: "b" });
    await Promise.resolve();
    expect(started).toEqual(["pomodoro_alarm_clear"]);

    releases[0]?.();
    await cleared;
    await vi.waitFor(() => expect(started).toEqual(["pomodoro_alarm_clear", "pomodoro_alarm_set"]));
    releases[1]?.();
    expect(await armed).toBe(true);
  });

  it("keeps ordering after a failed call and reports arming failure", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    expect(await armNativePomodoroAlarm({ endsAtMs: 1, title: "t", body: "b" })).toBe(false);
    await clearNativePomodoroAlarm();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("does nothing outside the Tauri runtime", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    expect(await armNativePomodoroAlarm({ endsAtMs: 1, title: "t", body: "b" })).toBe(false);
    await clearNativePomodoroAlarm();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
