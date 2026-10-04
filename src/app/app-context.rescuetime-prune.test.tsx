import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { rescueTimeCredentialFingerprint } from "../lib/rescuetime/credential-fingerprint";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { AppProvider, type AppContextValue, useAppContext } from "./app-context";

const repositoryBox = vi.hoisted(() => ({ current: null as MemoryRepository | null }));

vi.mock("../lib/storage/factory", () => ({
  isTauriRuntime: () => false,
  createRepository: async () => {
    if (!repositoryBox.current) {
      throw new Error("Prune test repository was not seeded");
    }
    return repositoryBox.current;
  },
}));

describe("AppProvider updateSettings RescueTime cache pruning", () => {
  afterEach(() => {
    repositoryBox.current = null;
  });

  const mountProvider = async (repository: MemoryRepository) => {
    repositoryBox.current = repository;
    let context: AppContextValue | null = null;
    const Probe = () => {
      context = useAppContext();
      return null;
    };
    render(
      <MemoryRouter>
        <AppProvider>
          <Probe />
        </AppProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(context).not.toBeNull(), { timeout: 4000 });
    return () => context as unknown as AppContextValue;
  };

  it("prunes to the new key's fingerprint when the key changes", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const prune = vi.spyOn(repository, "pruneRescueTimeSnapshotCache");
    const getContext = await mountProvider(repository);

    await act(async () => {
      await getContext().updateSettings((current) => ({
        ...current,
        rescuetimeApiKey: " new-key ",
      }));
    });

    expect(prune).toHaveBeenCalledWith(await rescueTimeCredentialFingerprint("new-key"));

    await act(async () => {
      await getContext().updateSettings((current) => ({ ...current, rescuetimeApiKey: "" }));
    });
    expect(prune).toHaveBeenLastCalledWith(null);
  });

  it("does not prune when the key is unchanged and swallows a prune rejection", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const prune = vi
      .spyOn(repository, "pruneRescueTimeSnapshotCache")
      .mockRejectedValue(new Error("disk full"));
    const getContext = await mountProvider(repository);

    await act(async () => {
      await getContext().updateSettings((current) => ({ ...current, aiEnabled: true }));
    });
    expect(prune).not.toHaveBeenCalled();

    await act(async () => {
      await expect(
        getContext().updateSettings((current) => ({ ...current, rescuetimeApiKey: "another" })),
      ).resolves.toMatchObject({ rescuetimeApiKey: "another" });
    });
    expect(prune).toHaveBeenCalledTimes(1);
    expect((await repository.getSettings()).rescuetimeApiKey).toBe("another");
  });
});
