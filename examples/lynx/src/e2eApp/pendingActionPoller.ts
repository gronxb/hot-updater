type PendingAction = {
  readonly testID?: string;
  readonly text?: string;
};

type FetchResponse = {
  readonly ok: boolean;
  readonly json: () => Promise<unknown>;
};

type FetchState = (url: string, init?: RequestInit) => Promise<FetchResponse>;

type ActionHandler = (text?: string) => Promise<void>;

export async function fetchJsonWithTimeout(
  fetchState: FetchState,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchState(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function createPendingActionPoller(options: {
  readonly actionTimeoutMs?: number;
  readonly fetchState: FetchState;
  readonly fetchTimeoutMs?: number;
  readonly getActionHandlers: () => Record<string, ActionHandler>;
  readonly getPendingActionURL: () => string;
  readonly markHandled: () => void;
  readonly navigateToTestId: (testID: string) => void;
  readonly onActionTimeout: () => Promise<void>;
  readonly pollIntervalMs?: number;
}) {
  const actionTimeoutMs = options.actionTimeoutMs ?? 20_000;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  let pollInFlight: Promise<void> | null = null;
  let started = false;
  let halted = false;

  const executePoll = async () => {
    const handlers = options.getActionHandlers();
    if (Object.keys(handlers).length === 0) return;
    const pendingActionURL = options.getPendingActionURL();
    const peeked = (await fetchJsonWithTimeout(
      options.fetchState,
      pendingActionURL,
      undefined,
      fetchTimeoutMs,
    )) as { action?: PendingAction | null } | null;
    const peekedTestID = peeked?.action?.testID;
    if (!peekedTestID || !handlers[peekedTestID]) return;

    const taken = (await fetchJsonWithTimeout(
      options.fetchState,
      `${pendingActionURL}?take=1`,
      undefined,
      fetchTimeoutMs,
    )) as { action?: PendingAction | null } | null;
    const testID = taken?.action?.testID;
    if (!testID) return;
    const handler = handlers[testID];
    if (!handler) return;

    options.markHandled();
    options.navigateToTestId(testID);
    let actionTimeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      handler(taken.action?.text).then(() => false),
      new Promise<boolean>((resolve) => {
        actionTimeout = setTimeout(() => resolve(true), actionTimeoutMs);
      }),
    ]);
    if (actionTimeout !== undefined) clearTimeout(actionTimeout);
    if (timedOut) {
      halted = true;
      await options.onActionTimeout();
    }
  };

  const pollOnce = (): Promise<void> => {
    if (halted) return Promise.resolve();
    if (pollInFlight) return pollInFlight;
    let current: Promise<void>;
    current = executePoll().finally(() => {
      if (pollInFlight === current) pollInFlight = null;
    });
    pollInFlight = current;
    return pollInFlight;
  };

  const tick = async () => {
    try {
      await pollOnce();
    } catch {
      // The control driver observes action failures through screen state.
    }
    if (!halted) setTimeout(() => void tick(), pollIntervalMs);
  };

  return {
    pollOnce,
    start: () => {
      if (started) return;
      started = true;
      void tick();
    },
  };
}
