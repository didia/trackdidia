import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App";
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

describe("work profile runtime", () => {
  it("keeps finance and pulse jobs off while reconciling GTD", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.updateSettings((settings) => ({
      ...settings,
      syncProfile: "work",
      financeEnabled: true,
      financeNotifyRunout: true,
      aiEnabled: true,
      aiPulseEnabled: true,
      aiApiKey: "test-only",
    }));
    repositoryBox.current = repository;
    const reconcile = vi.spyOn(repository, "reconcileDay");
    const snapshot = vi.spyOn(repository, "snapshotFinanceAccountBalances");
    const forecast = vi.spyOn(repository, "computeFinanceForecast");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const view = render(
      <MemoryRouter>
        <AppProvider>
          <span>ready</span>
        </AppProvider>
      </MemoryRouter>,
    );
    await screen.findByText("ready");
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reconcile).toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(forecast).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    view.unmount();
    repositoryBox.current = null;
    vi.unstubAllGlobals();
  });
});

it("work Next Actions stays free of relationship draws on load and day change", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 14, 23, 59));
  const repository = new MemoryRepository();
  await repository.initialize();
  await repository.updateSettings((current) => ({ ...current, syncProfile: "work" }));
  repositoryBox.current = repository;
  const draws = vi.spyOn(repository, "generateDailyRelationshipTasks");
  const reconcile = vi.spyOn(repository, "reconcileDay");
  const view = render(
    <MemoryRouter>
      <AppProvider>
        <AppRoutes />
      </AppProvider>
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "Le terrain exécutable du moment." });
  await waitFor(() => expect(reconcile).toHaveBeenCalled());
  const initial = reconcile.mock.calls.length;
  vi.setSystemTime(new Date(2026, 8, 15, 0, 1));
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(reconcile.mock.calls.length).toBeGreaterThan(initial));
  expect(draws).not.toHaveBeenCalled();
  view.unmount();
  repositoryBox.current = null;
  vi.useRealTimers();
});
