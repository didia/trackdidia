import { useCallback, useState } from "react";
import type { AiProposal } from "../../domain/types";
import { type RequestSignal, useLatestRequest } from "../use-latest-request";

interface SynthesisResultLike {
  message: { scopeKey: string };
  proposals: AiProposal[];
}

export interface ReviewSynthesisRunOptions {
  trigger: "auto" | "explicit";
}

export interface ReviewSynthesisContext<R> {
  signal: RequestSignal;
  /** Publishes a result; call only while `signal.isLatest()` is still true. */
  setResult: (result: R) => void;
}

/**
 * Result, loading flag and latest-wins request for one review surface's coach synthesis
 * (weekly or monthly). The surface supplies `runner`, which loads a stored result and/or builds
 * a new one for its own scope; this hook owns the shared bookkeeping around it.
 *
 * `run` changes identity whenever `runner` does, so an effect that depends on `run` re-triggers
 * the automatic load exactly when the runner's inputs (for example settings) change. Pass a
 * `useCallback`-memoized runner.
 */
export const useReviewSynthesis = <
  R extends SynthesisResultLike,
  O extends ReviewSynthesisRunOptions,
>(
  scopeKey: string | null,
  runner: (options: O, context: ReviewSynthesisContext<R>) => Promise<void>,
) => {
  const request = useLatestRequest();
  const [result, setResult] = useState<R | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(
    async (options: O) => {
      await request.run(async (signal) => {
        setLoading(true);
        if (options.trigger !== "auto") {
          setResult(null);
        }
        try {
          await runner(options, { signal, setResult });
        } finally {
          if (signal.isLatest()) {
            setLoading(false);
          }
        }
      });
    },
    [request, runner],
  );

  /** Drops the displayed result, e.g. when navigating to another period. */
  const clear = useCallback(() => setResult(null), []);

  /** Marks any in-flight run as stale without starting a new one. */
  const invalidate = request.invalidate;

  /** The result, but only when it belongs to the period currently shown. */
  const visibleResult = result !== null && result.message.scopeKey === scopeKey ? result : null;

  const replaceProposal = useCallback((replacement: AiProposal) => {
    setResult((current) =>
      current
        ? {
            ...current,
            proposals: current.proposals.map((item) =>
              item.id === replacement.id ? replacement : item,
            ),
          }
        : current,
    );
  }, []);

  const markProposalDismissed = useCallback((proposalId: string) => {
    setResult((current) =>
      current
        ? {
            ...current,
            proposals: current.proposals.map((item) =>
              item.id === proposalId
                ? { ...item, status: "dismissed", decidedAt: new Date().toISOString() }
                : item,
            ),
          }
        : current,
    );
  }, []);

  return {
    result,
    visibleResult,
    setResult,
    loading,
    run,
    clear,
    invalidate,
    replaceProposal,
    markProposalDismissed,
  };
};
