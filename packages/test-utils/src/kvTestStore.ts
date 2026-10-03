import {
  compareUtf8,
  DATABASE_VERSION_COLUMN,
  type KeyValueStore,
  type KvCondition,
  type KvKey,
  type StoredRow,
} from "@hot-updater/plugin-core";

export interface MemoryKeyValueStoreOptions {
  /** Test-only: the most items one `query` page returns. */
  readonly nativePageSize?: number;
  readonly limits?: KeyValueStore["limits"];
}

/**
 * An in-memory key-value store that behaves like DynamoDB where the adapter
 * can tell: a write checks every condition against the state before it,
 * refuses two ops on one item, and applies all ops or none.
 */
export const createMemoryKeyValueStore = (
  options: MemoryKeyValueStoreOptions = {},
): KeyValueStore & {
  readonly items: () => number;
  /** Each item's expiry, as a store's native TTL would hold it, by `[pk, sk]` JSON. */
  readonly expiries: () => ReadonlyMap<string, number>;
} => {
  let partitions = new Map<string, Map<string, StoredRow>>();
  let expiries = new Map<string, number>();
  const read = (key: KvKey) => partitions.get(key.pk)?.get(key.sk) ?? null;
  const holds = (key: KvKey, condition: KvCondition | undefined) => {
    if (condition === undefined) return true;
    const item = read(key);
    return "v" in condition
      ? item !== null && item[DATABASE_VERSION_COLUMN] === condition.v
      : (item !== null) === condition.exists;
  };
  return {
    id: "memory-kv",
    limits: options.limits ?? { items: 100, bytes: 4_000_000 },
    items: () =>
      [...partitions.values()].reduce((sum, items) => sum + items.size, 0),
    expiries: () => expiries,
    async get(keys) {
      return keys.map((key) => structuredClone(read(key)));
    },
    async query({ pk, gte, lt, order, limit, after }) {
      const direction = order === "asc" ? 1 : -1;
      const matching = [...(partitions.get(pk) ?? new Map<string, StoredRow>())]
        .filter(
          ([sk]) =>
            (gte === undefined || compareUtf8(sk, gte) >= 0) &&
            (lt === undefined || compareUtf8(sk, lt) < 0) &&
            (after === undefined || direction * compareUtf8(sk, after) > 0),
        )
        .sort(([left], [right]) => direction * compareUtf8(left, right));
      const size = Math.min(limit, options.nativePageSize ?? limit);
      return {
        items: matching
          .slice(0, size)
          .map(([sk, value]) => ({ sk, value: structuredClone(value) })),
        more: matching.length > size,
      };
    },
    async write(ops) {
      const ids = new Set(ops.map(({ key }) => JSON.stringify(key)));
      if (ids.size !== ops.length) {
        throw new Error("A write may touch each item once.");
      }
      const failed = ops.findIndex((op) => !holds(op.key, op.condition));
      if (failed !== -1) return { ok: false, failedOp: failed };
      const next = new Map(partitions);
      const stamped = new Map(expiries);
      for (const op of ops) {
        if (op.type === "check") continue;
        const items = new Map(next.get(op.key.pk));
        next.set(op.key.pk, items);
        const id = JSON.stringify([op.key.pk, op.key.sk]);
        if (op.type === "delete") {
          items.delete(op.key.sk);
          stamped.delete(id);
        } else if (op.type === "put") {
          items.set(op.key.sk, structuredClone(op.value));
          // A put replaces the whole item, and any expiry it had.
          if (op.expiresAt === undefined) stamped.delete(id);
          else stamped.set(id, op.expiresAt);
        } else {
          if (!items.has(op.key.sk) && op.expiresAt !== undefined) {
            stamped.set(id, op.expiresAt);
          }
          const item: Record<string, unknown> = structuredClone(
            items.get(op.key.sk) ?? op.init ?? {},
          );
          for (const [name, delta] of Object.entries(op.by)) {
            item[name] = Number(item[name] ?? 0) + delta;
          }
          items.set(op.key.sk, item as StoredRow);
        }
      }
      partitions = next;
      expiries = stamped;
      return { ok: true };
    },
    async deleteConsumed(keys) {
      const next = new Map(partitions);
      for (const { pk, sk } of keys) {
        const items = new Map(next.get(pk));
        items.delete(sk);
        next.set(pk, items);
        expiries.delete(JSON.stringify([pk, sk]));
      }
      partitions = next;
    },
    async dispose() {
      partitions = new Map();
      expiries = new Map();
    },
  };
};
