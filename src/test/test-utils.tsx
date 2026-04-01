import { MemoryRouter } from "react-router-dom";
import { act, render } from "@testing-library/react";
import { defaultAppSettings } from "../domain/daily-entry";
import { AiCoachService } from "../lib/ai/coach-service";
import { AppContext, type AppContextValue } from "../app/app-context";
import { MemoryRepository } from "../lib/storage/memory-repository";
import type { PropsWithChildren, ReactElement } from "react";

class FakeProvider {
  async generate(): Promise<string> {
    return "Message test";
  }
}

interface RenderOptions {
  repository?: MemoryRepository;
  route?: string;
  contextOverrides?: Partial<AppContextValue>;
}

export const renderWithApp = async (
  ui: ReactElement,
  options: RenderOptions = {}
) => {
  const repository = options.repository ?? new MemoryRepository();
  await repository.initialize();

  const contextValue: AppContextValue = {
    repository,
    settings: defaultAppSettings(),
    saveSettings: async () => undefined,
    coachService: new AiCoachService(new FakeProvider()),
    browserPreview: true,
    debugEnabled: false,
    setDebugEnabled: () => undefined,
    ...options.contextOverrides
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
    ...rendered
  };
};
