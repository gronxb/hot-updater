import type { DatabaseAdapter } from "@hot-updater/plugin-core/internal";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Delays every adapter call by `ms`, like a round trip to a remote database. */
export const withAdapterLatency = (
  adapter: DatabaseAdapter,
  ms: number,
): DatabaseAdapter => ({
  ...adapter,
  get: async (table, keys) => {
    await sleep(ms);
    return adapter.get(table, keys);
  },
  query: async (table, request) => {
    await sleep(ms);
    return adapter.query(table, request);
  },
  write: async (ops) => {
    await sleep(ms);
    return adapter.write(ops);
  },
});

export interface ContentionOptions {
  /** How many transactions to start. */
  readonly transactions: number;
  /** Arrivals per second, spaced evenly. */
  readonly ratePerSecond: number;
  /** At most this many run at once, like a connection pool. */
  readonly concurrency: number;
  /** Runs transaction `index` to completion. */
  readonly run: (index: number) => Promise<unknown>;
}

export interface ContentionReport {
  readonly transactions: number;
  readonly committed: number;
  /** Errors thrown by `run`, counted by error name. */
  readonly errors: Readonly<Record<string, number>>;
  readonly durationMs: number;
}

/**
 * Starts `transactions` runs at a steady arrival rate through a fixed pool and
 * reports how they ended. Retry counts come from the engine's `onRetry`.
 */
export const runContentionHarness = async (
  options: ContentionOptions,
): Promise<ContentionReport> => {
  const started = Date.now();
  const errors: Record<string, number> = {};
  const waiting: (() => void)[] = [];
  let free = options.concurrency;
  let committed = 0;
  const acquire = () =>
    free > 0
      ? ((free -= 1), Promise.resolve())
      : new Promise<void>((resolve) => waiting.push(resolve));
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else free += 1;
  };
  await Promise.all(
    Array.from({ length: options.transactions }, async (_, index) => {
      await sleep((index * 1000) / options.ratePerSecond);
      await acquire();
      try {
        await options.run(index);
        committed += 1;
      } catch (error) {
        const name = error instanceof Error ? error.name : "unknown";
        errors[name] = (errors[name] ?? 0) + 1;
      } finally {
        release();
      }
    }),
  );
  return {
    transactions: options.transactions,
    committed,
    errors,
    durationMs: Date.now() - started,
  };
};
