import { MemoryRepository } from "./memory-repository";
import { describeRepositoryContract } from "./repository.contract";

describeRepositoryContract("MemoryRepository", async () => {
  const repository = new MemoryRepository();
  await repository.initialize();
  return repository;
});
