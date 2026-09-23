import {
  type DatabaseAdapter,
  type DatabaseReadCount,
  verifyAdapter,
} from "@hot-updater/plugin-core/internal";

import { createEngineReads, type EngineReadCount } from "./engineReads";
import { createTransactions, type RetryOptions } from "./engineTransaction";
import type { ResolvedSchema } from "./resolveSchema";

export interface DatabaseEngineOptions {
  readonly adapter: DatabaseAdapter;
  readonly schema: ResolvedSchema;
  readonly maxPageSize?: number;
  /** Checks every adapter call against the contract and meters adapter reads. */
  readonly verify?: boolean;
  readonly retry?: RetryOptions;
}

export interface ReadMeasurement<T> {
  readonly result: T;
  /** Point reads and rows the adapter returned. */
  readonly adapter: DatabaseReadCount;
  /** Calls and rows (logical rows for aggregates) returned to callers. */
  readonly engine: EngineReadCount;
}

/** Storage semantics over one adapter, addressed by physical table name. */
export const createEngine = (options: DatabaseEngineOptions) => {
  const verified = options.verify ? verifyAdapter(options.adapter) : undefined;
  const adapter = verified ?? options.adapter;
  const reads = createEngineReads({
    adapter,
    schema: options.schema,
    ...(options.maxPageSize === undefined
      ? {}
      : { maxPageSize: options.maxPageSize }),
  });
  const { transaction } = createTransactions({
    adapter,
    schema: options.schema,
    reads,
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  });
  return {
    reads,
    transaction,
    /** Runs `read` and reports what it read at both boundaries (verify mode only). */
    async measureReads<T>(read: () => Promise<T>): Promise<ReadMeasurement<T>> {
      if (verified === undefined) {
        throw new Error(
          "measureReads needs an engine created with verify: true.",
        );
      }
      verified.reads.reset();
      reads.reads.reset();
      const result = await read();
      return {
        result,
        adapter: verified.reads.total(),
        engine: reads.reads.total(),
      };
    },
  };
};

export type Engine = ReturnType<typeof createEngine>;
