import { describe, expect, it } from "vitest";
import { buildRitualSections } from "./ritual-sections";

describe("buildRitualSections", () => {
  const translate = (key: string) => `t:${key}`;

  it("translates title, subtitle and prompt under the surface prefix", () => {
    const sections = buildRitualSections([{ key: "bilan" }], translate, "weekly.ritual");
    expect(sections).toEqual([
      {
        key: "bilan",
        title: "t:weekly.ritual.bilan.title",
        subtitle: "t:weekly.ritual.bilan.subtitle",
        prompt: "t:weekly.ritual.bilan.prompt",
        linkTo: undefined,
        linkLabel: undefined,
      },
    ]);
  });

  it("translates the link label only for sections that declare a link", () => {
    const sections = buildRitualSections(
      [
        { key: "journaux", linkTo: "/semaine", linkKey: "monthly.ritual.journaux.link" },
        { key: "finances" },
      ],
      translate,
      "monthly.ritual",
    );
    expect(sections[0]).toMatchObject({
      linkTo: "/semaine",
      linkLabel: "t:monthly.ritual.journaux.link",
    });
    expect(sections[1]?.linkTo).toBeUndefined();
    expect(sections[1]?.linkLabel).toBeUndefined();
  });

  it("keeps the order of the meta", () => {
    const sections = buildRitualSections(
      [{ key: "b" }, { key: "a" }, { key: "c" }],
      translate,
      "x",
    );
    expect(sections.map((section) => section.key)).toEqual(["b", "a", "c"]);
  });
});
