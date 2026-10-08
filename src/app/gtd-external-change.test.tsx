import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { notifyGtdExternalChange, useGtdExternalChangeRevision } from "./gtd-external-change";

it("increments the revision on every external change and stops after unmount", () => {
  const { result, unmount } = renderHook(() => useGtdExternalChangeRevision());
  expect(result.current).toBe(0);

  act(() => notifyGtdExternalChange());
  act(() => notifyGtdExternalChange());
  expect(result.current).toBe(2);

  unmount();
  expect(() => notifyGtdExternalChange()).not.toThrow();
});
