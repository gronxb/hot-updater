import type { ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

type ChildTermination =
  | {
      readonly code: number | null;
      readonly kind: "close";
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly error: Error; readonly kind: "error" };

export type ControlServerChildMonitor = {
  readonly closed: Promise<void>;
  readonly isClosed: () => boolean;
  readonly termination: Promise<ChildTermination>;
};

type WaitForControlServerOptions = {
  readonly delay?: (milliseconds: number) => Promise<unknown>;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxAttempts?: number;
  readonly requestTimeoutMs?: number;
  readonly retryDelayMs?: number;
};

type StopControlServerOptions = {
  readonly delay?: (milliseconds: number) => Promise<unknown>;
  readonly forceTimeoutMs?: number;
  readonly graceTimeoutMs?: number;
};

export function monitorControlServerChild(
  child: ChildProcess,
): ControlServerChildMonitor {
  let isClosed = false;
  let resolveClosed!: () => void;
  let resolveTermination!: (termination: ChildTermination) => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const termination = new Promise<ChildTermination>((resolve) => {
    resolveTermination = resolve;
  });

  child.once("error", (error) => {
    resolveTermination({ error, kind: "error" });
  });
  child.once("close", (code, signal) => {
    isClosed = true;
    resolveClosed();
    resolveTermination({ code, kind: "close", signal });
  });

  return {
    closed,
    isClosed: () => isClosed,
    termination,
  };
}

function terminationError(termination: ChildTermination): Error {
  if (termination.kind === "error") {
    return new Error(
      `Detox control server failed before readiness: ${termination.error.message}`,
    );
  }
  return new Error(
    `Detox control server exited before readiness (code=${String(termination.code)}, signal=${String(termination.signal)})`,
  );
}

async function probeControlServer(
  baseUrl: string,
  startupNonce: string,
  fetchImplementation: typeof globalThis.fetch,
  requestTimeoutMs: number,
): Promise<{ readonly error: string; readonly ready: boolean }> {
  try {
    const response = await fetchImplementation(baseUrl, {
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      return { error: `HTTP ${response.status}`, ready: false };
    }
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("startupNonce" in body) ||
      body.startupNonce !== startupNonce
    ) {
      return { error: "startup nonce mismatch", ready: false };
    }
    return { error: "", ready: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ready: false,
    };
  }
}

export async function waitForControlServer(
  baseUrl: string,
  startupNonce: string,
  monitor: ControlServerChildMonitor,
  options: WaitForControlServerOptions = {},
): Promise<void> {
  const delay = options.delay ?? sleep;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const maxAttempts = options.maxAttempts ?? 90;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5000;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  let lastError = "unknown";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const outcome = await Promise.race([
      probeControlServer(
        baseUrl,
        startupNonce,
        fetchImplementation,
        requestTimeoutMs,
      ).then((probe) => ({ kind: "probe" as const, probe })),
      monitor.termination,
    ]);
    if (outcome.kind !== "probe") {
      throw terminationError(outcome);
    }
    if (outcome.probe.ready) return;
    lastError = outcome.probe.error;

    if (attempt < maxAttempts) {
      const delayOutcome = await Promise.race([
        delay(retryDelayMs).then(() => null),
        monitor.termination,
      ]);
      if (delayOutcome !== null) {
        throw terminationError(delayOutcome);
      }
    }
  }

  throw new Error(
    `Timed out waiting for Detox control server ${baseUrl}: ${lastError}`,
  );
}

async function waitForClose(
  monitor: ControlServerChildMonitor,
  timeoutMs: number,
  delay: (milliseconds: number) => Promise<unknown>,
): Promise<boolean> {
  if (monitor.isClosed()) return true;
  const closed = await Promise.race([
    monitor.closed.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
  return closed || monitor.isClosed();
}

export async function stopControlServerChild(
  child: ChildProcess,
  monitor: ControlServerChildMonitor,
  options: StopControlServerOptions = {},
): Promise<void> {
  const delay = options.delay ?? sleep;
  const graceTimeoutMs = options.graceTimeoutMs ?? 3000;
  const forceTimeoutMs = options.forceTimeoutMs ?? 3000;
  if (monitor.isClosed()) return;

  child.kill("SIGTERM");
  if (await waitForClose(monitor, graceTimeoutMs, delay)) return;

  child.kill("SIGKILL");
  if (await waitForClose(monitor, forceTimeoutMs, delay)) return;

  throw new Error("Detox control server did not close after SIGKILL");
}
