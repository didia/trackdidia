import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultAppSettings } from "../domain/daily-entry";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { FinanceCategoriesPage } from "./FinanceCategoriesPage";

const setup = async (prepare?: (repository: MemoryRepository) => Promise<void>) => {
  const repository = new MemoryRepository();
  await repository.initialize();
  await repository.seedFinanceDefaultCategories();
  await prepare?.(repository);
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

  it("never offers Non catégorisé for an income category, and blocks archiving without a target", async () => {
    const { repository, user } = await setup();
    await user.click(screen.getByRole("button", { name: "Archiver Salaire" }));
    const select = screen.getByLabelText(/Déplacer les transactions de « Salaire » vers/);
    expect(within(select).getByRole("option", { name: "Autre revenu" })).toBeInTheDocument();
    expect(within(select).queryByRole("option", { name: "Non catégorisé" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Annuler" }));
    await user.click(screen.getByRole("button", { name: "Archiver Autre revenu" }));
    await user.click(screen.getByRole("button", { name: "Archiver" }));
    await screen.findByText("Catégories archivées");

    await user.click(screen.getByRole("button", { name: "Archiver Salaire" }));
    expect(screen.getByText(/Aucune catégorie de même type/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archiver" })).toBeDisabled();
    const salary = (await repository.listFinanceCategories()).find(
      (c) => c.id === "fincat:revenu.salaire",
    );
    expect(salary?.archived).toBe(false);
  });

  it("never creates a child under a group archived after it was selected", async () => {
    const emptyGroup = {
      id: "fincat:vide",
      name: "Vide",
      parentId: null,
      kind: "expense" as const,
      archived: false,
      isSystem: false,
      defersToNextMonth: false,
      sortOrder: 99,
      createdAt: "",
      updatedAt: "",
    };
    const { repository, user } = await setup(async (repo) => {
      await repo.saveFinanceCategory(emptyGroup);
      await repo.saveFinanceCategory({ ...emptyGroup, id: "fincat:vide2", name: "Vide 2" });
    });

    // Archived from this screen: the stale selection is cleared on reload.
    await user.selectOptions(screen.getByLabelText("Groupe"), "fincat:vide");
    await user.click(screen.getByRole("button", { name: "Archiver Vide" }));
    await user.click(screen.getByRole("button", { name: "Archiver" }));
    await screen.findByText("Catégories archivées");
    expect(screen.getByLabelText("Groupe")).toHaveValue("");

    // Archived behind the screen's back: the save re-checks the parent.
    await user.selectOptions(screen.getByLabelText("Groupe"), "fincat:vide2");
    await repository.saveFinanceCategory({
      ...emptyGroup,
      id: "fincat:vide2",
      name: "Vide 2",
      archived: true,
    });
    await user.type(screen.getByLabelText("Nom"), "Orphelin");
    await user.click(screen.getByText("Ajouter la catégorie"));

    expect(await screen.findByText(/n'est plus disponible/)).toBeInTheDocument();
    const all = await repository.listFinanceCategories(true);
    expect(all.find((c) => c.name === "Orphelin")).toBeUndefined();
  });

  it("ignores a second Add click while the first save is pending", async () => {
    const { repository, user } = await setup();
    const save = repository.saveFinanceCategory.bind(repository);
    let calls = 0;
    repository.saveFinanceCategory = async (category) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return save(category);
    };

    await user.type(screen.getByLabelText("Nom"), "Boulangerie");
    await user.selectOptions(screen.getByLabelText("Groupe"), "fincat:alimentation");
    const button = screen.getByText("Ajouter la catégorie");
    await user.dblClick(button);

    await screen.findByText("Boulangerie");
    expect(calls).toBe(1);
    const matches = (await repository.listFinanceCategories()).filter(
      (c) => c.name === "Boulangerie",
    );
    expect(matches).toHaveLength(1);
  });

  it("blocks archiving a group that still has active categories", async () => {
    await setup();
    expect(screen.getByRole("button", { name: "Archiver Alimentation" })).toBeDisabled();
  });
});
