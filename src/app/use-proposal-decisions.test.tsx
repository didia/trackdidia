import { act, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AiProposal } from "../domain/types";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import {
  type ApplyOutcome,
  type ProposalDecisions,
  type ProposalDecisionResult,
  useProposalDecisions,
} from "./use-proposal-decisions";

const proposal = (id: string): AiProposal => ({
  id,
  messageId: "message",
  type: "intention_draft",
  payloadJson: JSON.stringify({ text: id }),
  status: "pending",
  appliedEntityId: null,
  decidedAt: null,
  createdAt: "2026-08-29T08:00:00.000Z",
});

let latest: ProposalDecisions;

const Harness = ({
  onAccept,
  initial,
}: {
  onAccept: (proposal: AiProposal) => Promise<ApplyOutcome>;
  initial: AiProposal[];
}) => {
  const [result, setResult] = useState<ProposalDecisionResult | null>({ proposals: initial });
  latest = useProposalDecisions(result, setResult, { onAccept });
  return (
    <ul>
      {result?.proposals.map((item) => (
        <li key={item.id} data-testid={item.id}>
          {item.status}
          {latest.isApplying(item.id) ? " applying" : ""}
        </li>
      ))}
    </ul>
  );
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const seedRepository = async (proposals: AiProposal[]) => {
  const repository = new MemoryRepository();
  await repository.initialize();
  for (const item of proposals) await repository.saveAiProposal(item);
  return repository;
};

describe("useProposalDecisions", () => {
  it("runs onAccept once for a double accept and releases each proposal independently", async () => {
    const first = proposal("first");
    const second = proposal("second");
    const gates = { first: deferred<ApplyOutcome>(), second: deferred<ApplyOutcome>() };
    const onAccept = vi.fn((item: AiProposal) => gates[item.id as "first" | "second"].promise);
    await renderWithApp(<Harness onAccept={onAccept} initial={[first, second]} />);

    let calls: Promise<void>[] = [];
    act(() => {
      // Same tick: nothing has re-rendered, so only the synchronous in-flight set can block this.
      calls = [latest.accept(first), latest.accept(first), latest.accept(second)];
    });
    expect(onAccept).toHaveBeenCalledTimes(2);
    expect(latest.isApplying("first")).toBe(true);
    expect(screen.getByTestId("first").textContent).toBe("pending applying");

    await act(async () => {
      gates.first.resolve({ proposal: { ...first, status: "accepted", decidedAt: "now" } });
      await calls[0];
    });
    expect(screen.getByTestId("first").textContent).toBe("accepted");
    expect(latest.isApplying("first")).toBe(false);
    expect(latest.isApplying("second")).toBe(true);

    await act(async () => {
      gates.second.resolve({});
      await Promise.all(calls);
    });
    expect(screen.getByTestId("second").textContent).toBe("pending");
    expect(latest.isApplying("second")).toBe(false);
  });

  it("releases the lock and leaves the proposal pending when onAccept fails", async () => {
    const item = proposal("failing");
    const onAccept = vi.fn().mockRejectedValue(new Error("boom"));
    await renderWithApp(<Harness onAccept={onAccept} initial={[item]} />);

    await act(async () => {
      await latest.accept(item);
    });
    expect(latest.isApplying(item.id)).toBe(false);
    expect(screen.getByTestId(item.id).textContent).toBe("pending");

    await act(async () => {
      await latest.accept(item);
    });
    expect(onAccept).toHaveBeenCalledTimes(2);
  });

  it("persists a dismissal and flips the proposal status", async () => {
    const item = proposal("dismissed");
    const repository = await seedRepository([item]);
    const decide = vi.spyOn(repository, "decideAiProposal");
    const onAccept = vi.fn();
    await renderWithApp(<Harness onAccept={onAccept} initial={[item]} />, { repository });

    await act(async () => {
      await latest.dismiss(item);
    });

    expect(decide).toHaveBeenCalledWith(item.id, "dismissed");
    await waitFor(() => expect(screen.getByTestId(item.id).textContent).toBe("dismissed"));
    expect(onAccept).not.toHaveBeenCalled();
    expect(latest.isApplying(item.id)).toBe(false);
  });

  it("blocks accept while a dismissal is in flight", async () => {
    const item = proposal("racing");
    const repository = await seedRepository([item]);
    const gate = deferred<AiProposal>();
    vi.spyOn(repository, "decideAiProposal").mockReturnValue(gate.promise);
    const onAccept = vi.fn();
    await renderWithApp(<Harness onAccept={onAccept} initial={[item]} />, { repository });

    let dismissal: Promise<void> = Promise.resolve();
    act(() => {
      dismissal = latest.dismiss(item);
      void latest.accept(item);
    });
    expect(onAccept).not.toHaveBeenCalled();

    await act(async () => {
      gate.resolve({ ...item, status: "dismissed", decidedAt: "now" });
      await dismissal;
    });
    expect(screen.getByTestId(item.id).textContent).toBe("dismissed");
  });

  it("ignores proposals that are not part of the current result", async () => {
    const onAccept = vi.fn();
    await renderWithApp(<Harness onAccept={onAccept} initial={[]} />);

    await act(async () => {
      await latest.accept(proposal("stranger"));
      await latest.dismiss(proposal("stranger"));
    });
    expect(onAccept).not.toHaveBeenCalled();
  });
});
