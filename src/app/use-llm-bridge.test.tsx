import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { subscribeGtdExternalChange } from "./gtd-external-change";
import { useLlmBridge, type LlmBridgeStatus } from "./use-llm-bridge";

type Listener = (event: { payload: unknown }) => void;

const invokeMock = vi.fn();
const unlistenMock = vi.fn();
let requestListener: Listener | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_event: string, listener: Listener) => {
    requestListener = listener;
    return unlistenMock;
  },
}));

const TOKEN = "t".repeat(40);
let latestStatus: LlmBridgeStatus = { state: "off" };
let latestRetry: () => void = () => undefined;

const Mount = (props: {
  repository: MemoryRepository | null;
  browserPreview?: boolean;
  allowStart?: boolean;
  enabled?: boolean;
  token?: string;
  port?: number;
}) => {
  const bridge = useLlmBridge(props.repository, {
    browserPreview: props.browserPreview ?? false,
    allowStart: props.allowStart ?? true,
    enabled: props.enabled ?? true,
    port: props.port ?? 47_821,
    token: props.token ?? TOKEN,
  });
  latestStatus = bridge.status;
  latestRetry = bridge.retry;
  return null;
};

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
};

const configureCalls = () =>
  invokeMock.mock.calls.filter(([command]) => command === "llm_bridge_configure");

describe("useLlmBridge", () => {
  let repository: MemoryRepository;

  beforeEach(async () => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    unlistenMock.mockReset();
    requestListener = null;
    latestStatus = { state: "off" };
    repository = new MemoryRepository();
    await repository.initialize();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["browser preview", { browserPreview: true }],
    ["startup not settled", { allowStart: false }],
    ["disabled", { enabled: false }],
    ["no token", { token: "" }],
    ["no repository", { repository: null }],
  ])("never starts the server (%s)", async (_label, overrides) => {
    render(<Mount repository={repository} {...overrides} />);
    await flush();

    expect(configureCalls()).toHaveLength(0);
    expect(requestListener).toBeNull();
    expect(latestStatus).toEqual({ state: "off" });
  });

  it("registers the listener before starting the server, then reports running", async () => {
    render(<Mount repository={repository} />);
    await flush();

    expect(requestListener).not.toBeNull();
    expect(configureCalls()).toEqual([
      ["llm_bridge_configure", { enabled: true, port: 47_821, token: TOKEN }],
    ]);
    expect(latestStatus).toEqual({ state: "running", port: 47_821 });
  });

  it("stops the server and the listener on unmount", async () => {
    const view = render(<Mount repository={repository} />);
    await flush();
    view.unmount();
    await flush();

    expect(unlistenMock).toHaveBeenCalled();
    expect(configureCalls().at(-1)).toEqual([
      "llm_bridge_configure",
      { enabled: false, port: 47_821, token: "" },
    ]);
  });

  it("surfaces a start failure as an error status", async () => {
    invokeMock.mockRejectedValueOnce("Impossible d'ouvrir 127.0.0.1:47821");
    render(<Mount repository={repository} />);
    await flush();

    expect(latestStatus).toEqual({
      state: "error",
      message: "Impossible d'ouvrir 127.0.0.1:47821",
    });
  });

  it("answers a forwarded tools/call from the repository and notifies mounted views", async () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeGtdExternalChange(onChange);
    render(<Mount repository={repository} />);
    await flush();

    await act(async () => {
      requestListener?.({
        payload: {
          id: "llm-1",
          method: "tools/call",
          params: { name: "add_tasks", arguments: { tasks: [{ title: "Depuis le LLM" }] } },
        },
      });
      for (let i = 0; i < 30; i += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    unsubscribe();

    expect((await repository.listTasks({ includeCompleted: true })).map((t) => t.title)).toEqual([
      "Depuis le LLM",
    ]);
    expect(onChange).toHaveBeenCalledTimes(1);
    const reply = invokeMock.mock.calls.find(([command]) => command === "llm_bridge_respond");
    expect(reply?.[1]).toMatchObject({ id: "llm-1", error: null });
  });

  it("replies with a JSON-RPC error for an unknown method without leaking details", async () => {
    render(<Mount repository={repository} />);
    await flush();

    await act(async () => {
      requestListener?.({ payload: { id: "llm-2", method: "resources/list", params: null } });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const reply = invokeMock.mock.calls.find(([command]) => command === "llm_bridge_respond");
    expect(reply?.[1]).toMatchObject({
      id: "llm-2",
      result: null,
      error: { code: -32601 },
    });
  });

  it("retries a failed start with unchanged settings", async () => {
    invokeMock.mockRejectedValueOnce("Impossible d'ouvrir 127.0.0.1:47821");
    render(<Mount repository={repository} />);
    await flush();
    expect(latestStatus.state).toBe("error");

    act(() => latestRetry());
    await flush();

    expect(latestStatus).toEqual({ state: "running", port: 47_821 });
    const starts = configureCalls().filter(([, args]) => (args as { enabled: boolean }).enabled);
    expect(starts).toHaveLength(2);
  });

  it("does not run requests that arrive after the bridge was stopped", async () => {
    const view = render(<Mount repository={repository} />);
    await flush();
    const staleListener = requestListener;
    view.unmount();
    await flush();
    invokeMock.mockClear();

    await act(async () => {
      staleListener?.({
        payload: {
          id: "llm-9",
          method: "tools/call",
          params: { name: "add_tasks", arguments: { tasks: [{ title: "Après rotation" }] } },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(await repository.listTasks({ includeCompleted: true })).toHaveLength(0);
    expect(invokeMock.mock.calls.some(([command]) => command === "llm_bridge_respond")).toBe(false);
  });
});
