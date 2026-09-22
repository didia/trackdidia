import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRepository } from "../../lib/storage/memory-repository";
import { renderWithApp } from "../../test/test-utils";
import { BucketTaskListPage } from "./BucketTaskListPage";

const stamp = "2026-03-01T10:00:00.000Z";

const seedContext = async (repository: MemoryRepository, id: string, name: string) =>
  repository.saveContext({ id, name, createdAt: stamp, updatedAt: stamp });

describe("BucketTaskListPage", () => {
  describe("quickAdd", () => {
    it("disables add for whitespace-only input, then creates a task in the bucket and clears the input", async () => {
      const user = userEvent.setup();
      const repository = new MemoryRepository();
      await repository.initialize();
      await renderWithApp(
        <BucketTaskListPage bucket="waiting_for" i18nPrefix="waiting" quickAdd />,
        { repository },
      );

      const input = screen.getByPlaceholderText("Nouvelle tâche en attente");
      const add = screen.getByRole("button", { name: "Ajouter" });
      expect(add).toBeDisabled();

      await user.type(input, "   ");
      expect(add).toBeDisabled();

      await user.type(input, "Attendre la réponse");
      expect(add).toBeEnabled();
      await user.click(add);

      await waitFor(() => expect(input).toHaveValue(""));
      const created = (await repository.listTasks()).find(
        (task) => task.title === "Attendre la réponse",
      );
      expect(created?.bucket).toBe("waiting_for");
      expect(await screen.findByText("Attendre la réponse")).toBeInTheDocument();
    });
  });

  describe("contextFilter", () => {
    it("filters by direct and project-inherited contexts and marks the active chip", async () => {
      const user = userEvent.setup();
      const repository = new MemoryRepository();
      await repository.initialize();
      await seedContext(repository, "ctx:home", "Maison");
      await seedContext(repository, "ctx:work", "Bureau");
      await repository.saveProject({
        id: "project:p",
        title: "Projet P",
        status: "active",
        statusChangedAt: stamp,
        notes: "",
        contextIds: ["ctx:home"],
        source: "manual",
        sourceExternalId: null,
        createdAt: stamp,
        updatedAt: stamp,
      });
      await repository.createTask({
        title: "Directe maison",
        bucket: "waiting_for",
        contextIds: ["ctx:home"],
      });
      await repository.createTask({
        title: "Via projet",
        bucket: "waiting_for",
        projectId: "project:p",
      });
      await repository.createTask({
        title: "Directe bureau",
        bucket: "waiting_for",
        contextIds: ["ctx:work"],
      });

      const { container } = await renderWithApp(
        <BucketTaskListPage bucket="waiting_for" i18nPrefix="waiting" contextFilter />,
        { repository },
      );
      await screen.findByText("Directe bureau");

      const chips = within(container.querySelector(".tag-row") as HTMLElement);
      expect(chips.getByRole("button", { name: "Tous" })).toHaveClass("tag-chip--active");

      await user.click(chips.getByRole("button", { name: "Maison" }));

      expect(chips.getByRole("button", { name: "Maison" })).toHaveClass("tag-chip--active");
      expect(chips.getByRole("button", { name: "Tous" })).not.toHaveClass("tag-chip--active");
      expect(screen.getByText("Directe maison")).toBeInTheDocument();
      expect(screen.getByText("Via projet")).toBeInTheDocument();
      expect(screen.queryByText("Directe bureau")).not.toBeInTheDocument();

      await user.click(chips.getByRole("button", { name: "Tous" }));
      expect(screen.getByText("Directe bureau")).toBeInTheDocument();
    });
  });

  describe("pageSize", () => {
    it("renders one batch, reveals the next on load more, and keeps the full count in the subtitle", async () => {
      const user = userEvent.setup();
      const repository = new MemoryRepository();
      await repository.initialize();
      for (let index = 1; index <= 5; index += 1) {
        await repository.createTask({ title: `Entree ${index}`, bucket: "inbox" });
      }

      await renderWithApp(<BucketTaskListPage bucket="inbox" i18nPrefix="inbox" pageSize={2} />, {
        repository,
      });

      const cards = () => screen.queryAllByText(/^Entree \d$/);
      await waitFor(() => expect(cards()).toHaveLength(2));
      expect(screen.getByText(/^5 éléments dans l'inbox/)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Charger 40 de plus" }));
      expect(cards()).toHaveLength(4);
      expect(screen.getByText(/^5 éléments dans l'inbox/)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Charger 40 de plus" }));
      expect(cards()).toHaveLength(5);
      expect(screen.queryByRole("button", { name: "Charger 40 de plus" })).toBeNull();
    });
  });

  describe("references configuration", () => {
    it("renders neither the quick-add nor the filter card", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      await repository.createTask({ title: "Doc utile", bucket: "reference" });

      const { container } = await renderWithApp(
        <BucketTaskListPage bucket="reference" i18nPrefix="references" />,
        { repository },
      );

      expect(await screen.findByText("Doc utile")).toBeInTheDocument();
      expect(container.querySelector(".inline-form")).toBeNull();
      expect(container.querySelector(".tag-row")).toBeNull();
      expect(screen.queryByRole("button", { name: "Ajouter" })).toBeNull();
      expect(screen.getByText("Bibliothèque de références")).toBeInTheDocument();
    });
  });
});
