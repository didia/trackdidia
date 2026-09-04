import { invoke } from "@tauri-apps/api/core";
import { logDebug } from "../debug";
import { MemoryRepository } from "./memory-repository";
import type { AppRepository, NativeStoragePaths } from "./repository";
import { TauriSqliteRepository } from "./tauri-sqlite-repository";

export const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const createRepository = async (): Promise<AppRepository> => {
  logDebug("info", "storage.factory", "Creation du repository", {
    tauriRuntime: isTauriRuntime(),
  });

  if (isTauriRuntime()) {
    const storageInfo = await invoke<NativeStoragePaths>("resolve_storage_paths");
    logDebug("info", "storage.factory", "Stockage SQLite resolu", storageInfo);
    const repository = new TauriSqliteRepository(storageInfo.connectionString);
    await repository.initialize();
    logDebug("info", "storage.factory", "Repository initialise", repository.constructor.name);
    return repository;
  }

  const repository = new MemoryRepository();
  await repository.initialize();
  logDebug("info", "storage.factory", "Repository initialise", repository.constructor.name);
  return repository;
};
