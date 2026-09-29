/**
 * Score weekly objectives from RescueTime Goals using the same
 * `RescueTimeGoalsService` scoring logic as the Weekly Review page.
 *
 * Usage: npm run rescuetime:score -- [--week YYYY-MM-DD]
 *
 * Reads RESCUETIME_API_KEY from the environment or the repo-root `.env`.
 * The key is never logged.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getTodayDate } from "../src/lib/date";
import { RescueTimeGoalsService } from "../src/lib/rescuetime/rescuetime-goals-service";
import { MemoryRepository } from "../src/lib/storage/memory-repository";
import { formatSnapshotReport, parseWeekArg } from "./rescuetime-goals-report";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const loadEnvFile = (): void => {
  try {
    const raw = readFileSync(join(repoRoot, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional when the key is already in the environment.
  }
};

loadEnvFile();

const main = async (): Promise<void> => {
  const apiKey = process.env.RESCUETIME_API_KEY?.trim();
  if (!apiKey) {
    console.error("Missing RESCUETIME_API_KEY");
    process.exit(1);
    return;
  }

  // A throwaway in-memory repository lets the CLI reuse RescueTimeGoalsService
  // (the exact scoring path the Weekly Review page calls) without touching
  // the local SQLite database.
  const repository = new MemoryRepository();
  await repository.initialize();
  await repository.saveSettings({
    ...(await repository.getSettings()),
    rescuetimeApiKey: apiKey,
  });

  const service = new RescueTimeGoalsService(repository);
  const weekArg = parseWeekArg(process.argv) ?? getTodayDate();
  const snapshot = await service.computeGoalsSnapshot(weekArg);

  console.log(formatSnapshotReport(snapshot));

  if (snapshot.fetchError) {
    process.exit(1);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
