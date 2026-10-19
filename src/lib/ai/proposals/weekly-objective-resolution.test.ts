import {
  isCoveredByRescueTimeGoal,
  resolveObjectiveAgainstVocabulary,
} from "./weekly-objective-resolution";

const vocabulary = {
  category: ["Writing", "General Reference & Learning"],
  activity: ["texshop", "minizincide"],
};

const timeObjective = (
  rescuetimeKind: "activity" | "category",
  rescuetimeThing: string,
  title = "Optimisation Combinatoire - IFT-7020",
) => ({
  title,
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

describe("isCoveredByRescueTimeGoal", () => {
  const goalTitles = [
    "more than 25m on MagSelf (Weekdays)",
    "more than 1h 40m on Optimisation Combinatoire - IFT-7020 (24x7)",
    "less than 1h on Personal & Distracting (24x7)",
  ];

  it("flags a time objective whose title names a goal's subject", () => {
    expect(
      isCoveredByRescueTimeGoal(
        timeObjective("activity", "x", "Relancer MagSelf sur les jours ouvrés (2 h 05 visées)"),
        goalTitles,
      ),
    ).toBe(true);
    expect(
      isCoveredByRescueTimeGoal(
        timeObjective("activity", "x", "Optimisation Combinatoire - IFT-7020 : rattraper le temps"),
        goalTitles,
      ),
    ).toBe(true);
  });

  it("flags a time objective whose RescueTime name appears in a goal title", () => {
    expect(
      isCoveredByRescueTimeGoal(timeObjective("category", "MagSelf", "Avancer"), goalTitles),
    ).toBe(true);
  });

  it("leaves unrelated and manual objectives alone", () => {
    expect(
      isCoveredByRescueTimeGoal(timeObjective("activity", "texshop", "Ecrire"), goalTitles),
    ).toBe(false);
    expect(
      isCoveredByRescueTimeGoal(
        { ...timeObjective("activity", "x", "Relancer MagSelf"), kind: "manual" as const },
        goalTitles,
      ),
    ).toBe(false);
    expect(isCoveredByRescueTimeGoal(timeObjective("activity", "texshop", "Ecrire"), [])).toBe(
      false,
    );
  });
});
