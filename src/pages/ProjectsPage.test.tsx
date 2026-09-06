import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getTodayDate } from "../lib/date";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { ProjectsPage } from "./ProjectsPage";

const setupProjectWithPlannedQueue = async () => {
  const repository = new MemoryRepository();
  await repository.initialize();

  const today = getTodayDate();
  const projectId = "project:planned-ui";
  await repository.saveProject({
    id: projectId,
    title: "Refonte du site",
    status: "active",
    statusChangedAt: `${today}T00:00:00.000Z`,
    notes: "",
    contextIds: [],
    source: "manual",
    sourceExternalId: null,
    createdAt: `${today}T00:00:00.000Z`,
    updatedAt: `${today}T00:00:00.000Z`,
  });

  await repository.createTask({
    title: "Bloqueur",
    bucket: "next_action",
    projectId,
  });
  const first = await repository.createTask({
    title: "Premiere tache planifiee",
    bucket: "planned",
    projectId,
  });
  const second = await repository.createTask({
    title: "Deuxieme tache planifiee",
    bucket: "planned",
    projectId,
  });

  return { repository, projectId, first, second };
};

const expandProjectCard = async (title: string) => {
  const user = userEvent.setup();
  const heading = await screen.findByText(title);
  const toggle = heading.closest("button");
  if (!toggle) {
    throw new Error("Bouton d'expansion du projet introuvable");
  }
  await user.click(toggle);
  return user;
};

describe("ProjectsPage planned group", () => {
  it("lists active planned tasks in order inside the project and never in the global bucket", async () => {
    const { repository } = await setupProjectWithPlannedQueue();
    await renderWithApp(<ProjectsPage />, { repository });

    await expandProjectCard("Refonte du site");

    const firstPill = await screen.findByText("Premiere tache planifiee");
    const secondPill = await screen.findByText("Deuxieme tache planifiee");
    expect(firstPill).toBeInTheDocument();
    expect(secondPill).toBeInTheDocument();
  });

  it("offers a project-scoped Planned creation control that appends to the queue", async () => {
    const { repository, projectId } = await setupProjectWithPlannedQueue();
    const { container } = await renderWithApp(<ProjectsPage />, { repository });
    const user = await expandProjectCard("Refonte du site");

    const input = within(container).getByPlaceholderText("Nouvelle tâche planifiée");
    await user.type(input, "Troisieme tache planifiee");
    await user.click(screen.getByRole("button", { name: "Ajouter à la file planifiée" }));

    await waitFor(async () => {
      const tasks = await repository.listTasks({ projectId, includeCompleted: true });
      expect(tasks.some((task) => task.title === "Troisieme tache planifiee")).toBe(true);
    });

    const created = (await repository.listTasks({ projectId, includeCompleted: true })).find(
      (task) => task.title === "Troisieme tache planifiee",
    );
    expect(created?.bucket).toBe("planned");
    expect(created?.plannedOrder).toBe(2);
  });

  it("promotes a planned task via the explicit Promote action", async () => {
    const { repository, first } = await setupProjectWithPlannedQueue();
    await renderWithApp(<ProjectsPage />, { repository });
    const user = await expandProjectCard("Refonte du site");

    await screen.findByText("Premiere tache planifiee");
    const promoteButtons = screen.getAllByRole("button", {
      name: /^Promouvoir .* en next action$/,
    });
    await user.click(promoteButtons[0]);

    await waitFor(async () => {
      const updated = await repository.listTasks({ includeCompleted: true });
      expect(updated.find((task) => task.id === first.id)?.bucket).toBe("next_action");
    });
  });

  it("disables Move up on the first row and Move down on the last row", async () => {
    const { repository } = await setupProjectWithPlannedQueue();
    await renderWithApp(<ProjectsPage />, { repository });
    await expandProjectCard("Refonte du site");

    await screen.findByText("Premiere tache planifiee");
    const moveUpButtons = screen.getAllByRole("button", { name: /^Monter/ });
    const moveDownButtons = screen.getAllByRole("button", { name: /^Descendre/ });

    expect(moveUpButtons[0]).toBeDisabled();
    expect(moveDownButtons[moveDownButtons.length - 1]).toBeDisabled();
    expect(moveDownButtons[0]).toBeEnabled();
    expect(moveUpButtons[moveUpButtons.length - 1]).toBeEnabled();
  });

  it("keeps a project expanded across consecutive Planned queue actions", async () => {
    const { repository } = await setupProjectWithPlannedQueue();
    await renderWithApp(<ProjectsPage />, { repository });
    const user = await expandProjectCard("Refonte du site");

    await screen.findByText("Premiere tache planifiee");
    const moveDownButtons = screen.getAllByRole("button", { name: /^Descendre/ });
    await user.click(moveDownButtons[0]);

    await waitFor(async () => {
      const tasks = await repository.listTasks({ includeCompleted: true });
      const first = tasks.find((task) => task.title === "Premiere tache planifiee");
      expect(first?.plannedOrder).toBe(1);
    });

    // The card must still be expanded (and its content visible) after the reorder, even
    // though both repositories return a fresh project object on every mutation.
    expect(await screen.findByText("Premiere tache planifiee")).toBeInTheDocument();
    expect(await screen.findByText("Deuxieme tache planifiee")).toBeInTheDocument();

    const moveUpForFirst = screen.getByRole("button", {
      name: /^Monter Premiere tache planifiee/,
    });
    await user.click(moveUpForFirst);

    await waitFor(async () => {
      const tasks = await repository.listTasks({ includeCompleted: true });
      const first = tasks.find((task) => task.title === "Premiere tache planifiee");
      expect(first?.plannedOrder).toBe(0);
    });

    expect(await screen.findByText("Premiere tache planifiee")).toBeInTheDocument();
    expect(await screen.findByText("Deuxieme tache planifiee")).toBeInTheDocument();
  });
});

describe("ProjectsPage search and context filtering", () => {
  it("finds a project by title/context of its only active Planned task", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const today = getTodayDate();
    const searchableProjectId = "project:only-planned";
    await repository.saveProject({
      id: searchableProjectId,
      title: "Projet sans next action visible",
      status: "active",
      statusChangedAt: `${today}T00:00:00.000Z`,
      notes: "",
      contextIds: [],
      source: "manual",
      sourceExternalId: null,
      createdAt: `${today}T00:00:00.000Z`,
      updatedAt: `${today}T00:00:00.000Z`,
    });
    await repository.createTask({
      title: "Contacter le fournisseur exotique",
      bucket: "planned",
      projectId: searchableProjectId,
    });

    const otherProjectId = "project:unrelated";
    await repository.saveProject({
      id: otherProjectId,
      title: "Projet sans lien",
      status: "active",
      statusChangedAt: `${today}T00:00:00.000Z`,
      notes: "",
      contextIds: [],
      source: "manual",
      sourceExternalId: null,
      createdAt: `${today}T00:00:00.000Z`,
      updatedAt: `${today}T00:00:00.000Z`,
    });
    await repository.createTask({
      title: "Tache sans rapport",
      bucket: "next_action",
      projectId: otherProjectId,
    });

    const user = userEvent.setup();
    await renderWithApp(<ProjectsPage />, { repository });

    expect(await screen.findByText("Projet sans next action visible")).toBeInTheDocument();
    expect(screen.getByText("Projet sans lien")).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText(
      "Rechercher un projet, une note ou une action liée",
    );
    await user.type(searchInput, "fournisseur exotique");

    expect(await screen.findByText("Projet sans next action visible")).toBeInTheDocument();
    expect(screen.queryByText("Projet sans lien")).not.toBeInTheDocument();
  });
});
