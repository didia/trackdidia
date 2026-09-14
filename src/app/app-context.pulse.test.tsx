import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { defaultAppSettings } from "../domain/daily-entry";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { TodayPage } from "../pages/TodayPage";
import { AppProvider } from "./app-context";

const repositoryBox = vi.hoisted(() => ({
  current: null as MemoryRepository | null,
}));

vi.mock("../lib/storage/factory", () => ({
  isTauriRuntime: () => false,
  createRepository: async () => {
    if (!repositoryBox.current) {
      throw new Error("Pulse test repository was not seeded");
    }
    return repositoryBox.current;
  },
}));

describe("AppProvider morning pulse refresh", () => {
  afterEach(() => {
    repositoryBox.current = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the persisted open pulse after the first-open settings write", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 14, 8, 0, 0));

    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";
    settings.aiPulseEnabled = true;
    settings.aiPulseFirstOpenAt = {};
    await repository.saveSettings(settings);
    repositoryBox.current = repository;

    let releaseFetch: ((response: Response) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            releaseFetch = resolve;
          }),
      ),
    );

    render(
      <MemoryRouter>
        <AppProvider>
          <TodayPage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "Ouvre simplement" }, { timeout: 4000 }),
    ).toBeInTheDocument();
    const resolve = releaseFetch as unknown as ((response: Response) => void) | null;
    if (!resolve) {
      throw new Error("Expected the morning pulse to call the model");
    }
    resolve(
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                stance: "open",
                headline: "Cap persiste",
                read: "Depuis hier",
                move: null,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 6 },
      }),
    );

    expect(
      await screen.findByRole("heading", { name: "Cap persiste" }, { timeout: 4000 }),
    ).toBeInTheDocument();
  });
});
