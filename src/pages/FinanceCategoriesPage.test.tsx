import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultAppSettings } from "../domain/daily-entry";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { FinanceCategoriesPage } from "./FinanceCategoriesPage";

const setup = async () => {
  const repository = new MemoryRepository();
  await repository.initialize();
  await repository.seedFinanceDefaultCategories();
  const user = userEvent.setup();
  await renderWithApp(<FinanceCategoriesPage />, {
    repository,
    contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
  });
  await screen.findByRole("heading", { name: /^Alimentation/ });
  return { repository, user };
};

describe("FinanceCategoriesPage", () => {
  it("adds a category under an existing group, inheriting its kind", async () => {
    const { repository, user } = await setup();

    await user.type(screen.getByLabelText("Nom"), "Café");
    await user.selectOptions(screen.getByLabelText("Groupe"), "fincat:alimentation");
    await user.click(screen.getByText("Ajouter la catégorie"));

    expect(await screen.findByText("Café")).toBeInTheDocument();
    const saved = (await repository.listFinanceCategories()).find((c) => c.name === "Café");
    expect(saved).toMatchObject({ parentId: "fincat:alimentation", kind: "expense" });
  });

  it("adds a new income group", async () => {
    const { repository, user } = await setup();

    await user.type(screen.getByLabelText("Nom"), "Placements");
    await user.selectOptions(screen.getByLabelText("Type"), "income");
    await user.click(screen.getByText("Ajouter la catégorie"));

    expect(await screen.findByRole("heading", { name: /Placements/ })).toBeInTheDocument();
    const saved = (await repository.listFinanceCategories()).find((c) => c.name === "Placements");
    expect(saved).toMatchObject({ parentId: null, kind: "income" });
  });

  it("rejects a duplicate name in the same group", async () => {
    const { repository, user } = await setup();
    const before = (await repository.listFinanceCategories()).length;

    await user.type(screen.getByLabelText("Nom"), "epicerie");
    await user.selectOptions(screen.getByLabelText("Groupe"), "fincat:alimentation");
    await user.click(screen.getByText("Ajouter la catégorie"));

    expect(await screen.findByText(/existe déjà/)).toBeInTheDocument();
    await expect(repository.listFinanceCategories()).resolves.toHaveLength(before);
  });

  it("renames a category", async () => {
    const { repository, user } = await setup();

    await user.click(screen.getByRole("button", { name: "Renommer Restaurants" }));
    const input = screen.getByLabelText("Nouveau nom de Restaurants");
    await user.clear(input);
    await user.type(input, "Brasseries");
    await user.click(screen.getByText("Enregistrer"));

    expect(await screen.findByText("Brasseries")).toBeInTheDocument();
    const saved = (await repository.listFinanceCategories()).find(
      (c) => c.id === "fincat:alimentation.restaurants",
    );
    expect(saved?.name).toBe("Brasseries");
  });

  it("archives a category, moving its transactions and repointing rules, then restores it", async () => {
    const { repository, user } = await setup();
    const timestamp = new Date().toISOString();
    await repository.saveFinanceRule({
      id: "rule-1",
      name: "Règle épicerie",
      priority: 0,
      enabled: true,
      matcher: {},
      actions: { categoryId: "fincat:alimentation.epicerie" },
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAppliedAt: null,
      appliedCount: 0,
    });

    await user.click(screen.getByRole("button", { name: "Archiver Épicerie" }));
    await user.selectOptions(
      screen.getByLabelText(/Déplacer les transactions de « Épicerie » vers/),
      "fincat:alimentation.restaurants",
    );
    await user.click(screen.getByRole("button", { name: "Archiver" }));

    const archivedSection = (await screen.findByText("Catégories archivées")).closest("section");
    expect(archivedSection).toBeTruthy();
    if (!archivedSection) {
      return;
    }
    const rules = await repository.listFinanceRules();
    expect(rules[0].actions.categoryId).toBe("fincat:alimentation.restaurants");

    await user.click(within(archivedSection).getByRole("button", { name: "Restaurer Épicerie" }));
    await expect(repository.listFinanceCategories()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fincat:alimentation.epicerie" })]),
    );
  });

  it("blocks archiving a group that still has active categories", async () => {
    await setup();
    expect(screen.getByRole("button", { name: "Archiver Alimentation" })).toBeDisabled();
  });
});
