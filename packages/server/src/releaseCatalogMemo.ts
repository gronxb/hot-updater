import {
  canonicalizeAppVersion,
  type ParsedReleaseCatalogPartition,
} from "@hot-updater/plugin-core";

import type {
  ReleaseCatalogHead,
  ReleaseCatalogState,
} from "./core/catalogReads";
import type { ParsedReleaseCatalogRow } from "./db/releaseCatalog";

/** How long an entry answers, from its load: absolute, never extended by a hit. */
export const RELEASE_CATALOG_MEMO_TTL_MS = 5_000;
/** Slots in all: an entry takes one, and a partitioned scope one more per row. */
export const RELEASE_CATALOG_MEMO_SLOTS = 128;

type Entry =
  | { readonly kind: "miss"; readonly expiresAt: number }
  | {
      readonly kind: "compact";
      readonly parsed: ParsedReleaseCatalogRow;
      readonly expiresAt: number;
    }
  | {
      readonly kind: "partitioned";
      readonly head: ReleaseCatalogHead;
      /** Rows verified under this head, each answering every version inside it. */
      readonly rows: ParsedReleaseCatalogPartition[];
      readonly expiresAt: number;
    };

const slotsOf = (entry: Entry) =>
  entry.kind === "partitioned" ? 1 + entry.rows.length : 1;

/**
 * Reads a scope's state for one app version; with `cached`, under the head
 * the memo holds (core's `readReleaseCatalogState`).
 */
export type ReleaseCatalogStateRead = (
  cached?: ReleaseCatalogHead,
) => Promise<ReleaseCatalogState>;

/** The state's answer covers `appVersion`: compact or none, or a row covering it. */
const answers = (state: ReleaseCatalogState, appVersion: string) =>
  state.kind !== "partitioned" ||
  (state.partition === null
    ? canonicalizeAppVersion(appVersion) === null
    : state.partition.covers(appVersion));

/**
 * The update check's memo, the server's only cache: per scope, a miss, a
 * compact row, or a head with the rows verified under it, for five seconds
 * from the load. It holds disposable copies of stored rows and authorizes
 * nothing, so losing it changes only cost.
 *
 * - Head loads are coalesced per scope, row loads per scope, head identity
 *   and version: a row attaches only to the entry of the head it was read
 *   under, so a replaced or expired head never gains a row of another state.
 * - A miss is cached only from a read that found no row. It takes a free
 *   slot or replaces the oldest miss, and never evicts a positive entry.
 * - A positive entry evicts misses first, then the least recently used
 *   positive entries, rows going with their head.
 * - A failed read caches nothing.
 */
export const createReleaseCatalogMemo = ({
  now = Date.now,
  ttlMs = RELEASE_CATALOG_MEMO_TTL_MS,
  slots = RELEASE_CATALOG_MEMO_SLOTS,
}: {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly slots?: number;
} = {}) => {
  const entries = new Map<string, Entry>();
  let used = 0;
  const headLoads = new Map<string, Promise<ReleaseCatalogState>>();
  const rowLoads = new Map<string, Promise<ReleaseCatalogState>>();

  const remove = (scopeKey: string) => {
    const entry = entries.get(scopeKey);
    if (entry === undefined) return;
    used -= slotsOf(entry);
    entries.delete(scopeKey);
  };
  const set = (scopeKey: string, entry: Entry) => {
    remove(scopeKey);
    entries.set(scopeKey, entry);
    used += slotsOf(entry);
  };
  /** The scope's unexpired entry; an expired one is dropped. */
  const live = (scopeKey: string): Entry | undefined => {
    const entry = entries.get(scopeKey);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now()) {
      remove(scopeKey);
      return undefined;
    }
    return entry;
  };
  /** Frees `needed` slots for a positive entry, never evicting `keep`. */
  const makeRoom = (needed: number, keep?: string): boolean => {
    for (const kind of ["miss", "positive"] as const) {
      // Deleting the entry a Map iteration is on is well-defined.
      for (const [scopeKey, entry] of entries) {
        if (used + needed <= slots) return true;
        if (
          scopeKey !== keep &&
          (kind === "positive" || entry.kind === "miss")
        ) {
          remove(scopeKey);
        }
      }
    }
    return used + needed <= slots;
  };

  /**
   * Caches a state read with no entry of its scope held: a head load starts
   * only without a live entry, and a row load removes the entry it replaces
   * first.
   */
  const admit = (scopeKey: string, state: ReleaseCatalogState) => {
    const expiresAt = now() + ttlMs;
    if (state.kind === "none") {
      // A miss takes a free slot or replaces the oldest miss; it never
      // evicts a positive entry.
      if (used + 1 > slots) {
        const oldest = [...entries].find(([, entry]) => entry.kind === "miss");
        if (oldest === undefined) return;
        remove(oldest[0]);
      }
      set(scopeKey, { expiresAt, kind: "miss" });
      return;
    }
    const entry: Entry =
      state.kind === "compact"
        ? { expiresAt, kind: "compact", parsed: state.parsed }
        : {
            expiresAt,
            head: state.head,
            kind: "partitioned",
            rows: state.partition === null ? [] : [state.partition],
          };
    if (makeRoom(slotsOf(entry))) set(scopeKey, entry);
  };

  /** Attaches a row read under `head`, if the scope's entry still is that head. */
  const attach = (
    scopeKey: string,
    head: ReleaseCatalogHead,
    partition: ParsedReleaseCatalogPartition,
  ) => {
    const entry = live(scopeKey);
    if (
      entry?.kind !== "partitioned" ||
      entry.head.identity !== head.identity ||
      entry.rows.some(
        (row) => row.partition.lowerKey === partition.partition.lowerKey,
      ) ||
      !makeRoom(1, scopeKey)
    ) {
      return;
    }
    entry.rows.push(partition);
    used += 1;
  };

  /** A row read under `head`, coalesced with every other read of it. */
  const loadRow = (
    scopeKey: string,
    head: ReleaseCatalogHead,
    appVersion: string,
    read: ReleaseCatalogStateRead,
  ): Promise<ReleaseCatalogState> => {
    const key = JSON.stringify([
      scopeKey,
      head.identity,
      canonicalizeAppVersion(appVersion),
    ]);
    let load = rowLoads.get(key);
    if (load === undefined) {
      load = read(head).then((state) => {
        if (
          state.kind === "partitioned" &&
          state.head.identity === head.identity
        ) {
          if (state.partition !== null) {
            attach(scopeKey, head, state.partition);
          }
        } else {
          // The head moved on. Replace the entry it was read under, if it is
          // still the scope's; a newer one stays.
          const entry = live(scopeKey);
          if (
            entry?.kind === "partitioned" &&
            entry.head.identity === head.identity
          ) {
            remove(scopeKey);
            admit(scopeKey, state);
          }
        }
        return state;
      });
      const pending = load;
      rowLoads.set(key, pending);
      void pending.then(
        () => rowLoads.delete(key),
        () => rowLoads.delete(key),
      );
    }
    return load;
  };

  return {
    /** The state an update check of `appVersion` answers from. */
    async load(
      scopeKey: string,
      appVersion: string,
      read: ReleaseCatalogStateRead,
    ): Promise<ReleaseCatalogState> {
      const entry = live(scopeKey);
      if (entry !== undefined) {
        // Recently used: last to be evicted.
        entries.delete(scopeKey);
        entries.set(scopeKey, entry);
        switch (entry.kind) {
          case "miss":
            return { kind: "none" };
          case "compact":
            return { kind: "compact", parsed: entry.parsed };
          case "partitioned": {
            const state: ReleaseCatalogState = {
              head: entry.head,
              kind: "partitioned",
              partition:
                entry.rows.find((row) => row.covers(appVersion)) ?? null,
            };
            return answers(state, appVersion)
              ? state
              : loadRow(scopeKey, entry.head, appVersion, read);
          }
        }
      }
      let load = headLoads.get(scopeKey);
      if (load === undefined) {
        load = read().then((state) => {
          admit(scopeKey, state);
          return state;
        });
        const pending = load;
        headLoads.set(scopeKey, pending);
        void pending.then(
          () => headLoads.delete(scopeKey),
          () => headLoads.delete(scopeKey),
        );
      }
      const state = await load;
      // A load another version started: read this version's row under its head.
      return answers(state, appVersion) || state.kind !== "partitioned"
        ? state
        : loadRow(scopeKey, state.head, appVersion, read);
    },
    /** Slots in use, and the scopes held: for tests. */
    stats: () => ({ entries: entries.size, used }),
  };
};
