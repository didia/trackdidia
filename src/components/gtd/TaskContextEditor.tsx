import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskContext } from "../../domain/types";
import { buildContextId, nowIso } from "../../lib/gtd/shared";

interface TaskContextEditorProps {
  contexts: TaskContext[];
  onSaveContext: (context: TaskContext) => Promise<TaskContext>;
  /** Called with the id of a context that was just created or matched by name. */
  onContextAdded: (contextId: string) => void;
}

/** Create/rename contexts from within a task card. */
export const TaskContextEditor = ({
  contexts,
  onSaveContext,
  onContextAdded,
}: TaskContextEditorProps) => {
  const { t } = useTranslation("gtd");
  const { t: tCommon } = useTranslation("common");
  const [contextEditorOpen, setContextEditorOpen] = useState(false);
  const [newContextName, setNewContextName] = useState("");
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({});
  const [contextSavingId, setContextSavingId] = useState<string | null>(null);
  const [contextError, setContextError] = useState("");

  useEffect(() => {
    setContextDrafts(Object.fromEntries(contexts.map((context) => [context.id, context.name])));
  }, [contexts]);

  const saveExistingContext = async (context: TaskContext) => {
    setContextSavingId(context.id);
    setContextError("");

    try {
      await onSaveContext({
        ...context,
        name: (contextDrafts[context.id] ?? context.name).trim(),
        updatedAt: nowIso(),
      });
    } catch (error) {
      setContextError(error instanceof Error ? error.message : t("errors.saveContext"));
    } finally {
      setContextSavingId(null);
    }
  };

  const createNewContext = async () => {
    const nextName = newContextName.trim();

    if (!nextName) {
      return;
    }

    const existingContext = contexts.find(
      (context) => context.name.trim().toLocaleLowerCase() === nextName.toLocaleLowerCase(),
    );

    if (existingContext) {
      onContextAdded(existingContext.id);
      setNewContextName("");
      setContextError("");
      return;
    }

    const contextId = buildContextId(nextName);
    const timestamp = nowIso();
    setContextSavingId(contextId);
    setContextError("");

    try {
      const savedContext = await onSaveContext({
        id: contextId,
        name: nextName,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      onContextAdded(savedContext.id);
      setNewContextName("");
      setContextEditorOpen(true);
    } catch (error) {
      setContextError(error instanceof Error ? error.message : t("errors.createContext"));
    } finally {
      setContextSavingId(null);
    }
  };

  return (
    <>
      <div className="task-card__context-tools">
        <div className="task-card__context-create">
          <input
            type="text"
            value={newContextName}
            onChange={(event) => setNewContextName(event.target.value)}
            placeholder={t("task.newContextPlaceholder")}
          />
          <button
            className="button"
            type="button"
            disabled={!newContextName.trim() || Boolean(contextSavingId)}
            onClick={() => void createNewContext()}
          >
            {t("task.addContext")}
          </button>
        </div>

        <button
          className="button button--ghost"
          type="button"
          onClick={() => setContextEditorOpen((current) => !current)}
        >
          {contextEditorOpen ? t("task.closeContextEditor") : t("task.editContexts")}
        </button>
      </div>

      {contextError ? <p className="task-card__context-error">{contextError}</p> : null}

      {contextEditorOpen ? (
        <div className="task-card__context-editor">
          {contexts.map((context) => (
            <div key={context.id} className="task-card__context-row">
              <input
                type="text"
                value={contextDrafts[context.id] ?? context.name}
                onChange={(event) =>
                  setContextDrafts((current) => ({
                    ...current,
                    [context.id]: event.target.value,
                  }))
                }
              />
              <button
                className="button"
                type="button"
                disabled={
                  contextSavingId === context.id ||
                  !(contextDrafts[context.id] ?? context.name).trim()
                }
                onClick={() => void saveExistingContext(context)}
              >
                {contextSavingId === context.id
                  ? tCommon("actions.saving")
                  : t("task.renameContext")}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
};
