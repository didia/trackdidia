import { useRef, useState } from "react";

/** Block a second click synchronously, including before React paints disabled buttons. */
export const useProposalAcceptance = () => {
  const inFlight = useRef(new Set<string>());
  const [applyingProposalIds, setApplyingProposalIds] = useState<string[]>([]);
  const isApplying = (id: string) => inFlight.current.has(id);
  const begin = (id: string): boolean => {
    if (isApplying(id)) return false;
    inFlight.current.add(id);
    setApplyingProposalIds([...inFlight.current]);
    return true;
  };
  const end = (id: string) => {
    inFlight.current.delete(id);
    setApplyingProposalIds([...inFlight.current]);
  };
  return { applyingProposalIds, isApplying, begin, end };
};
