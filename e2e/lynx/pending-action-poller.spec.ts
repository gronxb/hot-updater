import { afterEach, describe, expect, it, vi } from "vitest";

import { createPendingActionPoller } from "../../examples/lynx/src/e2eApp/pendingActionPoller";

const response = (payload: unknown) => ({
  ok: true,
  json: async () => payload,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Lynx pending-action poller", () => {
  it("serializes concurrent polls before the slow peek resolves", async () => {
    const peek = deferred<ReturnType<typeof response>>();
    const handler = vi.fn(async () => undefined);
    const markHandled = vi.fn();
    const fetchState = vi
      .fn()
      .mockImplementationOnce(() => peek.promise)
      .mockResolvedValueOnce(response({ action: { testID: "action-update" } }));
    const poller = createPendingActionPoller({
      fetchState,
      getActionHandlers: () => ({ "action-update": handler }),
      getPendingActionURL: () => "http://control.test/e2e/pending-action",
      markHandled,
      navigateToTestId: vi.fn(),
      onActionTimeout: vi.fn(async () => undefined),
    });

    const first = poller.pollOnce();
    const second = poller.pollOnce();
    expect(fetchState).toHaveBeenCalledOnce();
    peek.resolve(response({ action: { testID: "action-update" } }));
    await Promise.all([first, second]);

    expect(fetchState).toHaveBeenCalledTimes(2);
    expect(fetchState.mock.calls[1]![0]).toBe(
      "http://control.test/e2e/pending-action?take=1",
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(markHandled).toHaveBeenCalledExactlyOnceWith("action-update");
  });

  it("aborts a hung destructive take without running the action", async () => {
    vi.useFakeTimers();
    let takeSignal: AbortSignal | undefined;
    const fetchState = vi
      .fn()
      .mockResolvedValueOnce(response({ action: { testID: "action-update" } }))
      .mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            takeSignal = init?.signal ?? undefined;
            takeSignal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      );
    const handler = vi.fn(async () => undefined);
    const poller = createPendingActionPoller({
      fetchState,
      fetchTimeoutMs: 100,
      getActionHandlers: () => ({ "action-update": handler }),
      getPendingActionURL: () => "http://control.test/e2e/pending-action",
      markHandled: vi.fn(),
      navigateToTestId: vi.fn(),
      onActionTimeout: vi.fn(async () => undefined),
    });

    const poll = poller.pollOnce();
    await vi.advanceTimersByTimeAsync(100);
    await poll;

    expect(takeSignal?.aborted).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("leaves an action queued for the managed page that owns its handler", async () => {
    const fetchState = vi
      .fn()
      .mockResolvedValue(
        response({ action: { testID: "action-close-detail-page" } }),
      );
    const poller = createPendingActionPoller({
      fetchState,
      getActionHandlers: () => ({
        "action-open-detail-page": vi.fn(async () => undefined),
      }),
      getPendingActionURL: () => "http://control.test/e2e/pending-action",
      markHandled: vi.fn(),
      navigateToTestId: vi.fn(),
      onActionTimeout: vi.fn(async () => undefined),
    });

    await poller.pollOnce();

    expect(fetchState).toHaveBeenCalledOnce();
    expect(fetchState).not.toHaveBeenCalledWith(
      expect.stringContaining("?take=1"),
      expect.anything(),
    );
  });

  it("stops polling after an action timeout so a hung action cannot overlap", async () => {
    vi.useFakeTimers();
    const handler = vi.fn(() => new Promise<void>(() => undefined));
    const onActionTimeout = vi.fn(async () => undefined);
    const fetchState = vi
      .fn()
      .mockResolvedValueOnce(response({ action: { testID: "action-update" } }))
      .mockResolvedValueOnce(response({ action: { testID: "action-update" } }));
    const poller = createPendingActionPoller({
      actionTimeoutMs: 100,
      fetchState,
      getActionHandlers: () => ({ "action-update": handler }),
      getPendingActionURL: () => "http://control.test/e2e/pending-action",
      markHandled: vi.fn(),
      navigateToTestId: vi.fn(),
      onActionTimeout,
      pollIntervalMs: 10,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(200);

    expect(handler).toHaveBeenCalledOnce();
    expect(onActionTimeout).toHaveBeenCalledOnce();
    expect(fetchState).toHaveBeenCalledTimes(2);
  });
});
