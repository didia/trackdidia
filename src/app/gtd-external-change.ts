import { useEffect, useState } from "react";

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Lets writers outside a mounted `useGtdWorkspace` (the LLM bridge) tell open GTD screens to
 * reload. Mutations made through the workspace itself already reload their own screen.
 */
export const subscribeGtdExternalChange = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const notifyGtdExternalChange = (): void => {
  for (const listener of [...listeners]) {
    listener();
  }
};

/** Counter that increments on every external change, for effects that must refetch derived data. */
export const useGtdExternalChangeRevision = (): number => {
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeGtdExternalChange(() => setRevision((current) => current + 1)), []);
  return revision;
};
