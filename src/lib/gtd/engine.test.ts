import type { Project, ProjectStatus } from "../../domain/types";
import { projectsForAssignment } from "./engine";

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
});
