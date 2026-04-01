import { MemoryRepository } from "./memory-repository";
import { logDebug } from "../debug";
import type { AppRepository } from "./repository";
import { TauriSqliteRepository } from "./tauri-sqlite-repository";

export const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const createRepository = async (): Promise<AppRepository> => {
  logDebug("info", "storage.factory", "Creation du repository", {
    tauriRuntime: isTauriRuntime()
  });
  const repository = isTauriRuntime() ? new TauriSqliteRepository() : new MemoryRepository();
  await repository.initialize();
  logDebug("info", "storage.factory", "Repository initialise", repository.constructor.name);
  return repository;
};
