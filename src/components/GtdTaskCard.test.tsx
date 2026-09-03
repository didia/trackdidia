import { render, screen } from "@testing-library/react";
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

const renderCard = (task: Task, projects: Project[] = [], contexts: TaskContext[] = []) =>
  render(
    <GtdTaskCard
      task={task}
      projects={projects}
      contexts={contexts}
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
});
