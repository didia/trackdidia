import type { CreateTaskInput, Project, ProjectStatus, Task, TaskBucket } from "../../domain/types";
import { buildIsoFromLocalDateAndTime, getTodayDate } from "../date";
import { buildContextId, createEntityId, nowIso } from "../gtd/shared";
import type { AppRepository } from "../storage/repository";

/** JSON-RPC error carrying the code the Rust transport forwards to the MCP client. */
export class BridgeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "BridgeRpcError";
  }
}

const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;

export const MAX_TASKS_PER_CALL = 50;
const MAX_TITLE_LENGTH = 300;
const MAX_NOTES_LENGTH = 10_000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const NOTES_PREVIEW_LENGTH = 500;
const LLM_SOURCE_PREFIX = "llm:";

const bucketValues: TaskBucket[] = [
  "inbox",
  "next_action",
  "scheduled",
  "waiting_for",
  "someday_maybe",
  "reference",
  "planned",
];
const projectStatusValues: ProjectStatus[] = ["active", "on_hold", "completed", "cancelled"];

export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const taskInputSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "Short, actionable task title (starts with a verb). Required.",
    },
    notes: { type: "string", description: "Optional details, links or context." },
    bucket: {
      type: "string",
      enum: bucketValues,
      description:
        "Where the task lands. Defaults to 'inbox' (unclarified capture, reviewed later by the " +
        "user). Use 'scheduled' only with scheduledDate, and 'planned' only with a project.",
    },
    project: {
      type: "string",
      description:
        "Existing active project: its id or its exact title (see list_projects). " +
        "If no active project matches, the task is still created, without a project, and the result carries a warning.",
    },
    contexts: {
      type: "array",
      items: { type: "string" },
      description: "Existing context names or ids (see list_contexts).",
    },
    deadline: { type: "string", description: "Optional due date, YYYY-MM-DD." },
    scheduledDate: {
      type: "string",
      description: "Local date YYYY-MM-DD. Required when bucket is 'scheduled'.",
    },
    scheduledTime: { type: "string", description: "Local time HH:mm. Defaults to 09:00." },
    clientId: {
      type: "string",
      description:
        "Optional idempotency key. Re-sending the same clientId returns the existing task " +
        "instead of creating a duplicate. Use it when a call might be retried.",
    },
  },
  required: ["title"],
  additionalProperties: false,
};

export const LLM_BRIDGE_TOOLS: BridgeTool[] = [
  {
    name: "list_projects",
    description:
      "List the user's TrackDidia projects (multi-step outcomes). Call this before add_tasks " +
      "when tasks should be attached to a project.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: [...projectStatusValues, "all"],
          description: "Defaults to 'active'.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_contexts",
    description: "List the user's GTD contexts (flat tags such as Personal or Computer).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_tasks",
    description:
      "List active (not completed or cancelled) tasks, newest first. Use it to avoid adding " +
      "duplicates. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        bucket: { type: "string", enum: bucketValues },
        projectId: { type: "string" },
        search: { type: "string", description: "Case-insensitive text search." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT },
      },
      additionalProperties: false,
    },
  },
  {
    name: "add_tasks",
    description:
      "Add one or more tasks to TrackDidia. By default they go to the Inbox so the user can " +
      `clarify them later. At most ${MAX_TASKS_PER_CALL} tasks per call; each task succeeds or ` +
      "fails independently and the result reports every outcome.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: MAX_TASKS_PER_CALL,
          items: taskInputSchema,
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },
  {
    name: "create_project",
    description:
      "Create an active project, or return the existing active project with the same title. " +
      "Add its tasks afterwards with add_tasks.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        notes: { type: "string" },
        contexts: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
];

type Args = Record<string, unknown>;

const asRecord = (value: unknown, label: string): Args => {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeRpcError(INVALID_PARAMS, `${label} must be an object`);
  }
  return value as Args;
};

const optionalString = (args: Args, key: string, maxLength: number): string | undefined => {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${key} is longer than ${maxLength} characters`);
  }
  return value;
};

const requiredTitle = (args: Args): string => {
  const title = optionalString(args, "title", MAX_TITLE_LENGTH)?.trim();
  if (!title) {
    throw new Error("title is required");
  }
  return title;
};

const isValidLocalDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
};

const isValidLocalTime = (value: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

interface Lookups {
  projects: Project[];
  contexts: { id: string; name: string }[];
}

/** An unmatched or inactive project is not an error: the task is still captured without one. */
const findActiveProject = (value: string, projects: Project[]): Project | null => {
  const wanted = value.trim().toLowerCase();
  const active = projects.filter((project) => project.status === "active");
  return (
    active.find((project) => project.id === value.trim()) ??
    active.find((project) => project.title.trim().toLowerCase() === wanted) ??
    null
  );
};

const resolveContextIds = (values: unknown, contexts: Lookups["contexts"]): string[] => {
  if (values === undefined || values === null) {
    return [];
  }
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error("contexts must be an array of strings");
  }
  const ids = new Set<string>();
  for (const raw of values as string[]) {
    const wanted = raw.trim().toLowerCase();
    const match =
      contexts.find((context) => context.id === raw.trim()) ??
      contexts.find((context) => context.name.trim().toLowerCase() === wanted) ??
      contexts.find((context) => context.id === buildContextId(raw));
    if (!match) {
      throw new Error(`Unknown context "${raw}". Call list_contexts.`);
    }
    ids.add(match.id);
  }
  return [...ids];
};

const taskSummary = (task: Task, notesLimit = NOTES_PREVIEW_LENGTH) => ({
  id: task.id,
  title: task.title,
  bucket: task.bucket,
  status: task.status,
  projectId: task.projectId,
  contextIds: task.contextIds,
  deadline: task.deadline,
  scheduledFor: task.scheduledFor,
  notes: task.notes.length > notesLimit ? `${task.notes.slice(0, notesLimit)}…` : task.notes,
});

const textResult = (data: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

const listProjects = async (repository: AppRepository, args: Args) => {
  const status = optionalString(args, "status", 20) ?? "active";
  if (status !== "all" && !projectStatusValues.includes(status as ProjectStatus)) {
    throw new Error(`status must be one of ${[...projectStatusValues, "all"].join(", ")}`);
  }
  const [projects, contexts] = await Promise.all([
    repository.listProjects(status === "all" ? undefined : { status: status as ProjectStatus }),
    repository.listContexts(),
  ]);
  const contextNames = new Map(contexts.map((context) => [context.id, context.name]));
  return textResult(
    projects.map((project) => ({
      id: project.id,
      title: project.title,
      status: project.status,
      notes:
        project.notes.length > NOTES_PREVIEW_LENGTH
          ? `${project.notes.slice(0, NOTES_PREVIEW_LENGTH)}…`
          : project.notes,
      contexts: project.contextIds.map((id) => contextNames.get(id) ?? id),
    })),
  );
};

const listContexts = async (repository: AppRepository) =>
  textResult(
    (await repository.listContexts()).map((context) => ({ id: context.id, name: context.name })),
  );

const listTasks = async (repository: AppRepository, args: Args) => {
  const bucket = optionalString(args, "bucket", 20);
  if (bucket !== undefined && !bucketValues.includes(bucket as TaskBucket)) {
    throw new Error(`bucket must be one of ${bucketValues.join(", ")}`);
  }
  const limitValue = args.limit;
  if (
    limitValue !== undefined &&
    (typeof limitValue !== "number" || !Number.isInteger(limitValue) || limitValue < 1)
  ) {
    throw new Error("limit must be a positive integer");
  }
  const limit = Math.min((limitValue as number | undefined) ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const tasks = await repository.listTasks({
    includeCompleted: false,
    bucket: bucket as TaskBucket | undefined,
    projectId: optionalString(args, "projectId", 200),
    search: optionalString(args, "search", MAX_TITLE_LENGTH),
  });
  const active = tasks
    .filter((task) => task.status === "active")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return textResult({
    total: active.length,
    returned: Math.min(active.length, limit),
    tasks: active.slice(0, limit).map((task) => taskSummary(task)),
  });
};

interface AddTaskOutcome {
  index: number;
  status: "created" | "duplicate" | "error";
  taskId?: string;
  title?: string;
  bucket?: TaskBucket;
  warnings?: string[];
  error?: string;
}

const buildTaskInput = (
  raw: unknown,
  lookups: Lookups,
): { input: CreateTaskInput; warnings: string[] } => {
  const warnings: string[] = [];
  const args = asRecord(raw, "task");
  const title = requiredTitle(args);
  const bucketValue = optionalString(args, "bucket", 20) ?? "inbox";
  if (!bucketValues.includes(bucketValue as TaskBucket)) {
    throw new Error(`bucket must be one of ${bucketValues.join(", ")}`);
  }
  let bucket = bucketValue as TaskBucket;

  const projectRef = optionalString(args, "project", 300);
  if (bucket === "planned" && !projectRef) {
    throw new Error("bucket 'planned' requires a project");
  }
  const project = projectRef ? findActiveProject(projectRef, lookups.projects) : null;
  if (projectRef && !project) {
    warnings.push(
      `No active project matches "${projectRef}"; the task was created without a project.`,
    );
    if (bucket === "planned") {
      // Planned is a project-only queue, so keep the date if there is one, else just capture it.
      bucket = optionalString(args, "scheduledDate", 10) ? "scheduled" : "inbox";
      warnings.push(`bucket 'planned' needs a project; used '${bucket}' instead.`);
    }
  }

  const deadline = optionalString(args, "deadline", 10) ?? null;
  if (deadline !== null && !isValidLocalDate(deadline)) {
    throw new Error("deadline must be a valid YYYY-MM-DD date");
  }

  const scheduledDate = optionalString(args, "scheduledDate", 10);
  const scheduledTime = optionalString(args, "scheduledTime", 5);
  if (scheduledDate !== undefined && !isValidLocalDate(scheduledDate)) {
    throw new Error("scheduledDate must be a valid YYYY-MM-DD date");
  }
  if (scheduledTime !== undefined && !isValidLocalTime(scheduledTime)) {
    throw new Error("scheduledTime must be HH:mm");
  }
  if (bucket === "scheduled" && !scheduledDate) {
    throw new Error("bucket 'scheduled' requires scheduledDate");
  }
  if (scheduledDate && bucket !== "scheduled" && bucket !== "planned") {
    throw new Error("scheduledDate is only valid with bucket 'scheduled' or 'planned'");
  }

  return {
    warnings,
    input: {
      title,
      notes: optionalString(args, "notes", MAX_NOTES_LENGTH)?.trim() ?? "",
      bucket,
      projectId: project?.id ?? null,
      contextIds: resolveContextIds(args.contexts, lookups.contexts),
      deadline,
      scheduledFor: scheduledDate
        ? buildIsoFromLocalDateAndTime(scheduledDate, scheduledTime ?? "09:00")
        : null,
      source: "manual",
    },
  };
};

const addTasks = async (repository: AppRepository, args: Args) => {
  const rawTasks = args.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw new BridgeRpcError(INVALID_PARAMS, "tasks must be a non-empty array");
  }
  if (rawTasks.length > MAX_TASKS_PER_CALL) {
    throw new BridgeRpcError(
      INVALID_PARAMS,
      `At most ${MAX_TASKS_PER_CALL} tasks per call (received ${rawTasks.length})`,
    );
  }

  const [projects, contexts, existingTasks] = await Promise.all([
    repository.listProjects(),
    repository.listContexts(),
    repository.listTasks({ includeCompleted: true }),
  ]);
  const lookups: Lookups = { projects, contexts };
  const existingByExternalId = new Map(
    existingTasks
      .filter((task) => task.sourceExternalId?.startsWith(LLM_SOURCE_PREFIX))
      .map((task) => [task.sourceExternalId as string, task]),
  );

  const outcomes: AddTaskOutcome[] = [];
  let created = 0;
  for (const [index, raw] of rawTasks.entries()) {
    try {
      const clientId = optionalString(asRecord(raw, "task"), "clientId", 200)?.trim();
      const externalId = `${LLM_SOURCE_PREFIX}${clientId || createEntityId("task")}`;
      const duplicate = clientId ? existingByExternalId.get(externalId) : undefined;
      if (duplicate) {
        outcomes.push({
          index,
          status: "duplicate",
          taskId: duplicate.id,
          title: duplicate.title,
          bucket: duplicate.bucket,
        });
        continue;
      }
      const { input, warnings } = buildTaskInput(raw, lookups);
      const task = await repository.createTask({ ...input, sourceExternalId: externalId });
      existingByExternalId.set(externalId, task);
      created += 1;
      outcomes.push({
        index,
        status: "created",
        taskId: task.id,
        title: task.title,
        bucket: task.bucket,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    } catch (error) {
      outcomes.push({
        index,
        status: "error",
        error: error instanceof Error ? error.message : "Unexpected error",
      });
    }
  }

  if (created > 0) {
    // Same follow-up as a user mutation: a task dated today may already be due for promotion.
    await repository.reconcileDay(getTodayDate());
  }
  const failed = outcomes.filter((outcome) => outcome.status === "error").length;
  return {
    created,
    result: textResult(
      {
        created,
        duplicates: outcomes.filter((o) => o.status === "duplicate").length,
        failed,
        outcomes,
      },
      failed > 0 && created === 0,
    ),
  };
};

const createProject = async (repository: AppRepository, args: Args) => {
  const title = requiredTitle(args);
  const [projects, contexts] = await Promise.all([
    repository.listProjects(),
    repository.listContexts(),
  ]);
  const existing = projects.find(
    (project) =>
      project.status === "active" && project.title.trim().toLowerCase() === title.toLowerCase(),
  );
  if (existing) {
    return {
      created: false,
      result: textResult({ created: false, id: existing.id, title: existing.title }),
    };
  }
  const timestamp = nowIso();
  const project = await repository.saveProject({
    id: createEntityId("project"),
    title,
    status: "active",
    statusChangedAt: timestamp,
    notes: optionalString(args, "notes", MAX_NOTES_LENGTH)?.trim() ?? "",
    contextIds: resolveContextIds(args.contexts, contexts),
    source: "manual",
    sourceExternalId: `${LLM_SOURCE_PREFIX}${createEntityId("project")}`,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return {
    created: true,
    result: textResult({ created: true, id: project.id, title: project.title }),
  };
};

export interface BridgeCallOutcome {
  result: unknown;
  /** True when the call wrote data, so mounted GTD views must reload. */
  mutated: boolean;
}

export const callBridgeTool = async (
  repository: AppRepository,
  name: string,
  rawArgs: unknown,
): Promise<BridgeCallOutcome> => {
  const args = asRecord(rawArgs, "arguments");
  try {
    switch (name) {
      case "list_projects":
        return { result: await listProjects(repository, args), mutated: false };
      case "list_contexts":
        return { result: await listContexts(repository), mutated: false };
      case "list_tasks":
        return { result: await listTasks(repository, args), mutated: false };
      case "add_tasks": {
        const { created, result } = await addTasks(repository, args);
        return { result, mutated: created > 0 };
      }
      case "create_project": {
        const { created, result } = await createProject(repository, args);
        return { result, mutated: created };
      }
      default:
        throw new BridgeRpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof BridgeRpcError) {
      throw error;
    }
    // Tool-level failures are reported to the model as a normal result so it can self-correct.
    return {
      result: textResult(
        { error: error instanceof Error ? error.message : "Unexpected error" },
        true,
      ),
      mutated: false,
    };
  }
};

export { INVALID_PARAMS, METHOD_NOT_FOUND };
