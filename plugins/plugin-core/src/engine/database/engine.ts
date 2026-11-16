import { type DatabaseAdapter, type WriteOp } from "../../database/adapter";
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

/** One settings row's change: from `expected` to `value`; null is absent. */
export interface SettingSwap {
  readonly key: string;
  readonly expected: string | null;
  readonly value: string | null;
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
    /** The adapter's declared per-request query cap, through every wrapper. */
    maxQueriesPerRequest: adapter.maxQueriesPerRequest,
    /** One settings row's value, null when absent: a point read the meter counts. */
    async readSetting(key: string): Promise<string | null> {
      const [row] = await adapter.get(SETTINGS_TABLE, [[key]]);
      return typeof row?.value === "string" ? row.value : null;
    },
    /**
     * Changes settings rows in one atomic write, each only while it still
     * holds `expected` (null: absent); `value` null deletes it. False when
     * any row held another value, or changed before the write committed.
     */
    async swapSettings(changes: readonly SettingSwap[]): Promise<boolean> {
      const rows = await adapter.get(
        SETTINGS_TABLE,
        changes.map(({ key }) => [key]),
      );
      const ops: WriteOp[] = [];
      for (const [index, { key, expected, value }] of changes.entries()) {
        const row = rows[index] ?? null;
        const stored = typeof row?.value === "string" ? row.value : null;
        if (stored !== expected) return false;
        if (value === expected) continue;
        if (row === null) {
          ops.push({
            type: "insert",
            table: SETTINGS_TABLE,
            row: { key, value, _v: 0 },
          });
          continue;
        }
        const guard = { v: Number(row._v) };
        ops.push(
          value === null
            ? {
                type: "delete",
                table: SETTINGS_TABLE,
                key: [key],
                guard,
                previous: row,
              }
            : {
                type: "patch",
                table: SETTINGS_TABLE,
                key: [key],
                set: { value },
                guard,
                previous: row,
              },
        );
      }
      if (ops.length === 0) return true;
      return (await adapter.write(ops)).ok;
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
