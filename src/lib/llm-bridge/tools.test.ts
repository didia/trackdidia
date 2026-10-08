import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "../storage/memory-repository";
import { handleBridgeRequest } from "./handler";
import { BridgeRpcError, callBridgeTool, LLM_BRIDGE_TOOLS, MAX_TASKS_PER_CALL } from "./tools";

const parse = (outcome: { result: unknown }) =>
  JSON.parse((outcome.result as { content: { text: string }[] }).content[0].text);

const isError = (outcome: { result: unknown }) =>
  (outcome.result as { isError?: boolean }).isError === true;

const seedProject = async (repository: MemoryRepository, title: string, status = "active") => {
  const timestamp = "2026-03-01T10:00:00.000Z";
  return repository.saveProject({
    id: `project:${title}`,
    title,
    status: status as "active",
    statusChangedAt: timestamp,
    notes: "",
    contextIds: [],
    source: "manual",
    sourceExternalId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
};

describe("LLM bridge tools", () => {
  let repository: MemoryRepository;

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.initialize();
  });

  it("advertises the five tools with object input schemas", () => {
    expect(LLM_BRIDGE_TOOLS.map((tool) => tool.name)).toEqual([
      "list_projects",
      "list_contexts",
      "list_tasks",
      "add_tasks",
      "create_project",
    ]);
    for (const tool of LLM_BRIDGE_TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("adds tasks to the Inbox by default with LLM provenance and lifecycle events", async () => {
    const outcome = await callBridgeTool(repository, "add_tasks", {
      tasks: [{ title: "  Appeler le plombier ", notes: "Fuite sous l'évier" }],
    });

    expect(outcome.mutated).toBe(true);
    const body = parse(outcome);
    expect(body.created).toBe(1);
    expect(body.outcomes[0]).toMatchObject({ status: "created", bucket: "inbox" });

    const [task] = await repository.listTasks({ includeCompleted: true });
    expect(task).toMatchObject({
      title: "Appeler le plombier",
      notes: "Fuite sous l'évier",
      bucket: "inbox",
      status: "active",
      source: "manual",
    });
    expect(task.sourceExternalId).toMatch(/^llm:/);
    const events = await repository.listTaskEvents();
    expect(events.filter((event) => event.taskId === task.id).map((event) => event.type)).toContain(
      "task_created",
    );
  });

  it("attaches tasks to an active project by title or id and resolves contexts by name", async () => {
    await seedProject(repository, "Déménagement");
    await repository.saveContext({
      id: "context:personal",
      name: "Personal",
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-01T10:00:00.000Z",
    });

    const body = parse(
      await callBridgeTool(repository, "add_tasks", {
        tasks: [
          { title: "A", project: "déménagement", contexts: ["personal"], bucket: "next_action" },
          { title: "B", project: "project:Déménagement", contexts: ["context:personal"] },
        ],
      }),
    );

    expect(body.created).toBe(2);
    const tasks = await repository.listTasks({ includeCompleted: true });
    expect(tasks.map((task) => task.projectId)).toEqual([
      "project:Déménagement",
      "project:Déménagement",
    ]);
    expect(tasks.every((task) => task.contextIds.includes("context:personal"))).toBe(true);
  });

  it("reports per-task errors without blocking valid tasks", async () => {
    await seedProject(repository, "Archivé", "completed");

    const outcome = await callBridgeTool(repository, "add_tasks", {
      tasks: [
        { title: "Valide" },
        { title: "" },
        { title: "Contexte inconnu", contexts: ["Nope"] },
        { title: "Date invalide", deadline: "2026-02-30" },
        { title: "Planned sans projet", bucket: "planned" },
        { title: "Scheduled sans date", bucket: "scheduled" },
        { title: "Date hors scheduled", scheduledDate: "2026-05-01" },
        { title: "Bucket inconnu", bucket: "nowhere" },
        {
          title: "Heure invalide",
          bucket: "scheduled",
          scheduledDate: "2026-05-01",
          scheduledTime: "25:00",
        },
      ],
    });

    const body = parse(outcome);
    expect(body.created).toBe(1);
    expect(body.failed).toBe(8);
    expect(isError(outcome)).toBe(false);
    expect(body.outcomes.slice(1).every((o: { status: string }) => o.status === "error")).toBe(
      true,
    );
    expect(await repository.listTasks({ includeCompleted: true })).toHaveLength(1);
  });

  it("creates the task without a project when the project is unknown or inactive", async () => {
    await seedProject(repository, "Archivé", "completed");

    const body = parse(
      await callBridgeTool(repository, "add_tasks", {
        tasks: [
          { title: "Projet inconnu", project: "Nope", bucket: "next_action" },
          { title: "Projet inactif", project: "Archivé" },
        ],
      }),
    );

    expect(body.created).toBe(2);
    expect(body.failed).toBe(0);
    for (const outcome of body.outcomes) {
      expect(outcome.status).toBe("created");
      expect(outcome.warnings[0]).toContain("created without a project");
    }
    const tasks = await repository.listTasks({ includeCompleted: true });
    expect(tasks.map((task) => task.projectId)).toEqual([null, null]);
    expect(tasks.map((task) => task.bucket).sort()).toEqual(["inbox", "next_action"]);
  });

  it("falls back from planned to inbox, or scheduled when dated, if the project is unknown", async () => {
    const body = parse(
      await callBridgeTool(repository, "add_tasks", {
        tasks: [
          { title: "Sans date", bucket: "planned", project: "Nope" },
          { title: "Avec date", bucket: "planned", project: "Nope", scheduledDate: "2099-05-01" },
        ],
      }),
    );

    expect(body.created).toBe(2);
    expect(body.outcomes.map((o: { bucket: string }) => o.bucket)).toEqual(["inbox", "scheduled"]);
    expect(body.outcomes[0].warnings).toHaveLength(2);
  });

  it("creates scheduled tasks from a local date and time", async () => {
    const body = parse(
      await callBridgeTool(repository, "add_tasks", {
        tasks: [
          {
            title: "Dentiste",
            bucket: "scheduled",
            scheduledDate: "2099-05-01",
            scheduledTime: "14:30",
          },
        ],
      }),
    );

    expect(body.created).toBe(1);
    const [task] = await repository.listTasks({ includeCompleted: true });
    expect(task.bucket).toBe("scheduled");
    expect(new Date(task.scheduledFor as string).getTime()).toBe(
      new Date(2099, 4, 1, 14, 30).getTime(),
    );
  });

  it("is idempotent for a repeated clientId", async () => {
    const first = parse(
      await callBridgeTool(repository, "add_tasks", {
        tasks: [{ title: "Une fois", clientId: "k1" }],
      }),
    );
    const retry = await callBridgeTool(repository, "add_tasks", {
      tasks: [{ title: "Une fois", clientId: "k1" }],
    });

    expect(parse(retry).outcomes[0]).toMatchObject({
      status: "duplicate",
      taskId: first.outcomes[0].taskId,
    });
    expect(retry.mutated).toBe(false);
    expect(await repository.listTasks({ includeCompleted: true })).toHaveLength(1);
  });

  it("keeps committed outcomes and still reports a mutation when reconciliation fails", async () => {
    vi.spyOn(repository, "reconcileDay").mockRejectedValue(new Error("db locked"));

    const outcome = await callBridgeTool(repository, "add_tasks", {
      tasks: [{ title: "Sauvegardée" }],
    });

    expect(outcome.mutated).toBe(true);
    expect(isError(outcome)).toBe(false);
    const body = parse(outcome);
    expect(body.created).toBe(1);
    expect(body.outcomes[0]).toMatchObject({ status: "created" });
    expect(body.warning).toContain("reconciliation failed");
    expect(await repository.listTasks({ includeCompleted: true })).toHaveLength(1);
  });

  it("rejects empty and oversized batches as invalid params", async () => {
    await expect(callBridgeTool(repository, "add_tasks", { tasks: [] })).rejects.toBeInstanceOf(
      BridgeRpcError,
    );
    await expect(
      callBridgeTool(repository, "add_tasks", {
        tasks: Array.from({ length: MAX_TASKS_PER_CALL + 1 }, (_, index) => ({
          title: `t${index}`,
        })),
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(await repository.listTasks({ includeCompleted: true })).toHaveLength(0);
  });

  it("rejects an unknown tool name as invalid params", async () => {
    await expect(callBridgeTool(repository, "delete_everything", {})).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("lists projects (active by default) and contexts", async () => {
    await seedProject(repository, "Actif");
    await seedProject(repository, "Fini", "completed");
    await repository.saveContext({
      id: "context:work",
      name: "Work",
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-01T10:00:00.000Z",
    });

    expect(
      parse(await callBridgeTool(repository, "list_projects", {})).map(
        (p: { title: string }) => p.title,
      ),
    ).toEqual(["Actif"]);
    expect(
      parse(await callBridgeTool(repository, "list_projects", { status: "all" })),
    ).toHaveLength(2);
    expect(parse(await callBridgeTool(repository, "list_contexts", {}))).toEqual([
      { id: "context:work", name: "Work" },
    ]);
    expect(isError(await callBridgeTool(repository, "list_projects", { status: "bogus" }))).toBe(
      true,
    );
  });

  it("lists only active tasks with bucket filter and limit", async () => {
    const keep = await repository.createTask({ title: "Garde", bucket: "inbox" });
    const done = await repository.createTask({ title: "Fait", bucket: "inbox" });
    await repository.completeTask(done.id);
    await repository.createTask({ title: "Autre", bucket: "next_action" });

    const body = parse(
      await callBridgeTool(repository, "list_tasks", { bucket: "inbox", limit: 5 }),
    );
    expect(body.total).toBe(1);
    expect(body.tasks[0].id).toBe(keep.id);
  });

  it("creates a project once and returns the existing one for the same title", async () => {
    const first = await callBridgeTool(repository, "create_project", { title: "Voyage" });
    const second = await callBridgeTool(repository, "create_project", { title: "voyage" });

    expect(first.mutated).toBe(true);
    expect(second.mutated).toBe(false);
    expect(parse(second)).toMatchObject({ created: false, id: parse(first).id });
    expect(await repository.listProjects()).toHaveLength(1);
  });
});

describe("handleBridgeRequest", () => {
  it("serves tools/list, notifies after writes only, and rejects bad requests", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const onMutation = vi.fn();

    const listed = (await handleBridgeRequest(
      repository,
      { method: "tools/list", params: undefined },
      onMutation,
    )) as { tools: unknown[] };
    expect(listed.tools).toHaveLength(LLM_BRIDGE_TOOLS.length);

    await handleBridgeRequest(
      repository,
      { method: "tools/call", params: { name: "list_contexts", arguments: {} } },
      onMutation,
    );
    expect(onMutation).not.toHaveBeenCalled();

    await handleBridgeRequest(
      repository,
      {
        method: "tools/call",
        params: { name: "add_tasks", arguments: { tasks: [{ title: "X" }] } },
      },
      onMutation,
    );
    expect(onMutation).toHaveBeenCalledTimes(1);

    await expect(
      handleBridgeRequest(repository, { method: "resources/list", params: null }, onMutation),
    ).rejects.toMatchObject({ code: -32601 });
    await expect(
      handleBridgeRequest(repository, { method: "tools/call", params: { name: 3 } }, onMutation),
    ).rejects.toMatchObject({ code: -32602 });
  });
});
