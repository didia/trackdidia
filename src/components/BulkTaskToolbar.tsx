import { useState } from "react";
import type { Task } from "../domain/types";

const bucketOptions: Array<{ value: Task["bucket"]; label: string }> = [
  { value: "next_action", label: "Next Actions" },
  { value: "waiting_for", label: "Waiting For" },
  { value: "someday_maybe", label: "Someday / Maybe" },
  { value: "reference", label: "References" },
  { value: "scheduled", label: "Scheduled" }
];

interface BulkTaskToolbarProps {
  selectedCount: number;
  totalCount: number;
  allSelected: boolean;
  onToggleAll: () => void;
  onClear: () => void;
  onComplete: () => Promise<void>;
  onRemove: () => Promise<void>;
  onMove: (bucket: Task["bucket"]) => Promise<{ movedCount: number; skippedCount: number }>;
}

export const BulkTaskToolbar = ({
  selectedCount,
  totalCount,
  allSelected,
  onToggleAll,
  onClear,
  onComplete,
  onRemove,
  onMove
}: BulkTaskToolbarProps) => {
  const [runningAction, setRunningAction] = useState<"complete" | "remove" | "move" | null>(null);
  const [targetBucket, setTargetBucket] = useState<Task["bucket"]>("next_action");
  const [pendingAction, setPendingAction] = useState<null | "complete" | "remove" | "move">(null);
  const [feedbackMessage, setFeedbackMessage] = useState("");

  if (totalCount === 0) {
    return null;
  }

  const targetLabel = bucketOptions.find((option) => option.value === targetBucket)?.label ?? targetBucket;

  const confirmMessage =
    pendingAction === "complete"
      ? `Terminer ${selectedCount} tache${selectedCount > 1 ? "s" : ""} selectionnee${selectedCount > 1 ? "s" : ""} ?`
      : pendingAction === "remove"
        ? `Retirer ${selectedCount} tache${selectedCount > 1 ? "s" : ""} selectionnee${selectedCount > 1 ? "s" : ""} ?`
        : pendingAction === "move"
          ? `Deplacer ${selectedCount} tache${selectedCount > 1 ? "s" : ""} selectionnee${selectedCount > 1 ? "s" : ""} vers ${targetLabel} ?${
              targetBucket === "scheduled" ? " Les taches sans date resteront inchangées." : ""
            }`
          : "";

  const runPendingAction = async () => {
    if (!pendingAction) {
      return;
    }

    setFeedbackMessage("");
    setRunningAction(pendingAction);

    if (pendingAction === "complete") {
      await onComplete();
      setRunningAction(null);
      setPendingAction(null);
      return;
    }

    if (pendingAction === "remove") {
      await onRemove();
      setRunningAction(null);
      setPendingAction(null);
      return;
    }

    const result = await onMove(targetBucket);
    setRunningAction(null);
    setPendingAction(null);

    if (result.skippedCount > 0) {
      setFeedbackMessage(
        `${result.movedCount} tache${result.movedCount > 1 ? "s" : ""} deplacee${result.movedCount > 1 ? "s" : ""}. ${result.skippedCount} ignoree${result.skippedCount > 1 ? "s" : ""}.`
      );
    }
  };

  return (
    <div className="bulk-toolbar-wrapper">
      <div className="bulk-toolbar">
      <div className="bulk-toolbar__copy">
        <strong>{selectedCount}</strong> tache{selectedCount > 1 ? "s" : ""} selectionnee
        {selectedCount > 1 ? "s" : ""} sur {totalCount}
      </div>

      <div className="bulk-toolbar__actions">
        <button className="button" type="button" onClick={onToggleAll}>
          {allSelected ? "Tout deselectionner" : "Tout selectionner"}
        </button>

        {selectedCount > 0 ? (
          <>
            <button className="button" type="button" onClick={onClear}>
              Effacer la selection
            </button>
            <label className="bulk-toolbar__move">
              <span>Deplacer vers</span>
              <select value={targetBucket} onChange={(event) => setTargetBucket(event.target.value as Task["bucket"])}>
                {bucketOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button"
              type="button"
              disabled={runningAction !== null}
              onClick={() => setPendingAction("move")}
            >
              {runningAction === "move" ? "Traitement..." : "Deplacer la selection"}
            </button>
            <button
              className="button"
              type="button"
              disabled={runningAction !== null}
              onClick={() => setPendingAction("complete")}
            >
              {runningAction === "complete" ? "Traitement..." : "Terminer la selection"}
            </button>
            <button
              className="button button--ghost"
              type="button"
              disabled={runningAction !== null}
              onClick={() => setPendingAction("remove")}
            >
              {runningAction === "remove" ? "Traitement..." : "Retirer la selection"}
            </button>
          </>
        ) : null}
      </div>
      </div>

      {feedbackMessage ? <div className="banner">{feedbackMessage}</div> : null}

      {pendingAction ? (
        <div className="bulk-confirm">
          <p>{confirmMessage}</p>
          <div className="bulk-confirm__actions">
            <button className="button button--primary" type="button" disabled={runningAction !== null} onClick={() => void runPendingAction()}>
              Confirmer
            </button>
            <button className="button" type="button" disabled={runningAction !== null} onClick={() => setPendingAction(null)}>
              Annuler
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};
