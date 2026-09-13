import { createEmptyDailyEntry, updateNote } from "../../../domain/daily-entry";
import { MemoryRepository } from "../../storage/memory-repository";
import { buildPastorSnapshot, resolvePastorSnapshotInputs } from "./pastor-snapshot";

const PROMPT_VERSION = "pastor_verse.v1";

describe("resolvePastorSnapshotInputs + buildPastorSnapshot", () => {
  it("includes an inclusive 7-day-plus-today window", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveDailyEntry(createEmptyDailyEntry("2026-08-22"));
    await repository.saveDailyEntry(createEmptyDailyEntry("2026-08-29"));

    const inputs = await resolvePastorSnapshotInputs(repository, "2026-08-29", PROMPT_VERSION);
    const dates = inputs.days.map((day) => day.date);
    expect(dates).toContain("2026-08-22");
    expect(dates).toContain("2026-08-29");
  });

  it("includes notes only at full scope", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    let entry = createEmptyDailyEntry("2026-08-29");
    entry = updateNote(entry, "morningIntention", "Texte libre du jour.");
    await repository.saveDailyEntry(entry);

    const inputs = await resolvePastorSnapshotInputs(repository, "2026-08-29", PROMPT_VERSION);

    const fullSnapshot = buildPastorSnapshot(inputs, "full");
    const metricsSnapshot = buildPastorSnapshot(inputs, "metrics");
    const structureSnapshot = buildPastorSnapshot(inputs, "metrics_and_structure");

    expect(JSON.stringify(fullSnapshot)).toContain("Texte libre du jour.");
    expect(JSON.stringify(metricsSnapshot)).not.toContain("Texte libre du jour.");
    expect(JSON.stringify(structureSnapshot)).not.toContain("Texte libre du jour.");
    expect(metricsSnapshot.days.every((day) => day.notes === undefined)).toBe(true);
  });

  it("caps note length at 1,200 characters", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    let entry = createEmptyDailyEntry("2026-08-29");
    entry = updateNote(entry, "morningIntention", "a".repeat(2_000));
    await repository.saveDailyEntry(entry);

    const inputs = await resolvePastorSnapshotInputs(repository, "2026-08-29", PROMPT_VERSION);
    const today = inputs.days.find((day) => day.date === "2026-08-29");
    const note = today?.notes.find((item) => item.key === "morningIntention");
    expect(note?.text.length).toBe(1_200);
  });

  it("keeps the catalog view free of note text and translations", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const inputs = await resolvePastorSnapshotInputs(repository, "2026-08-29", PROMPT_VERSION);
    const snapshot = buildPastorSnapshot(inputs, "full");
    const serialized = JSON.stringify(snapshot.catalog);
    expect(serialized).not.toContain('"note"');
    expect(serialized).not.toContain('"translations"');
  });
});
