import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptyWeeklyObjective } from "../domain/weekly-objectives";
import { ObjectiveRescueTimeEditor } from "./ObjectiveRescueTimeEditor";

const objective = createEmptyWeeklyObjective({
  id: "objective-1",
  title: "Relancer MagSelf",
  kind: "time",
  targetHours: 2,
  rescuetimeKind: "activity",
  rescuetimeThing: "MagSelf",
});

const entries = [
  { name: "texshop", seconds: 7200, hours: 2 },
  { name: "minizincide", seconds: 3600, hours: 1 },
];

describe("ObjectiveRescueTimeEditor", () => {
  it("saves the RescueTime name picked from the real list", async () => {
    const loadEntries = vi.fn(async () => entries);
    const onSave = vi.fn(async () => undefined);
    render(
      <ObjectiveRescueTimeEditor objective={objective} loadEntries={loadEntries} onSave={onSave} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Modifier le suivi RescueTime" }));
    await screen.findByRole("option", { name: /texshop/ });

    const save = screen.getByRole("button", { name: "Enregistrer" });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Nom suivi par RescueTime"), {
      target: { value: "texshop" },
    });
    fireEvent.click(save);

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        rescuetimeKind: "activity",
        rescuetimeThing: "texshop",
      }),
    );
    expect(loadEntries).toHaveBeenCalledTimes(1);
  });

  it("filters the list and reloads names when the kind changes", async () => {
    const loadEntries = vi.fn(async (kind: string) =>
      kind === "category" ? [{ name: "Writing", seconds: 60, hours: 0.02 }] : entries,
    );
    render(
      <ObjectiveRescueTimeEditor
        objective={objective}
        loadEntries={loadEntries}
        onSave={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Modifier le suivi RescueTime" }));
    await screen.findByRole("option", { name: /texshop/ });

    fireEvent.change(screen.getByLabelText("Filtrer"), { target: { value: "mini" } });
    expect(screen.queryByRole("option", { name: /texshop/ })).toBeNull();
    expect(screen.getByRole("option", { name: /minizincide/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Type de suivi"), { target: { value: "category" } });
    await screen.findByText(/Chargement|Writing/);
    expect(loadEntries).toHaveBeenLastCalledWith("category");
  });

  it("explains when RescueTime names cannot be loaded", async () => {
    render(
      <ObjectiveRescueTimeEditor
        objective={objective}
        loadEntries={async () => {
          throw new Error("down");
        }}
        onSave={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Modifier le suivi RescueTime" }));

    expect(
      await screen.findByText("Impossible de charger les noms RescueTime."),
    ).toBeInTheDocument();
  });
});
