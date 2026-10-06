import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { RitualSectionList } from "./RitualSectionList";

type Key = "bilan" | "budget";

const sections = [
  { key: "bilan" as const, title: "Bilan", subtitle: "s", prompt: "p" },
  { key: "budget" as const, title: "Budget", subtitle: "s", prompt: "p" },
];

const renderList = (notes: Record<Key, string>) =>
  render(
    <MemoryRouter>
      <RitualSectionList<Key>
        sections={sections}
        className="stack"
        scopeKey="2026-10-04"
        checklist={{ bilan: false, budget: false }}
        notes={notes}
        noteRefs={{ current: {} }}
        requiredKeys={["bilan"]}
        labels={{
          done: "Fait",
          doneAria: (section) => `Fait ${section}`,
          notesLabel: (section) => `Notes ${section}`,
          required: "Requis",
          addNote: "Ajouter une note (optionnel)",
          hideNote: "Masquer la note",
        }}
        onToggle={() => undefined}
        onPersistNote={() => undefined}
      />
    </MemoryRouter>,
  );

describe("RitualSectionList notes", () => {
  it("marks the required section and keeps its note open", () => {
    renderList({ bilan: "", budget: "" });
    expect(screen.getAllByText("Requis")).toHaveLength(1);
    expect(screen.getByLabelText("Notes Bilan")).toBeVisible();
  });

  it("folds an empty optional note until it is asked for", async () => {
    const user = userEvent.setup();
    renderList({ bilan: "", budget: "" });
    expect(screen.getByLabelText("Notes Budget")).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Ajouter une note (optionnel)" }));
    expect(screen.getByLabelText("Notes Budget")).toBeVisible();
  });

  it("shows an optional note that already has content", () => {
    renderList({ bilan: "", budget: "Revu" });
    expect(screen.getByLabelText("Notes Budget")).toBeVisible();
    expect(screen.getByLabelText("Notes Budget")).toHaveValue("Revu");
  });
});
