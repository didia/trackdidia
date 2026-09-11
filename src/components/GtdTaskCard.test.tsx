import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { Project, Task, TaskContext } from "../domain/types";
import { GtdTaskCard } from "./GtdTaskCard";

const now = "2026-03-01T10:00:00.000Z";

const buildTask = (overrides: Partial<Task> = {}): Task => ({
  id: "task:default",
  title: "Réviser les documents",
  notes: "",
  status: "active",
  bucket: "inbox",
  contextIds: [],
  projectId: null,
  parentTaskId: null,
  scheduledFor: null,
  deadline: null,
  recurringTemplateId: null,
  recurrenceDueDate: null,
  isRecurringInstance: false,
  completedAt: null,
  recurrenceGroupId: null,
  pendingPastRecurrences: 0,
  plannedOrder: null,
  source: "manual",
  sourceExternalId: null,
  sourceUrl: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const buildProject = (overrides: Partial<Project> = {}): Project => ({
  id: "project:mentoria",
  title: "MentorIA",
  status: "active",
  statusChangedAt: now,
  notes: "",
  contextIds: [],
  source: "manual",
  sourceExternalId: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const buildContext = (overrides: Partial<TaskContext> = {}): TaskContext => ({
  id: "context:perso",
  name: "Perso",
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const noopAsync = async () => undefined;

const renderCard = (
  task: Task,
  projects: Project[] = [],
  contexts: TaskContext[] = [],
  hideProjectTitle = false,
) =>
  render(
    <GtdTaskCard
      task={task}
      projects={projects}
      contexts={contexts}
      hideProjectTitle={hideProjectTitle}
      onSave={noopAsync}
      onSaveContext={async (context) => context}
      onComplete={noopAsync}
      onCancel={noopAsync}
      onClearPastRecurrences={noopAsync}
    />,
  );

const associationCopy = () =>
  screen
    .getByText("Réviser les documents")
    .closest("button")
    ?.querySelector(".task-card__context-copy");

describe("GtdTaskCard collapsed association copy", () => {
  it("shows Sans contexte when the task has neither a project nor contexts", () => {
    renderCard(buildTask());
    expect(associationCopy()).toHaveTextContent("Sans contexte");
  });

  it("shows the project title instead of Sans contexte when the task has a project and no contexts", () => {
    renderCard(buildTask({ projectId: "project:mentoria" }), [buildProject()]);
    expect(associationCopy()).toHaveTextContent("MentorIA");
    expect(associationCopy()).not.toHaveTextContent("Sans contexte");
  });

  it("shows project then context when both are present", () => {
    renderCard(
      buildTask({ projectId: "project:mentoria", contextIds: ["context:perso"] }),
      [buildProject()],
      [buildContext()],
    );
    expect(associationCopy()).toHaveTextContent("MentorIA • Perso");
  });

  it("shows the context name when the task has a context and no project", () => {
    renderCard(buildTask({ contextIds: ["context:perso"] }), [], [buildContext()]);
    expect(associationCopy()).toHaveTextContent("Perso");
    expect(associationCopy()).not.toHaveTextContent("Sans contexte");
  });

  it("inherits the project context when the task has a project and no context of its own", () => {
    renderCard(
      buildTask({ projectId: "project:mentoria" }),
      [buildProject({ contextIds: ["context:perso"] })],
      [buildContext()],
    );
    expect(associationCopy()).toHaveTextContent("MentorIA • Perso");
  });

  it("keeps the task context when the task already has one assigned", () => {
    renderCard(
      buildTask({ projectId: "project:mentoria", contextIds: ["context:call"] }),
      [buildProject({ contextIds: ["context:perso"] })],
      [buildContext(), buildContext({ id: "context:call", name: "Call" })],
    );
    expect(associationCopy()).toHaveTextContent("MentorIA • Call");
    expect(associationCopy()).not.toHaveTextContent("Perso");
  });

  it("keeps the saved collapsed copy after an unsaved project change", async () => {
    const user = userEvent.setup();
    renderCard(buildTask(), [buildProject()]);

    expect(associationCopy()).toHaveTextContent("Sans contexte");

    await user.click(screen.getByRole("button", { name: /^Ouvrir$/ }));
    await user.selectOptions(screen.getByLabelText("Projet"), "project:mentoria");
    await user.click(screen.getByRole("button", { name: /^Refermer$/ }));

    expect(associationCopy()).toHaveTextContent("Sans contexte");
    expect(associationCopy()).not.toHaveTextContent("MentorIA");
  });

  it("omits the project title when hideProjectTitle is set", () => {
    renderCard(buildTask({ projectId: "project:mentoria" }), [buildProject()], [], true);
    expect(associationCopy()).toHaveTextContent("Sans contexte");
    expect(associationCopy()).not.toHaveTextContent("MentorIA");
  });
});

const futureIsoDate = () => {
  const future = new Date();
  future.setDate(future.getDate() + 5);
  return future.toISOString();
};

const pastIsoDate = () => {
  const past = new Date();
  past.setDate(past.getDate() - 5);
  return past.toISOString();
};

describe("GtdTaskCard planned bucket", () => {
  it("shows the reused scheduledFor as a local date with no overdue styling when it is not in the past", () => {
    const { container } = renderCard(
      buildTask({
        bucket: "planned",
        projectId: "project:mentoria",
        plannedOrder: 0,
        scheduledFor: futureIsoDate(),
      }),
      [buildProject()],
    );
    const pill = container.querySelector(".task-card__date-pill");
    expect(pill).not.toBeNull();
    expect(pill?.className).not.toContain("task-card__date-pill--overdue");
  });

  it("shows a no-date state when the planned task has no scheduledFor", () => {
    renderCard(buildTask({ bucket: "planned", projectId: "project:mentoria", plannedOrder: 0 }), [
      buildProject(),
    ]);
    expect(screen.getByText("Sans date")).toBeInTheDocument();
  });

  it("renders the overdue pill only for an active planned task whose local date is before today", () => {
    const { container } = renderCard(
      buildTask({
        bucket: "planned",
        projectId: "project:mentoria",
        plannedOrder: 0,
        scheduledFor: pastIsoDate(),
      }),
      [buildProject()],
    );
    const pill = container.querySelector(".task-card__date-pill");
    expect(pill?.className).toContain("task-card__date-pill--overdue");
    expect(pill?.textContent).toMatch(/dépassée/);
  });

  it("does not offer Planned as a bucket choice without a project", async () => {
    const user = userEvent.setup();
    renderCard(buildTask());
    await user.click(screen.getByRole("button", { name: /^Ouvrir$/ }));
    const options = screen.getByLabelText("Bucket GTD").querySelectorAll("option");
    expect([...options].map((option) => option.getAttribute("value"))).not.toContain("planned");
  });

  it("offers Promote / Move up / Move down with accessible labels and disabled boundaries", () => {
    render(
      <GtdTaskCard
        task={buildTask({ bucket: "planned", projectId: "project:mentoria", plannedOrder: 0 })}
        projects={[buildProject()]}
        contexts={[]}
        onSave={noopAsync}
        onSaveContext={async (context) => context}
        onComplete={noopAsync}
        onCancel={noopAsync}
        onClearPastRecurrences={noopAsync}
        onPromotePlannedTask={noopAsync}
        onMovePlannedTask={async () => undefined}
        plannedPosition={{ isFirst: true, isLast: false }}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Promouvoir Réviser les documents en next action" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: /Monter Réviser les documents/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Descendre Réviser les documents/ })).toBeEnabled();
  });

  it("gives each Promote button a task-specific accessible name when several Planned rows are shown", () => {
    const project = buildProject();
    const firstTask = buildTask({
      id: "task:first",
      title: "Preparer le brief",
      bucket: "planned",
      projectId: project.id,
      plannedOrder: 0,
    });
    const secondTask = buildTask({
      id: "task:second",
      title: "Relire le contrat",
      bucket: "planned",
      projectId: project.id,
      plannedOrder: 1,
    });

    render(
      <>
        <GtdTaskCard
          task={firstTask}
          projects={[project]}
          contexts={[]}
          onSave={noopAsync}
          onSaveContext={async (context) => context}
          onComplete={noopAsync}
          onCancel={noopAsync}
          onClearPastRecurrences={noopAsync}
          onPromotePlannedTask={noopAsync}
          onMovePlannedTask={async () => undefined}
          plannedPosition={{ isFirst: true, isLast: false }}
        />
        <GtdTaskCard
          task={secondTask}
          projects={[project]}
          contexts={[]}
          onSave={noopAsync}
          onSaveContext={async (context) => context}
          onComplete={noopAsync}
          onCancel={noopAsync}
          onClearPastRecurrences={noopAsync}
          onPromotePlannedTask={noopAsync}
          onMovePlannedTask={async () => undefined}
          plannedPosition={{ isFirst: false, isLast: true }}
        />
      </>,
    );

    expect(
      screen.getByRole("button", { name: "Promouvoir Preparer le brief en next action" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Promouvoir Relire le contrat en next action" }),
    ).toBeInTheDocument();
  });

  it("setting scheduledFor via the date input keeps the task Planned instead of moving it to Scheduled", async () => {
    const user = userEvent.setup();
    renderCard(buildTask({ bucket: "planned", projectId: "project:mentoria", plannedOrder: 0 }), [
      buildProject(),
    ]);
    await user.click(screen.getByRole("button", { name: /^Ouvrir$/ }));

    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    await user.type(dateInput, "2026-04-15");

    expect((screen.getByLabelText("Bucket GTD") as HTMLSelectElement).value).toBe("planned");
  });

  it("clearing the project on a Planned task moves it off Planned so saving does not throw", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    render(
      <GtdTaskCard
        task={buildTask({ bucket: "planned", projectId: "project:mentoria", plannedOrder: 0 })}
        projects={[buildProject()]}
        contexts={[]}
        onSave={onSave}
        onSaveContext={async (context) => context}
        onComplete={noopAsync}
        onCancel={noopAsync}
        onClearPastRecurrences={noopAsync}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^Ouvrir$/ }));
    await user.selectOptions(screen.getByLabelText("Projet"), "");
    await user.click(screen.getByRole("button", { name: /^Enregistrer$/ }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "next_action",
        projectId: null,
        scheduledFor: null,
        plannedOrder: null,
      }),
    );
    await screen.findByRole("button", { name: /^Enregistrer$/ });
    expect(screen.queryByRole("button", { name: /Enregistrement/ })).not.toBeInTheDocument();
  });
});

describe("GtdTaskCard next-action age", () => {
  const renderWithAge = (nextActionAgeDays: number | undefined) =>
    render(
      <GtdTaskCard
        task={buildTask({ bucket: "next_action" })}
        projects={[]}
        contexts={[]}
        nextActionAgeDays={nextActionAgeDays}
        onSave={noopAsync}
        onSaveContext={async (context) => context}
        onComplete={noopAsync}
        onCancel={noopAsync}
        onClearPastRecurrences={noopAsync}
      />,
    );

  it("omits the age pill when nextActionAgeDays is not provided", () => {
    renderWithAge(undefined);
    expect(screen.queryByText("Aujourd'hui")).not.toBeInTheDocument();
    expect(screen.queryByText(/Depuis/)).not.toBeInTheDocument();
  });

  it("shows Aujourd'hui when the task entered next actions today", () => {
    renderWithAge(0);
    expect(screen.getByText("Aujourd'hui")).toBeInTheDocument();
  });

  it("shows a singular day count", () => {
    renderWithAge(1);
    expect(screen.getByText("Depuis 1 jour")).toBeInTheDocument();
  });

  it("shows a plural day count", () => {
    renderWithAge(3);
    expect(screen.getByText("Depuis 3 jours")).toBeInTheDocument();
  });
});
