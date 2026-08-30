import { useCallback, useEffect, useState } from "react";
import type { AiMemory } from "../domain/types";
import { createEntityId, nowIso } from "../lib/gtd/shared";
import type { AppRepository } from "../lib/storage/repository";
import { SectionCard } from "./SectionCard";

interface AiMemoryProfileSectionProps {
  repository: AppRepository;
  memoryEnabled: boolean;
}

const emptyDraft = (): { statement: string; detail: string } => ({
  statement: "",
  detail: ""
});

export const AiMemoryProfileSection = ({ repository, memoryEnabled }: AiMemoryProfileSectionProps) => {
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
        pinned: true
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
      setMessage("Le libelle est requis.");
      return;
    }

    const timestamp = nowIso();
    const memory: AiMemory = editingId
      ? {
          ...(memories.find((item) => item.id === editingId) as AiMemory),
          statement: draft.statement.trim(),
          detail: draft.detail.trim(),
          lastConfirmedAt: timestamp
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
          pinned: true
        };

    await repository.saveAiMemory(memory);
    setMessage(editingId ? "Profil mis a jour." : "Memoire epinglee ajoutee.");
    resetForm();
    await loadMemories();
  };

  const handleDelete = async (id: string) => {
    await repository.archiveAiMemory(id, "resolved");
    setMessage("Memoire archivee.");
    if (editingId === id) {
      resetForm();
    }
    await loadMemories();
  };

  return (
    <SectionCard
      title="Profil coach (memoires epinglees)"
      subtitle="Mission, saison de vie, style de coaching — toujours injecte quand la memoire IA est active."
    >
      {!memoryEnabled ? (
        <p className="hero__copy">Active la memoire IA ci-dessus pour que ce profil soit utilise par le coach.</p>
      ) : null}
      {message ? <div className="banner">{message}</div> : null}

      {loading ? <p>Chargement du profil...</p> : null}

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
                  Modifier
                </button>
                <button className="button button--ghost" type="button" onClick={() => void handleDelete(memory.id)}>
                  Supprimer
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="settings-form">
        <label>
          <span>{editingId ? "Modifier le libelle" : "Nouveau libelle"}</span>
          <input
            type="text"
            value={draft.statement}
            onChange={(event) => setDraft((current) => ({ ...current, statement: event.target.value }))}
            placeholder="Ex. Mission personnelle, style de coaching souhaite..."
          />
        </label>

        <label>
          <span>Detail (optionnel)</span>
          <textarea
            rows={3}
            value={draft.detail}
            onChange={(event) => setDraft((current) => ({ ...current, detail: event.target.value }))}
            placeholder="Contexte durable pour le coach..."
          />
        </label>

        <div className="form-actions">
          <button className="button button--primary" type="button" onClick={() => void handleSave()}>
            {editingId ? "Mettre a jour" : "Ajouter"}
          </button>
          {editingId ? (
            <button className="button button--ghost" type="button" onClick={resetForm}>
              Annuler
            </button>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
};
