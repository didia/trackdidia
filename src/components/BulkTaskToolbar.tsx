import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../domain/types";

const bucketOptions: Array<{ value: Task["bucket"]; labelKey: "buckets.nextActions" | "buckets.waitingFor" | "buckets.somedayMaybe" | "buckets.reference" | "buckets.scheduled" }> = [
  { value: "next_action", labelKey: "buckets.nextActions" },
  { value: "waiting_for", labelKey: "buckets.waitingFor" },
  { value: "someday_maybe", labelKey: "buckets.somedayMaybe" },
  { value: "reference", labelKey: "buckets.reference" },
  { value: "scheduled", labelKey: "buckets.scheduled" }
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
  const { t } = useTranslation("gtd");
  const { t: tCommon } = useTranslation("common");
  const [runningAction, setRunningAction] = useState<"complete" | "remove" | "move" | null>(null);
  const [targetBucket, setTargetBucket] = useState<Task["bucket"]>("next_action");
  const [pendingAction, setPendingAction] = useState<null | "complete" | "remove" | "move">(null);
  const [feedbackMessage, setFeedbackMessage] = useState("");

  if (totalCount === 0) {
    return null;
  }

  const targetLabel =
    t(bucketOptions.find((option) => option.value === targetBucket)?.labelKey ?? "buckets.nextActions");

  const confirmMessage =
    pendingAction === "complete"
      ? t("bulk.confirmComplete", { count: selectedCount })
      : pendingAction === "remove"
        ? t("bulk.confirmRemove", { count: selectedCount })
        : pendingAction === "move"
          ? `${t("bulk.confirmMove", { count: selectedCount, bucket: targetLabel })}${
              targetBucket === "scheduled" ? t("bulk.confirmMoveScheduledNote") : ""
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
        `${t("bulk.moved", { count: result.movedCount })} ${t("bulk.skipped", { count: result.skippedCount })}`
      );
    }
  };

  return (
    <div className="bulk-toolbar-wrapper">
      <div className="bulk-toolbar">
      <div className="bulk-toolbar__copy">
        {t("bulk.selectedCount", { count: selectedCount, total: totalCount })}
      </div>

      <div className="bulk-toolbar__actions">
        <button className="button" type="button" onClick={onToggleAll}>
          {allSelected ? t("bulk.deselectAll") : t("bulk.selectAll")}
        </button>

        {selectedCount > 0 ? (
          <>
            <button className="button" type="button" onClick={onClear}>
              {t("bulk.clearSelection")}
            </button>
            <label className="bulk-toolbar__move">
              <span>{t("bulk.moveTo")}</span>
              <select value={targetBucket} onChange={(event) => setTargetBucket(event.target.value as Task["bucket"])}>
                {bucketOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey)}
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
              {runningAction === "move" ? tCommon("status.processing") : t("bulk.moveSelection")}
            </button>
            <button
              className="button"
              type="button"
              disabled={runningAction !== null}
              onClick={() => setPendingAction("complete")}
            >
              {runningAction === "complete" ? tCommon("status.processing") : t("bulk.completeSelection")}
            </button>
            <button
              className="button button--ghost"
              type="button"
              disabled={runningAction !== null}
              onClick={() => setPendingAction("remove")}
            >
              {runningAction === "remove" ? tCommon("status.processing") : t("bulk.removeSelection")}
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
              {tCommon("actions.confirm")}
            </button>
            <button className="button" type="button" disabled={runningAction !== null} onClick={() => setPendingAction(null)}>
              {tCommon("actions.cancel")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};
