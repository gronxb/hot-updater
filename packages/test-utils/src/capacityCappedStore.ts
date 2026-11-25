import type { KeyValueStore, KvOp } from "@hot-updater/plugin-core";

export interface CapacityCappedStoreOptions {
  /** The write units the store admits a second, as DynamoDB's `MaxWriteRequestUnits`. */
  readonly unitsPerSecond: number;
  /** Virtual time an admitted write takes; 300 ms by default. */
  readonly writeMs?: number;
  /**
   * Virtual time a throttled write takes before the store reports it: the
   * client's own throttling retries; 3 s by default.
   */
  readonly throttledMs?: number;
}

/**
 * DynamoDB's price of one op in `TransactWriteItems`: 2 write units per
 * started KB of the item.
 */
const unitsOf = (op: KvOp): number => {
  const item =
    op.type === "put"
      ? op.value
      : op.type === "add"
        ? { ...op.init, ...op.by }
        : {};
  const bytes = new TextEncoder().encode(
    JSON.stringify([op.key.pk, op.key.sk, item]),
  ).length;
  return 2 * Math.max(1, Math.ceil(bytes / 1024));
};

/**
 * `store` behind a strict write-capacity cap: a token bucket refilled at
 * `unitsPerSecond` on a virtual clock, holding one second of units, with
 * writes priced as DynamoDB prices transactional ones. A write that costs
 * more than the bucket holds is refused as DynamoDB's store reports a
 * throttle, `{ ok: false, retry: true }`, so one costing more than a second
 * of capacity is never admitted. DynamoDB with
 * `OnDemandThroughput.MaxWriteRequestUnits` is looser, since it admits such a
 * write from burst capacity when it has some and refuses by time window
 * otherwise; the strict cap makes a transaction too large for the cap fail
 * every time instead of by chance. Reads and `deleteConsumed` are not capped.
 */
export const createCapacityCappedStore = (
  store: KeyValueStore,
  { unitsPerSecond, writeMs = 300, throttledMs = 3_000 }: CapacityCappedStoreOptions,
): KeyValueStore & {
  /** Writes refused for capacity so far. */
  readonly throttles: () => number;
} => {
  let clock = 0;
  let filledAt = 0;
  let units = unitsPerSecond;
  let throttles = 0;
  return {
    ...store,
    throttles: () => throttles,
    async write(ops) {
      units = Math.min(
        unitsPerSecond,
        units + ((clock - filledAt) / 1_000) * unitsPerSecond,
      );
      filledAt = clock;
      const cost = ops.reduce((sum, op) => sum + unitsOf(op), 0);
      if (cost > units) {
        throttles += 1;
        clock += throttledMs;
        return { ok: false, retry: true };
      }
      const result = await store.write(ops);
      units -= cost;
      clock += writeMs;
      return result;
    },
  };
};
