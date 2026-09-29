import { render, screen } from "@testing-library/react";
import { defaultAppSettings } from "../domain/daily-entry";
import type { PastorVerseBody, PastorVerseResult } from "../domain/types";
import { PastorVerseCard } from "./PastorVerseCard";

const listBody = (overrides: Partial<PastorVerseBody> = {}): PastorVerseBody => ({
  pick: "list",
  verseId: "mat-11-28-30",
  reference: { book: "MAT", chapter: 11, verseStart: 28, verseEnd: 30 },
  principleKey: "priereDuSoir",
  intent: "reinforcement",
  title: "Matthieu 11, 28-30",
  explanation: "Le repos recu du Christ n'est pas un abandon de tes devoirs.",
  practice: "Depose ton telephone avant de dormir.",
  ...overrides,
});

const resultFrom = (body: PastorVerseBody): PastorVerseResult => ({
  message: null,
  body,
  verse: null,
  source: "local",
});

const renderCard = (body: PastorVerseBody) =>
  render(
    <PastorVerseCard
      title="Verset du jour"
      result={resultFrom(body)}
      loading={false}
      regenerating={false}
      settings={defaultAppSettings()}
      aiConfigured={false}
      onRegenerate={() => undefined}
      onAddToCatalog={() => undefined}
      addingToCatalog={false}
      addedToCatalog={false}
      addToCatalogError={null}
    />,
  );

describe("PastorVerseCard", () => {
  it("shows the formatted reference once when title repeats it", () => {
    renderCard(listBody());

    expect(screen.getAllByText("Matthieu 11, 28-30")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Matthieu 11, 28-30" })).not.toBeInTheDocument();
  });

  it("still shows a distinct short title below the reference", () => {
    renderCard(listBody({ title: "Repos dans le Christ" }));

    expect(screen.getByText("Matthieu 11, 28-30")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Repos dans le Christ" })).toBeInTheDocument();
  });
});
