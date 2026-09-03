import type { Project, ProjectStatus } from "../../domain/types";
import { formatTaskCardAssociationCopy, projectsForAssignment, projectAssignmentLabel } from "./engine";

const buildProject = (id: string, title: string, status: ProjectStatus): Project => ({
  id,
  title,
  status,
  statusChangedAt: "2026-03-01T10:00:00.000Z",
  notes: "",
  contextIds: [],
  source: "manual",
  sourceExternalId: null,
  createdAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-01T10:00:00.000Z"
});

describe("projectsForAssignment", () => {
  const activeAlpha = buildProject("p-active-a", "Alpha", "active");
  const activeZeta = buildProject("p-active-z", "Zeta", "active");
  const onHold = buildProject("p-hold", "Hold", "on_hold");
  const completed = buildProject("p-done", "Done", "completed");
  const cancelled = buildProject("p-cancel", "Cancel", "cancelled");
  const allProjects = [cancelled, completed, onHold, activeZeta, activeAlpha];

  it("suggests only active projects, sorted by title", () => {
    expect(projectsForAssignment(allProjects).map((project) => project.id)).toEqual([
      "p-active-a",
      "p-active-z"
    ]);
  });

  it("omits on hold, completed, and cancelled projects", () => {
    const ids = projectsForAssignment(allProjects).map((project) => project.id);
    expect(ids).not.toContain("p-hold");
    expect(ids).not.toContain("p-done");
    expect(ids).not.toContain("p-cancel");
  });

  it("keeps the currently assigned inactive project in the list", () => {
    expect(projectsForAssignment(allProjects, "p-hold").map((project) => project.id)).toEqual([
      "p-active-a",
      "p-active-z",
      "p-hold"
    ]);
  });

  it("does not duplicate an already active current project", () => {
    expect(projectsForAssignment(allProjects, "p-active-z").map((project) => project.id)).toEqual([
      "p-active-a",
      "p-active-z"
    ]);
  });

  it("labels a retained inactive project with its status", () => {
    expect(projectAssignmentLabel(onHold)).toBe("Hold (En pause)");
    expect(projectAssignmentLabel(completed)).toBe("Done (Termine)");
    expect(projectAssignmentLabel(cancelled)).toBe("Cancel (Retire)");
    expect(projectAssignmentLabel(activeAlpha)).toBe("Alpha");
  });
});

describe("formatTaskCardAssociationCopy", () => {
  it("shows the project title when the task has a project and no contexts", () => {
    expect(formatTaskCardAssociationCopy("MentorIA", [], "Sans contexte")).toBe("MentorIA");
  });

  it("shows context names when the task has contexts and no project", () => {
    expect(formatTaskCardAssociationCopy(null, ["Perso"], "Sans contexte")).toBe("Perso");
  });

  it("shows project then contexts when both are present", () => {
    expect(formatTaskCardAssociationCopy("MentorIA", ["Perso"], "Sans contexte")).toBe("MentorIA • Perso");
  });

  it("falls back when the task has neither a project nor contexts", () => {
    expect(formatTaskCardAssociationCopy(null, [], "Sans contexte")).toBe("Sans contexte");
  });
});
