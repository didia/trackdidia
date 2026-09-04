import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AiMemory } from "../domain/types";
import { t as translate } from "../i18n";
import { createEntityId, nowIso } from "../lib/gtd/shared";
import type { AppRepository } from "../lib/storage/repository";
import { SectionCard } from "./SectionCard";

interface AiMemoryProfileSectionProps {
  repository: AppRepository;
  memoryEnabled: boolean;
}

const emptyDraft = (): { statement: string; detail: string } => ({
  statement: "",
  detail: "",
});

export const AiMemoryProfileSection = ({
  repository,
  memoryEnabled,
}: AiMemoryProfileSectionProps) => {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const [memories, setMemories] = useState<AiMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft());

  const loadMemories = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await repository.listAiMemories({
        status: "active",
        kind: "principle",
        pinned: true,
      });
      setMemories(rows);
    } finally {
      setLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    void loadMemories();
  }, [loadMemories]);

  const resetForm = () => {
    setEditingId(null);
    setDraft(emptyDraft());
  };

  const handleSave = async () => {
    if (!draft.statement.trim()) {
      setMessage(translate("memoryProfile.statementRequired", { ns: "settings" }));
      return;
    }

    const timestamp = nowIso();
    const memory: AiMemory = editingId
      ? {
          ...(memories.find((item) => item.id === editingId) as AiMemory),
          statement: draft.statement.trim(),
          detail: draft.detail.trim(),
          lastConfirmedAt: timestamp,
        }
      : {
          id: createEntityId("ai-memory"),
          kind: "principle",
          statement: draft.statement.trim(),
          detail: draft.detail.trim(),
          confidence: 1,
          source: "user_pinned",
          status: "active",
          evidenceFrom: null,
          evidenceTo: null,
          createdAt: timestamp,
          lastConfirmedAt: timestamp,
          expiresAt: null,
          pinned: true,
        };

    await repository.saveAiMemory(memory);
    setMessage(
      editingId
        ? translate("memoryProfile.updated", { ns: "settings" })
        : translate("memoryProfile.added", { ns: "settings" }),
    );
    resetForm();
    await loadMemories();
  };

  const handleDelete = async (id: string) => {
    await repository.archiveAiMemory(id, "resolved");
    setMessage(translate("memoryProfile.archived", { ns: "settings" }));
    if (editingId === id) {
      resetForm();
    }
    await loadMemories();
  };

  return (
    <SectionCard title={t("memoryProfile.title")} subtitle={t("memoryProfile.subtitle")}>
      {!memoryEnabled ? <p className="hero__copy">{t("memoryProfile.disabledHint")}</p> : null}
      {message ? <div className="banner">{message}</div> : null}

      {loading ? <p>{t("memoryProfile.loading")}</p> : null}

      {!loading && memories.length > 0 ? (
        <ul className="memory-profile-list">
          {memories.map((memory) => (
            <li key={memory.id} className="memory-profile-item">
              <div>
                <strong>{memory.statement}</strong>
                {memory.detail ? <p>{memory.detail}</p> : null}
              </div>
              <div className="section-actions">
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => {
                    setEditingId(memory.id);
                    setDraft({ statement: memory.statement, detail: memory.detail });
                  }}
                >
                  {tCommon("actions.edit")}
                </button>
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => void handleDelete(memory.id)}
                >
                  {tCommon("actions.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="settings-form">
        <label>
          <span>
            {editingId ? t("memoryProfile.editStatement") : t("memoryProfile.newStatement")}
          </span>
          <input
            type="text"
            value={draft.statement}
            onChange={(event) =>
              setDraft((current) => ({ ...current, statement: event.target.value }))
            }
            placeholder={t("memoryProfile.statementPlaceholder")}
          />
        </label>

        <label>
          <span>{t("memoryProfile.detail")}</span>
          <textarea
            rows={3}
            value={draft.detail}
            onChange={(event) =>
              setDraft((current) => ({ ...current, detail: event.target.value }))
            }
            placeholder={t("memoryProfile.detailPlaceholder")}
          />
        </label>

        <div className="form-actions">
          <button
            className="button button--primary"
            type="button"
            onClick={() => void handleSave()}
          >
            {editingId ? tCommon("actions.update") : tCommon("actions.add")}
          </button>
          {editingId ? (
            <button className="button button--ghost" type="button" onClick={resetForm}>
              {tCommon("actions.cancel")}
            </button>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
};
