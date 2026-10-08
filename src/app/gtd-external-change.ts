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
