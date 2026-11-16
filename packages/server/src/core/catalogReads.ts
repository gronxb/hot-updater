import {
  assembleReleaseCatalog,
  type CatalogWriteSupport,
  canonicalizeAppVersion,
  type CoreSchema,
  DatabaseSnapshotConflictError,
  type HotUpdaterDatabase,
  type ParsedReleaseCatalogPartition,
  parseReleaseCatalogPartition,
  type ReadRow,
  type ReleaseCatalogAssembly,
  releaseCatalogKeyRanges,
  releaseCatalogLookupKey,
  type ReleaseCatalogPartition,
  type ReleaseCatalogRow,
  type SnapshotReads,
} from "@hot-updater/plugin-core";
import type { ReleaseCatalog } from "@hot-updater/protocol";

import {
  parseCompiledPayload,
  type ParsedReleaseCatalogRow,
  projectParsedReleaseCatalogRow,
  releaseCatalogAnswer,
  type ReleaseCatalogRequest,
} from "../db/releaseCatalog";
import { baseBundleIdsFrom, baseBundleIdsOfCompiled } from "./baseCandidates";

/**
 * Core's tables, with the snapshot reads a partitioned scope is read in, and
 * what its catalog writer reads and checks besides.
 */
export type CoreDatabase = HotUpdaterDatabase<CoreSchema> &
  SnapshotReads<CoreSchema> &
  CatalogWriteSupport<CoreSchema>;

export type CatalogReader = Pick<CoreDatabase, "findOne" | "findMany">;

export const PARTITIONS = "release_catalog_partitions";
/** Partition rows per page: 50 rows of at most 256 KB fit one 16 MiB MongoDB batch. */
export const PARTITION_PAGE = 50;
/** Reads of a head and its rows after the first, before a read gives up. */
const REREADS = 3;

/**
 * A partitioned scope's rows didn't agree with its head on every read: a
 * write kept moving them, or a row is missing or corrupt. Retryable, and
 * never cached: the update check answers 503 `private, no-store`, and the
 * admin API 503 with `CATALOG_SNAPSHOT_CONFLICT`.
 */
export class ReleaseCatalogReadConflictError extends Error {
  readonly name = "ReleaseCatalogReadConflictError";
  readonly code = "CATALOG_SNAPSHOT_CONFLICT";

  constructor(
    readonly scopeKey: string,
    options?: { readonly cause?: unknown },
  ) {
    super(
      `The release catalog of ${scopeKey} changed on every read; try again.`,
      options,
    );
  }
}

/** Whether a read failure is one a retry can clear: a 503, never a cached answer. */
export const isRetryableCatalogRead = (error: unknown): boolean =>
  error instanceof ReleaseCatalogReadConflictError ||
  error instanceof DatabaseSnapshotConflictError;

// --- Stored layouts --------------------------------------------------------

/**
 * A partitioned scope's own row: today's columns, with a payload naming the
 * live epoch, `{"epoch":X,"layout":"partitioned","partitioning":1,
 * "strategy":"APP_VERSION"}`. It has no `schemaVersion`, so every released
 * parser throws on it.
 */
export interface ReleaseCatalogHead {
  readonly row: Omit<ReleaseCatalogRow, "payload">;
  readonly epoch: string;
  /** `(catalog_id, generation, catalog_hash, epoch)`: equal heads name equal rows. */
  readonly identity: string;
}

export type StoredReleaseCatalog =
  | { readonly kind: "compact"; readonly parsed: ParsedReleaseCatalogRow }
  | { readonly kind: "partitioned"; readonly head: ReleaseCatalogHead };

const HEAD_KEYS = ["epoch", "layout", "partitioning", "strategy"].join();

const headOf = (row: ReleaseCatalogRow, payload: unknown) => {
  const head = payload as Record<string, unknown>;
  const { epoch } = head;
  if (
    Object.keys(head).sort().join() !== HEAD_KEYS ||
    head.layout !== "partitioned" ||
    head.partitioning !== 1 ||
    head.strategy !== "APP_VERSION" ||
    row.strategy !== "APP_VERSION" ||
    typeof epoch !== "string" ||
    !/^[0-9a-f-]{1,36}$/.test(epoch)
  ) {
    // A layout this core doesn't know fails closed, never as a catalog.
    throw new Error("Stored Release catalog head is invalid");
  }
  const { payload: _payload, ...rest } = row;
  return {
    epoch,
    identity: JSON.stringify([
      row.catalog_id,
      row.generation,
      row.catalog_hash,
      epoch,
    ]),
    row: rest,
  };
};

/**
 * A stored catalog row by its layout: compact, parsed as today, or a
 * partitioned scope's head. The row itself says which; nothing else does.
 */
export const readStoredCatalog = (
  row: ReleaseCatalogRow,
): StoredReleaseCatalog => {
  const payload: unknown = JSON.parse(row.payload);
  if (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    "layout" in payload
  ) {
    return { head: headOf(row, payload), kind: "partitioned" };
  }
  const { payload: _payload, ...rest } = row;
  return {
    kind: "compact",
    parsed: {
      compiled: parseCompiledPayload(payload, row.strategy),
      row: rest,
    },
  };
};

/**
 * Whether a row is a head, without parsing a compact payload: no compact
 * catalog has a `layout` key, and inside a JSON string its quotes are
 * escaped.
 */
export const mayBeHead = (row: { readonly payload: string }) =>
  row.payload.includes('"layout":');

// --- Rows ---------------------------------------------------------------

export type PartitionRow = ReadRow<CoreSchema["release_catalog_partitions"]>;

export const toPartition = (row: PartitionRow): ReleaseCatalogPartition => ({
  byteSize: row.byte_size,
  lowerKey: row.lower_key,
  partitionHash: row.partition_hash,
  payload: row.payload,
});

/** A row read under `head`, or null when it can't be the head's content. */
export const verified = (
  head: ReleaseCatalogHead,
  row: PartitionRow,
): ParsedReleaseCatalogPartition | null => {
  if (row.epoch !== head.epoch || row.generation > head.row.generation) {
    return null;
  }
  try {
    return parseReleaseCatalogPartition(toPartition(row));
  } catch {
    return null;
  }
};

/** Every row of the head's epoch, in key order, a page at a time. */
export const epochRows = async (
  reader: CatalogReader,
  head: ReleaseCatalogHead,
): Promise<PartitionRow[]> => {
  const rows: PartitionRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await reader.findMany(PARTITIONS, {
      index: "byScope",
      where: { scope_key: head.row.scope_key },
      range: { gte: [head.epoch], lte: [head.epoch] },
      limit: PARTITION_PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    rows.push(...page.rows);
    cursor = page.next;
  } while (cursor !== undefined);
  return rows;
};

export const RETRY = Symbol("retry");
export type Attempt<T> = T | typeof RETRY;

/**
 * Every row of the head's epoch, verified, when together they tile the
 * whole version line as `assembleReleaseCatalog` checks it, with that
 * assembly. A retry for a row of another epoch or a newer generation, a
 * corrupt row, a hole, an overlap, or no rows at all: rows of two states,
 * or rows still missing.
 */
export const epochTiling = async (
  reader: CatalogReader,
  head: ReleaseCatalogHead,
): Promise<
  Attempt<{
    readonly rows: readonly ParsedReleaseCatalogPartition[];
    readonly assembly: ReleaseCatalogAssembly;
  }>
> => {
  const rows: ParsedReleaseCatalogPartition[] = [];
  for (const row of await epochRows(reader, head)) {
    const partition = verified(head, row);
    if (partition === null) return RETRY;
    rows.push(partition);
  }
  try {
    const assembly = assembleReleaseCatalog(
      rows.map(({ partition }) => partition),
    );
    return { assembly, rows };
  } catch {
    return RETRY;
  }
};

/**
 * Runs `attempt` until it isn't a retry, at most `1 + REREADS` times, then
 * throws the conflict. A torn read, a missing row or one of a newer
 * generation all retry, and none is ever an answer.
 */
const reread = async <T>(
  scopeKey: string,
  attempt: (index: number) => Promise<Attempt<T>>,
): Promise<T> => {
  for (let index = 0; index <= REREADS; index += 1) {
    const result = await attempt(index);
    if (result !== RETRY) return result;
  }
  throw new ReleaseCatalogReadConflictError(scopeKey);
};

// --- The update check ------------------------------------------------------

/** What an update check answers from. */
export type ReleaseCatalogState =
  | { readonly kind: "none" }
  | { readonly kind: "compact"; readonly parsed: ParsedReleaseCatalogRow }
  | {
      readonly kind: "partitioned";
      readonly head: ReleaseCatalogHead;
      /** The row covering the version; null when the version has no canonical form. */
      readonly partition: ParsedReleaseCatalogPartition | null;
    };

/**
 * The lookup key of an app version: null when it has no canonical form, so
 * it receives empty lists, as `projectCompiledCatalog` gives it from a
 * compact catalog. Every canonical version has a key.
 */
const lookupKeyOf = (appVersion: string): string | null => {
  const canonical = canonicalizeAppVersion(appVersion);
  if (canonical === null) return null;
  const key = releaseCatalogLookupKey(canonical);
  if (key === null) {
    throw new Error(`App version ${canonical} has no release catalog key`);
  }
  return key;
};

/** The row covering `appVersion` under `head`, from one desc limit-1 read. */
const coveringRow = async (
  reader: CatalogReader,
  head: ReleaseCatalogHead,
  appVersion: string,
): Promise<Attempt<ReleaseCatalogState>> => {
  const key = lookupKeyOf(appVersion);
  if (key === null) return { head, kind: "partitioned", partition: null };
  const { rows } = await reader.findMany(PARTITIONS, {
    index: "byScope",
    where: { scope_key: head.row.scope_key },
    range: { gte: [head.epoch, ""], lte: [head.epoch, key] },
    order: "desc",
    limit: 1,
  });
  const row = rows[0];
  const partition = row === undefined ? null : verified(head, row);
  return partition === null || !partition.covers(appVersion)
    ? RETRY
    : { head, kind: "partitioned", partition };
};

/** A scope's row by its layout; none when it has no row. */
const storedOf = (
  row: Readonly<Record<string, unknown>> | null,
): { readonly kind: "none" } | StoredReleaseCatalog =>
  row === null ? { kind: "none" } : readStoredCatalog(toCatalogRow(row));

/** The scope's row and, when it is a head, its covering row, in one reader. */
const headAndRow = async (
  reader: CatalogReader,
  scopeKey: string,
  appVersion: string,
): Promise<Attempt<ReleaseCatalogState>> => {
  const stored = storedOf(
    await reader.findOne("release_catalogs", { scope_key: scopeKey }),
  );
  return stored.kind === "partitioned"
    ? coveringRow(reader, stored.head, appVersion)
    : stored;
};

/**
 * What an update check of `appVersion` answers from, read as the row says:
 * - no row: none, the marked no-catalog 404;
 * - a compact row: itself, as today, with no other read;
 * - a head: its covering row too, accepted only from the head's epoch, at
 *   or below its generation, covering the version. On a database with
 *   snapshots, the head is read again with the row in one snapshot, and the
 *   answer is that head, whatever its layout.
 *
 * With `cached`, a head a memo already holds: on a database without
 * snapshots only the covering row is read, under it; with snapshots both
 * are, and the caller compares the head it gets. Otherwise, it rereads,
 * then throws `ReleaseCatalogReadConflictError`.
 */
export const readReleaseCatalogState = (
  db: CoreDatabase,
  scopeKey: string,
  appVersion: string,
  cached?: ReleaseCatalogHead,
): Promise<ReleaseCatalogState> =>
  reread(scopeKey, async (attempt) => {
    if (db.snapshots && (cached !== undefined || attempt > 0)) {
      return db.snapshot((reader) => headAndRow(reader, scopeKey, appVersion));
    }
    if (cached !== undefined && attempt === 0) {
      return coveringRow(db, cached, appVersion);
    }
    const stored = storedOf(
      await db.findOne("release_catalogs", { scope_key: scopeKey }),
    );
    if (stored.kind !== "partitioned") return stored;
    return db.snapshots
      ? db.snapshot((reader) => headAndRow(reader, scopeKey, appVersion))
      : coveringRow(db, stored.head, appVersion);
  });

/** The update check's answer from a state; null for no catalog, or a row of another scope. */
export const projectReleaseCatalogState = (
  state: ReleaseCatalogState,
  input: ReleaseCatalogRequest,
  scopeKey: string,
): ReleaseCatalog | null => {
  switch (state.kind) {
    case "none":
      return null;
    case "compact":
      return projectParsedReleaseCatalogRow(state.parsed, input, scopeKey);
    case "partitioned": {
      const { head, partition } = state;
      return releaseCatalogAnswer(head.row, input, scopeKey, () => {
        // A head is an app-version row, so only an app-version check gets here.
        const { appVersion } = input as { readonly appVersion: string };
        // A version with no canonical form gets empty lists, as from a compact row.
        if (partition === null) return { releases: [], rollbackReleases: [] };
        const lists = partition.project(appVersion);
        if (lists === null) {
          // Never an empty answer for a row that doesn't cover the version.
          throw new ReleaseCatalogReadConflictError(scopeKey);
        }
        return lists;
      });
    }
  }
};

// --- Assembled public rows ------------------------------------------------

/**
 * A head's public row: today's compact payload, assembled from the live
 * epoch's rows, with the head's identity, generation and hash. The hash is
 * never computed again: at one generation every answer carries one hash.
 */
const assembledRow = async (
  reader: CatalogReader,
  head: ReleaseCatalogHead,
): Promise<Attempt<ReleaseCatalogRow>> => {
  const tiling = await epochTiling(reader, head);
  if (tiling === RETRY) return RETRY;
  const { byteSize, canonicalPayload } = tiling.assembly;
  return { ...head.row, byte_size: byteSize, payload: canonicalPayload };
};

const publicRowIn = async (
  reader: CatalogReader,
  row: ReleaseCatalogRow,
): Promise<Attempt<ReleaseCatalogRow>> => {
  if (!mayBeHead(row)) return row;
  const stored = readStoredCatalog(row);
  return stored.kind === "compact" ? row : assembledRow(reader, stored.head);
};

/**
 * A scope's public catalog row: compact as stored, or a head assembled into
 * the compact catalog its rows tile. Reads only the row for a compact
 * scope; a head's rows are read in one snapshot where the database has
 * them, and checked against its generation and for holes otherwise.
 */
export const readPublicCatalogRow = (
  db: CoreDatabase,
  scopeKey: string,
): Promise<ReleaseCatalogRow | null> =>
  reread(scopeKey, async (attempt) => {
    const read = async (reader: CatalogReader) => {
      const row = await reader.findOne("release_catalogs", {
        scope_key: scopeKey,
      });
      return row === null ? null : publicRowIn(reader, toCatalogRow(row));
    };
    if (db.snapshots && attempt > 0) return db.snapshot(read);
    const row = await db.findOne("release_catalogs", { scope_key: scopeKey });
    if (row === null) return null;
    const catalog = toCatalogRow(row);
    if (!mayBeHead(catalog)) return catalog;
    return db.snapshots ? db.snapshot(read) : publicRowIn(db, catalog);
  });

/**
 * Public rows of one listed page: compact rows as stored, and heads
 * assembled. With snapshots, a page holding a head is read again in one
 * snapshot with every head's rows, so the page and its rows agree.
 */
export const assemblePublicPage = async (
  db: CoreDatabase,
  rows: readonly ReleaseCatalogRow[],
  readPage: (reader: CatalogReader) => Promise<readonly ReleaseCatalogRow[]>,
): Promise<ReleaseCatalogRow[]> => {
  if (!rows.some(mayBeHead)) return [...rows];
  if (db.snapshots) {
    return reread(rows[0]!.scope_key, async () =>
      db.snapshot(async (reader) => {
        const assembled: ReleaseCatalogRow[] = [];
        for (const row of await readPage(reader)) {
          const result = await publicRowIn(reader, row);
          if (result === RETRY) return RETRY;
          assembled.push(result);
        }
        return assembled;
      }),
    );
  }
  const assembled: ReleaseCatalogRow[] = [];
  for (const row of rows) {
    const first = await publicRowIn(db, row);
    // A head's rows that moved on: read the scope again, never its raw head.
    const result =
      first === RETRY ? await readPublicCatalogRow(db, row.scope_key) : first;
    if (result !== null) assembled.push(result);
  }
  return assembled;
};

// --- Patch bases ------------------------------------------------------------

/**
 * The rows of the head's epoch over one key range: from the row at or below
 * `start` up to `stop`, read descending from `stop`, first one row, then
 * pages. They are the head's content when every row is stamped at or below
 * its generation and they chain from `start` to `stop` with no hole.
 */
export const rowsOver = async (
  reader: CatalogReader,
  head: ReleaseCatalogHead,
  { start, stop }: { readonly start: string; readonly stop: string | null },
): Promise<Attempt<ParsedReleaseCatalogPartition[]>> => {
  const found: ParsedReleaseCatalogPartition[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await reader.findMany(PARTITIONS, {
      index: "byScope",
      where: { scope_key: head.row.scope_key },
      range:
        stop === null
          ? { gte: [head.epoch, ""], lte: [head.epoch] }
          : { gte: [head.epoch, ""], lt: [head.epoch, stop] },
      order: "desc",
      // An exact version's interval lies inside one row: one read.
      limit: cursor === undefined ? 1 : PARTITION_PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const row of page.rows) {
      const partition = verified(head, row);
      if (partition === null) return RETRY;
      found.push(partition);
      if (partition.partition.lowerKey <= start) {
        found.reverse();
        // Chained: each row ends where the next begins, the last at `stop`.
        const chained = found.every((current, index) => {
          const next = found[index + 1];
          return next === undefined
            ? current.endKey === null ||
                (stop !== null && current.endKey >= stop)
            : current.endKey === next.partition.lowerKey;
        });
        return chained ? found : RETRY;
      }
    }
    if (page.next === undefined) return RETRY;
    cursor = page.next;
  }
};

/**
 * Patch bases under a head, from the rows its range covers; when its keys
 * don't fit, from every row, checked as one tiling.
 */
const headBaseBundleIds = async (
  reader: CatalogReader,
  head: ReleaseCatalogHead,
  range: string,
  bundleId: string,
  limit: number,
): Promise<Attempt<string[]>> => {
  const ranges = releaseCatalogKeyRanges(range);
  const rows = new Map<string, ParsedReleaseCatalogPartition>();
  if (ranges === null) {
    // Every row, accepted only as a whole tiling, as the public row is.
    const tiling = await epochTiling(reader, head);
    if (tiling === RETRY) return RETRY;
    for (const partition of tiling.rows) {
      rows.set(partition.partition.lowerKey, partition);
    }
  } else {
    for (const keys of ranges) {
      const over = await rowsOver(reader, head, keys);
      if (over === RETRY) return RETRY;
      for (const partition of over) {
        rows.set(partition.partition.lowerKey, partition);
      }
    }
  }
  return baseBundleIdsFrom(
    [...rows.values()].map(({ catalog, segment }) => ({
      descriptors: catalog.releaseDescriptors,
      segments: [segment],
    })),
    range,
    bundleId,
    limit,
  );
};

/**
 * Auto-patch bases of a scope: from its compact row, or under its head from
 * the rows its range covers, all of one snapshot or of one generation.
 */
export const readBaseBundleIds = (
  db: CoreDatabase,
  scopeKey: string,
  range: string | null,
  bundleId: string,
  limit: number,
): Promise<string[]> => {
  const fromRow = async (
    reader: CatalogReader,
    row: Readonly<Record<string, unknown>> | null,
  ): Promise<Attempt<string[]>> => {
    const stored = storedOf(row);
    if (stored.kind === "none") return [];
    if (stored.kind === "compact") {
      return baseBundleIdsOfCompiled(
        stored.parsed.compiled,
        range,
        bundleId,
        limit,
      );
    }
    // A head is always an app-version scope, whose key names a range.
    return range === null
      ? []
      : headBaseBundleIds(reader, stored.head, range, bundleId, limit);
  };
  const read = async (reader: CatalogReader) =>
    fromRow(
      reader,
      await reader.findOne("release_catalogs", { scope_key: scopeKey }),
    );
  return reread(scopeKey, async (attempt) => {
    if (db.snapshots && attempt > 0) return db.snapshot(read);
    const row = await db.findOne("release_catalogs", { scope_key: scopeKey });
    if (row === null || !mayBeHead(row)) return fromRow(db, row);
    return db.snapshots ? db.snapshot(read) : fromRow(db, row);
  });
};

const CATALOG_FIELDS = [
  "scope_key",
  "catalog_id",
  "strategy",
  "channel_id",
  "channel_key",
  "platform",
  "fingerprint_hash",
  "generation",
  "payload",
  "catalog_hash",
  "byte_size",
  "is_tombstone",
  "updated_at_ms",
] as const;

/** A stored row's public columns. */
export const toCatalogRow = (
  row: Readonly<Record<string, unknown>>,
): ReleaseCatalogRow =>
  Object.fromEntries(
    CATALOG_FIELDS.map((field) => [field, row[field]]),
  ) as unknown as ReleaseCatalogRow;
