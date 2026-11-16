import { type DatabaseAdapter } from "../../database/adapter";
import { verifyAdapter } from "../../database/verifyAdapter";
import { createEngineReads } from "./engineReads";
import { createTransactions, type RetryOptions } from "./engineTransaction";
import { SETTINGS_TABLE } from "./fence";
import type { ReadMeasurement } from "./readMeter";
import type { ResolvedSchema } from "./resolveSchema";

export interface DatabaseEngineOptions {
  readonly adapter: DatabaseAdapter;
  readonly schema: ResolvedSchema;
  readonly maxPageSize?: number;
  /** Checks every adapter call against the contract and meters adapter reads. */
  readonly verify?: boolean;
  readonly retry?: RetryOptions;
}

/** Storage semantics over one adapter, addressed by physical table name. */
export const createStorageEngine = ({
  adapter: given,
  schema,
  maxPageSize,
  verify,
  retry,
}: DatabaseEngineOptions) => {
  const verified = verify ? verifyAdapter(given) : undefined;
  const adapter = verified ?? given;
  const reads = createEngineReads({ adapter, schema, maxPageSize });
  const { transaction } = createTransactions({ adapter, schema, reads, retry });
  return {
    reads,
    transaction,
    /** The adapter's snapshot reads, through every wrapper; absent without them. */
    readSnapshot: adapter.readSnapshot?.bind(adapter),
    /** One settings row's value, null when absent: a point read the meter counts. */
    async readSetting(key: string): Promise<string | null> {
      const [row] = await adapter.get(SETTINGS_TABLE, [[key]]);
      return typeof row?.value === "string" ? row.value : null;
    },
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

export type StorageEngine = ReturnType<typeof createStorageEngine>;
