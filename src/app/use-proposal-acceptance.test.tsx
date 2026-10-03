import { act, renderHook } from "@testing-library/react";
import { useProposalAcceptance } from "./use-proposal-acceptance";

it("blocks repeat acceptance before the next render and releases each proposal independently", () => {
  const { result } = renderHook(() => useProposalAcceptance());
  act(() => {
    expect(result.current.begin("first")).toBe(true);
    expect(result.current.begin("first")).toBe(false);
    expect(result.current.begin("second")).toBe(true);
    expect(result.current.isApplying("first")).toBe(true);
  });
  expect(result.current.applyingProposalIds).toEqual(["first", "second"]);
  act(() => result.current.end("first"));
  expect(result.current.applyingProposalIds).toEqual(["second"]);
  act(() => {
    expect(result.current.begin("first")).toBe(true);
  });
});
