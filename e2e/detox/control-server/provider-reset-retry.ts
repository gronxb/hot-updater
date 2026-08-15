import { setTimeout as sleep } from "timers/promises";

const RESET_ATTEMPTS = 3;
const RESET_RETRY_DELAY_MS = 1_000;

type RetryContext = {
  attempt: number;
  error: unknown;
  retryDelayMs: number;
};

type ResetProviderOptions = {
  onRetry?: (context: RetryContext) => void;
  wait?: (delayMs: number) => Promise<unknown>;
};

function isConnectionReset(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error && /\bECONNRESET\b/.test(current.message)) {
      return true;
    }
    if (
      typeof current === "object" &&
      "code" in current &&
      Reflect.get(current, "code") === "ECONNRESET"
    ) {
      return true;
    }
    current =
      typeof current === "object" && "cause" in current
        ? Reflect.get(current, "cause")
        : null;
  }
  return false;
}

export async function resetProviderAfterReady(
  reset: () => Promise<void>,
  options: ResetProviderOptions = {},
): Promise<void> {
  const wait = options.wait ?? sleep;

  for (let attempt = 1; attempt <= RESET_ATTEMPTS; attempt += 1) {
    try {
      await reset();
      return;
    } catch (error) {
      if (!isConnectionReset(error) || attempt === RESET_ATTEMPTS) {
        throw error;
      }
      options.onRetry?.({
        attempt,
        error,
        retryDelayMs: RESET_RETRY_DELAY_MS,
      });
      await wait(RESET_RETRY_DELAY_MS);
    }
  }
}
