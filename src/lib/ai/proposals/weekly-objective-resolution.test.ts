import { resolveObjectiveAgainstVocabulary } from "./weekly-objective-resolution";

const vocabulary = {
  category: ["Writing", "General Reference & Learning"],
  activity: ["texshop", "minizincide"],
};

const timeObjective = (rescuetimeKind: "activity" | "category", rescuetimeThing: string) => ({
  title: "Optimisation Combinatoire - IFT-7020",
  kind: "time" as const,
  targetHours: 5,
  rescuetimeKind,
  rescuetimeThing,
});

describe("resolveObjectiveAgainstVocabulary", () => {
  it("snaps a case or spacing variant to the canonical RescueTime name", () => {
    expect(
      resolveObjectiveAgainstVocabulary(timeObjective("activity", " TeXShop "), vocabulary),
    ).toEqual(timeObjective("activity", "texshop"));
  });

  it("turns an invented activity into a manual objective", () => {
    expect(
      resolveObjectiveAgainstVocabulary(
        timeObjective("activity", "Optimisation Combinatoire - IFT-7020"),
        vocabulary,
      ),
    ).toEqual({
      title: "Optimisation Combinatoire - IFT-7020",
      kind: "manual",
      targetHours: null,
      rescuetimeKind: null,
      rescuetimeThing: null,
    });
  });

  it("matches within the requested kind only", () => {
    expect(
      resolveObjectiveAgainstVocabulary(timeObjective("category", "texshop"), vocabulary).kind,
    ).toBe("manual");
  });

  it("keeps the objective when no vocabulary is available", () => {
    const objective = timeObjective("activity", "MagSelf");
    expect(resolveObjectiveAgainstVocabulary(objective, null)).toBe(objective);
    expect(resolveObjectiveAgainstVocabulary(objective, undefined)).toBe(objective);
  });

  it("leaves manual and overview/productivity objectives alone", () => {
    const manual = { ...timeObjective("activity", "x"), kind: "manual" as const };
    expect(resolveObjectiveAgainstVocabulary(manual, vocabulary)).toBe(manual);
    const overview = { ...timeObjective("activity", "x"), rescuetimeKind: "overview" as const };
    expect(resolveObjectiveAgainstVocabulary(overview, vocabulary)).toBe(overview);
  });
});
