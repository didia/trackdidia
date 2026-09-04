import { act, render } from "@testing-library/react";
import type { PropsWithChildren, ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { AppContext, type AppContextValue } from "../app/app-context";
import { defaultAppSettings } from "../domain/daily-entry";
import { CoachPulseService } from "../lib/ai/coach-pulse-service";
import type { AiProvider } from "../lib/ai/provider";
import { buildPomodoroSessionDetails, buildPomodoroState } from "../lib/pomodoro/engine";
import { MemoryRepository } from "../lib/storage/memory-repository";

class FakeProvider implements AiProvider {
  async generateStructured() {
    return {
      text: JSON.stringify({
        stance: "open",
        headline: "Message test",
        read: "Lecture test",
        move: null,
      }),
      model: "test",
      usage: { tokensPrompt: 0, tokensCompletion: 0, latencyMs: 0 },
    };
  }
}

interface RenderOptions {
  repository?: MemoryRepository;
  route?: string;
  contextOverrides?: Partial<AppContextValue>;
}

export const renderWithApp = async (ui: ReactElement, options: RenderOptions = {}) => {
  const repository = options.repository ?? new MemoryRepository();
  await repository.initialize();

  const contextValue: AppContextValue = {
    repository,
    settings: defaultAppSettings(),
    saveSettings: async () => undefined,
    coachService: new CoachPulseService(new FakeProvider()),
    browserPreview: true,
    debugEnabled: false,
    setDebugEnabled: () => undefined,
    pomodoro: {
      state: buildPomodoroState([], []),
      sessions: buildPomodoroSessionDetails([], []),
      taskSummaries: [],
      taskOptions: [],
      currentTask: null,
      currentActivityLabel: null,
      preferredTask: null,
      preferredActivityLabel: null,
      loading: false,
      reloadError: null,
      reload: async () => undefined,
      startPomodoro: async () => undefined,
      pauseCurrent: async () => undefined,
      resumeCurrent: async () => undefined,
      skipBreak: async () => undefined,
      completeCurrentTask: async () => undefined,
      completeNow: async () => undefined,
      cancelCurrent: async () => undefined,
      switchTask: async () => undefined,
    },
    pulseRevision: 0,
    ...options.contextOverrides,
  };

  const Wrapper = ({ children }: PropsWithChildren) => (
    <MemoryRouter
      initialEntries={[options.route ?? "/"]}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <AppContext.Provider value={contextValue}>{children}</AppContext.Provider>
    </MemoryRouter>
  );

  let rendered!: ReturnType<typeof render>;

  await act(async () => {
    rendered = render(ui, { wrapper: Wrapper });
  });

  return {
    repository,
    ...rendered,
  };
};
