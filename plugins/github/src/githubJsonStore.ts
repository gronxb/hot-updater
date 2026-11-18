import {
  compareUtf8,
  DATABASE_VERSION_COLUMN,
  type KeyValueStore,
  type KvCondition,
  type KvKey,
  type KvOp,
  type StoredRow,
  type WriteResult,
} from "@hot-updater/plugin-core";

import { createGithubClient, type GithubRepositoryOptions } from "./githubApi";
import {
  createGithubJsonFile,
  type GithubJsonFileLocation,
  GithubWriteConflictError,
} from "./githubJsonFile";

export interface GithubJsonStoreOptions
  extends GithubRepositoryOptions, Partial<GithubJsonFileLocation> {}

interface StoredItem {
  readonly value: StoredRow;
  /** When the item expires, in epoch milliseconds. */
  readonly expiresAt?: number;
}

/** Every item by partition key, then sort key. */
type Partitions = {
  readonly [pk: string]: { readonly [sk: string]: StoredItem };
};

export const DEFAULT_DATABASE_PATH = "hot-updater/database.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsePartitions = (data: unknown): Partitions => {
  if (!isRecord(data) || !Object.values(data).every(isRecord)) {
    throw new Error("The Hot Updater database file is malformed.");
  }
  return data as Partitions;
};

const holds = (
  partitions: Partitions,
  key: KvKey,
  condition: KvCondition | undefined,
): boolean => {
  if (condition === undefined) return true;
  const item = partitions[key.pk]?.[key.sk];
  return "v" in condition
    ? item?.value[DATABASE_VERSION_COLUMN] === condition.v
    : (item !== undefined) === condition.exists;
};

/** `partitions` without the items that expired by `now`; itself when none did. */
const withoutExpired = (partitions: Partitions, now: number): Partitions => {
  let next: Record<string, Partitions[string]> | undefined;
  for (const [pk, items] of Object.entries(partitions)) {
    const kept = Object.entries(items).filter(
      ([, item]) => item.expiresAt === undefined || item.expiresAt > now,
    );
    if (kept.length === Object.keys(items).length) continue;
    next ??= { ...partitions };
    if (kept.length === 0) delete next[pk];
    else next[pk] = Object.fromEntries(kept);
  }
  return next ?? partitions;
};

const applyOps = (partitions: Partitions, ops: readonly KvOp[]): Partitions => {
  const next: Record<string, Record<string, StoredItem>> = { ...partitions };
  const copied = new Set<string>();
  for (const op of ops) {
    if (op.type === "check") continue;
    const { pk, sk } = op.key;
    if (!copied.has(pk)) {
      next[pk] = { ...next[pk] };
      copied.add(pk);
    }
    const items = next[pk]!;
    const expiry =
      op.expiresAt === undefined ? {} : { expiresAt: op.expiresAt };
    if (op.type === "delete") {
      delete items[sk];
    } else if (op.type === "put") {
      // A put replaces the whole item, and any expiry it had.
      items[sk] = { value: op.value, ...expiry };
    } else {
      const current = items[sk];
      const value: Record<string, unknown> = {
        ...(current?.value ?? op.init),
      };
      for (const [name, delta] of Object.entries(op.by)) {
        value[name] = Number(value[name] ?? 0) + delta;
      }
      items[sk] = {
        ...(current ?? expiry),
        value: value as StoredRow,
      };
    }
  }
  for (const pk of copied) {
    if (Object.keys(next[pk]!).length === 0) delete next[pk];
  }
  return next;
};

/**
 * A key-value store kept as one JSON file in a GitHub repository. Every
 * write is one commit that replaces the file, guarded by the file's blob
 * SHA, so writes are atomic and a concurrent writer is refused instead of
 * overwritten. It suits the low write rates of releases; a table written on
 * every device event, such as Insights', would commit for each one.
 */
export const createGithubJsonStore = (
  options: GithubJsonStoreOptions,
): KeyValueStore => {
  const file = createGithubJsonFile<Partitions>({
    client: createGithubClient(options),
    path: options.path ?? DEFAULT_DATABASE_PATH,
    branch: options.branch,
    cacheTtlMs: options.cacheTtlMs,
    empty: () => ({}),
    parse: parsePartitions,
  });

  return {
    id: "github-json",
    // One commit replaces the whole file, so these bound a commit's size
    // rather than a backend's transaction.
    limits: { items: 300, bytes: 20_000_000 },
    async get(keys) {
      const partitions = await file.read();
      return keys.map(({ pk, sk }) => partitions[pk]?.[sk]?.value ?? null);
    },
    async query({ pk, gte, lt, order, limit, after }) {
      const direction = order === "asc" ? 1 : -1;
      const matching = Object.entries((await file.read())[pk] ?? {})
        .filter(
          ([sk]) =>
            (gte === undefined || compareUtf8(sk, gte) >= 0) &&
            (lt === undefined || compareUtf8(sk, lt) < 0) &&
            (after === undefined || direction * compareUtf8(sk, after) > 0),
        )
        .sort(([left], [right]) => direction * compareUtf8(left, right));
      return {
        items: matching
          .slice(0, limit)
          .map(([sk, item]) => ({ sk, value: item.value })),
        more: matching.length > limit,
      };
    },
    async write(ops) {
      const ids = new Set(ops.map(({ key }) => JSON.stringify(key)));
      if (ids.size !== ops.length) {
        throw new Error("A write may touch each item once.");
      }
      try {
        return await file.update<WriteResult>((stored) => {
          // The file has no clock of its own: a write drops what expired
          // before it, as a store's native TTL would in the background.
          const partitions = withoutExpired(stored, Date.now());
          const failedOp = ops.findIndex(
            (op) => !holds(partitions, op.key, op.condition),
          );
          return failedOp === -1
            ? { next: applyOps(partitions, ops), result: { ok: true } }
            : { result: { ok: false, failedOp } };
        });
      } catch (error) {
        if (error instanceof GithubWriteConflictError) {
          return { ok: false, retry: true };
        }
        throw error;
      }
    },
    async deleteConsumed(keys) {
      await file.update((partitions) => ({
        next: applyOps(
          partitions,
          keys.map((key) => ({ type: "delete", key })),
        ),
        result: undefined,
      }));
    },
    migrations: { apply: () => file.ensure() },
  };
};
