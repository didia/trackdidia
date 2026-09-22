import type { RescueTimeGoalsSnapshot } from "../src/domain/rescuetime-goals";

/** Pure CLI helpers for `rescuetime-goals-score.ts`, split out so tests can
 * import them without triggering the script's network side effects. */
export const parseWeekArg = (argv: string[]): string | undefined => {
  const index = argv.indexOf("--week");
  return index >= 0 ? argv[index + 1] : undefined;
};

export const formatSnapshotReport = (snapshot: RescueTimeGoalsSnapshot): string => {
  if (snapshot.fetchError) {
    return `RescueTime request failed: ${snapshot.fetchError}`;
  }

  const lines = [`RescueTime Goals — week ${snapshot.weekStartDate} → ${snapshot.weekEndDate}\n`];

  for (const item of snapshot.items) {
    lines.push(
      `${item.title}\n` +
        `  actual: ${item.actualHours.toFixed(2)}h / weekly target: ${item.weeklyTargetHours.toFixed(2)}h (${item.scheduleLabel}) → ${item.achievement.toFixed(2)}/1\n`,
    );
  }

  if (snapshot.score === null) {
    lines.push("No enabled RescueTime goals found for this week.");
    return lines.join("\n");
  }

  lines.push(
    `Weekly objectives score: ${snapshot.totalAchievement.toFixed(2)} / ${snapshot.items.length} = ${(snapshot.score * 100).toFixed(1)}%`,
  );

  return lines.join("\n");
};
