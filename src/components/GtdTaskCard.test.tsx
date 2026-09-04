import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  source: "manual",
  sourceExternalId: null,
  createdAt: now,
  updatedAt: now,
  ...overrides
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
  ...overrides
});

const buildContext = (overrides: Partial<TaskContext> = {}): TaskContext => ({
  id: "context:perso",
  name: "Perso",
  createdAt: now,
  updatedAt: now,
  ...overrides
});

const noopAsync = async () => undefined;

const renderCard = (
  task: Task,
  projects: Project[] = [],
  contexts: TaskContext[] = [],
  hideProjectTitle = false
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
    />
  );

const associationCopy = () => screen.getByText("Réviser les documents").closest("button")!.querySelector(".task-card__context-copy");

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
      [buildContext()]
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
      [buildContext()]
    );
    expect(associationCopy()).toHaveTextContent("MentorIA • Perso");
  });

  it("keeps the task context when the task already has one assigned", () => {
    renderCard(
      buildTask({ projectId: "project:mentoria", contextIds: ["context:call"] }),
      [buildProject({ contextIds: ["context:perso"] })],
      [buildContext(), buildContext({ id: "context:call", name: "Call" })]
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
    renderCard(
      buildTask({ projectId: "project:mentoria" }),
      [buildProject()],
      [],
      true
    );
    expect(associationCopy()).toHaveTextContent("Sans contexte");
    expect(associationCopy()).not.toHaveTextContent("MentorIA");
  });
});
