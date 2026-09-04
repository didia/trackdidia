import type { Project, ProjectStatus } from "../../domain/types";
import {
  effectiveTaskContextIds,
  formatAssociationCopy,
  projectAssignmentLabel,
  projectsForAssignment,
} from "./engine";

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
  updatedAt: "2026-03-01T10:00:00.000Z",
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
      "p-active-z",
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
      "p-hold",
    ]);
  });

  it("does not duplicate an already active current project", () => {
    expect(projectsForAssignment(allProjects, "p-active-z").map((project) => project.id)).toEqual([
      "p-active-a",
      "p-active-z",
    ]);
  });

  it("labels a retained inactive project with its status", () => {
    expect(projectAssignmentLabel(onHold)).toBe("Hold (En pause)");
    expect(projectAssignmentLabel(completed)).toBe("Done (Termine)");
    expect(projectAssignmentLabel(cancelled)).toBe("Cancel (Retire)");
    expect(projectAssignmentLabel(activeAlpha)).toBe("Alpha");
  });
});

describe("formatAssociationCopy", () => {
  it("shows the project title when the task has a project and no contexts", () => {
    expect(formatAssociationCopy("MentorIA", [], "Sans contexte")).toBe("MentorIA");
  });

  it("shows context names when the task has contexts and no project", () => {
    expect(formatAssociationCopy(null, ["Perso"], "Sans contexte")).toBe("Perso");
  });

  it("shows project then contexts when both are present", () => {
    expect(formatAssociationCopy("MentorIA", ["Perso"], "Sans contexte")).toBe("MentorIA • Perso");
  });

  it("falls back when the task has neither a project nor contexts", () => {
    expect(formatAssociationCopy(null, [], "Sans contexte")).toBe("Sans contexte");
  });
});

describe("effectiveTaskContextIds", () => {
  const persoProject = buildProject("project:mentoria", "MentorIA", "active");
  persoProject.contextIds = ["context:perso"];
  const bareProject = buildProject("project:bare", "Bare", "active");

  it("returns the task contexts when the task has its own", () => {
    expect(
      effectiveTaskContextIds({ contextIds: ["context:call"], projectId: persoProject.id }, [
        persoProject,
      ]),
    ).toEqual(["context:call"]);
  });

  it("inherits the project contexts when the task has none", () => {
    expect(
      effectiveTaskContextIds({ contextIds: [], projectId: persoProject.id }, [persoProject]),
    ).toEqual(["context:perso"]);
  });

  it("returns an empty list when the task and project have no contexts", () => {
    expect(
      effectiveTaskContextIds({ contextIds: [], projectId: bareProject.id }, [bareProject]),
    ).toEqual([]);
  });

  it("returns an empty list when the task has no project", () => {
    expect(effectiveTaskContextIds({ contextIds: [], projectId: null }, [persoProject])).toEqual(
      [],
    );
  });
});
