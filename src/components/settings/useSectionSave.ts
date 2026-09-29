import { useCallback, useState } from "react";

export interface SectionSaveState {
  saving: boolean;
  message: string;
  run: (successMessage: string, errorFallbackMessage?: string) => Promise<void>;
}

/**
 * Shared saving/message pattern used by Settings sections: a boolean "saving"
 * flag, a status message (success text or the caught error's message), and a
 * `run` helper that wraps a save call with that bookkeeping.
 */
export const useSectionSave = (save: () => Promise<void>): SectionSaveState => {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const run = useCallback(
    async (successMessage: string, errorFallbackMessage = "") => {
      setSaving(true);
      setMessage("");

      try {
        await save();
        setMessage(successMessage);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : errorFallbackMessage);
      } finally {
        setSaving(false);
      }
    },
    [save],
  );

  return { saving, message, run };
};
