import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { defaultAppSettings } from "../domain/daily-entry";
import { AiMemoryProfileSection } from "./AiMemoryProfileSection";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";

describe("AiMemoryProfileSection", () => {
  it("creates, edits, and archives pinned principle memories", async () => {
    const repository = new MemoryRepository();
    const user = userEvent.setup();

    await renderWithApp(
      <AiMemoryProfileSection repository={repository} memoryEnabled={true} />,
      { repository, contextOverrides: { settings: defaultAppSettings() } }
    );

    await user.type(screen.getByPlaceholderText(/Mission personnelle/i), "Ma mission");
    await user.click(screen.getByRole("button", { name: "Ajouter" }));

    await waitFor(() => {
      expect(screen.getByText("Ma mission")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Modifier" }));
    const labelInput = screen.getByDisplayValue("Ma mission");
    await user.clear(labelInput);
    await user.type(labelInput, "Mission revisee");
    await user.click(screen.getByRole("button", { name: "Mettre a jour" }));

    await waitFor(() => {
      expect(screen.getByText("Mission revisee")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Supprimer" }));

    await waitFor(async () => {
      const active = await repository.listAiMemories({ status: "active", kind: "principle", pinned: true });
      expect(active).toHaveLength(0);
    });
  });
});
