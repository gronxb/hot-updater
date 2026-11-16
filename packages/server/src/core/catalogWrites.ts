import {
  assembleReleaseCatalog,
  compileReleaseCatalogTiling,
  type CompiledReleaseCatalog,
  type CoreSchema,
  createUUIDv7,
  DatabaseAmbiguousCommitError,
  DatabaseConstraintError,
  type HotUpdaterTransaction,
  insertReleaseIntoTiling,
  releaseCatalogKeyRanges,
  ReleaseCatalogMutationError,
  type ReleaseCatalogCompilation,
  type ReleaseCatalogPartition,
  type ReleaseCatalogRow,
  type ReleaseCatalogScope,
  type ReleaseRow,
  releaseRowToRelease,
  ReleaseCatalogTilingError,
  tileCompiledReleaseCatalog,
} from "@hot-updater/plugin-core";
import { encodeChannelKey } from "@hot-updater/protocol";

import {
  type CatalogReader,
  type CoreDatabase,
  epochTiling,
  PARTITIONS,
  type PartitionRow,
  RETRY,
  type ReleaseCatalogHead,
  ReleaseCatalogReadConflictError,
  readStoredCatalog,
  rowsOver,
  toCatalogRow,
} from "./catalogReads";

// A partitioned APP_VERSION scope is its `release_catalogs` row, the head,
// naming a live epoch whose rows in `release_catalog_partitions` tile the
// version line. Beside the rows, one staging row R names the only staged
// epoch that may still flip, and one marker per epoch keeps it discoverable
// until its rows are gone. Every decision here is made from persisted rows:
// nothing a process remembers between calls authorizes a write.

type CoreTransaction = HotUpdaterTransaction<CoreSchema>;
type StoredCatalog = NonNullable<
  Awaited<ReturnType<CoreTransaction["findOne"]>>
> & { readonly _v: number };

/** The persisted switch: `on` turns APP_VERSION scopes partitioned on their next write. */
export const PARTITIONING_SETTING = "catalog.partitioning";
/** R's key: `!` sorts below `#` and every epoch character. */
const STAGING_EPOCH = "!";
const STAGING_KEY = "!";
/** A marker's epoch column; its lower key is the epoch it marks. */
const MARKER_EPOCH = "#";
/** Discovery: R and up to 3 markers, never a partition row. */
const DISCOVERY_LIMIT = 4;
/** A cleanup page: at most 25 rows and 512 KiB. */
const PAGE_ROWS = 25;
const PAGE_BYTES = 512 * 1024;
/** Restarts of a staged publication before it gives up, retryably. */
const STAGING_RESTARTS = 5;
/** Cleanup steps a staged publication runs before it stages; it drains the rest after its flip. */
const PRE_STAGING_STEPS = 4;
/** Reruns of an attempt whose head moved between its reads. */
const RACE_RERUNS = 8;

const encoder = new TextEncoder();
const bytesOf = (text: string) => encoder.encode(text).byteLength;

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
};

const sha256 = async (value: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    encoder.encode(value),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

/** A head's payload: no `schemaVersion`, so every released parser throws on it. */
export const headPayload = (epoch: string): string =>
  canonical({
    epoch,
    layout: "partitioned",
    partitioning: 1,
    strategy: "APP_VERSION",
  });

/**
 * A head's catalog hash: it chains to the hash committed at the previous
 * generation, so one generation never carries two hashes.
 */
const chainHash = (input: {
  readonly previous: string | null;
  readonly generation: number;
  readonly catalogId: string;
  readonly epoch: string;
  readonly changes: readonly {
    readonly lowerKey: string;
    readonly partitionHash: string | null;
  }[];
}) => sha256(canonical(input));

// --- Staging rows and markers ------------------------------------------------

/** R's payload: the base generation and epoch of the one staged attempt that may flip. */
export interface StagingState {
  readonly base: number;
  readonly epoch: string | null;
}

export interface MarkerState {
  readonly epoch: string;
  readonly maxRowBytes: number;
}

/** What one discovery query returns: R, and the first markers in key order. */
export interface Discovery {
  readonly staging: StagingState | null;
  readonly markers: readonly MarkerState[];
}

const parseStaging = (payload: string): StagingState => {
  const parsed = JSON.parse(payload) as Record<string, unknown>;
  const { base, epoch } = parsed;
  if (
    !Number.isSafeInteger(base) ||
    (epoch !== null && typeof epoch !== "string")
  ) {
    throw new Error("Stored release catalog staging row is invalid");
  }
  return { base: base as number, epoch: epoch as string | null };
};

const parseMarker = (epoch: string, payload: string): MarkerState => {
  const { maxRowBytes } = JSON.parse(payload) as Record<string, unknown>;
  if (!Number.isSafeInteger(maxRowBytes)) {
    throw new Error("Stored release catalog marker is invalid");
  }
  return { epoch, maxRowBytes: maxRowBytes as number };
};

const stagingKey = (scopeKey: string) => ({
  epoch: STAGING_EPOCH,
  lower_key: STAGING_KEY,
  scope_key: scopeKey,
});
const markerKey = (scopeKey: string, epoch: string) => ({
  epoch: MARKER_EPOCH,
  lower_key: epoch,
  scope_key: scopeKey,
});

/** A control row's columns: R or a marker. */
const controlRow = async (payload: string, generation: number) => ({
  byte_size: bytesOf(payload),
  generation,
  partition_hash: await sha256(payload),
  payload,
});

/** R and up to 3 markers: one query of `[("!", ""), ("$", ""))`, never a partition row. */
export const readDiscovery = async (
  reader: Pick<CatalogReader, "findMany">,
  scopeKey: string,
): Promise<Discovery> => {
  const { rows } = await reader.findMany(PARTITIONS, {
    index: "byScope",
    where: { scope_key: scopeKey },
    range: { gte: [STAGING_EPOCH], lt: ["$"] },
    limit: DISCOVERY_LIMIT,
  });
  let staging: StagingState | null = null;
  const markers: MarkerState[] = [];
  for (const row of rows) {
    if (row.epoch === STAGING_EPOCH) staging = parseStaging(row.payload);
    else markers.push(parseMarker(row.lower_key, row.payload));
  }
  return { markers, staging };
};

// --- Layouts -------------------------------------------------------------------

/** What a scope's row says about its layout, and its base for the next write. */
interface Base {
  readonly row: StoredCatalog | null;
  readonly head: ReleaseCatalogHead | null;
  readonly generation: number;
}

const baseOf = (row: StoredCatalog | null): Base => {
  if (row === null) return { generation: 0, head: null, row };
  const catalog = toCatalogRow(row);
  const stored = readStoredCatalog(catalog);
  return {
    generation: catalog.generation,
    head: stored.kind === "partitioned" ? stored.head : null,
    row,
  };
};

/** The scope's catalog ID: kept across every layout, new for a new scope. */
const catalogIdOf = (base: Base) =>
  base.row === null ? createUUIDv7() : String(base.row.catalog_id);

const nextGeneration = (scope: ReleaseCatalogScope, base: Base) => {
  const generation = base.generation + 1;
  if (!Number.isSafeInteger(generation)) {
    throw new ReleaseCatalogMutationError(
      "CATALOG_GENERATION_EXHAUSTED",
      `Catalog "${scope.scopeKey}" exhausted its generation counter`,
    );
  }
  return generation;
};

/** The head row a partitioned scope publishes at `generation`. */
const headRow = (
  scope: ReleaseCatalogScope,
  input: {
    readonly catalogId: string;
    readonly epoch: string;
    readonly generation: number;
    readonly catalogHash: string;
    readonly updatedAtMs: number;
  },
): ReleaseCatalogRow => {
  const payload = headPayload(input.epoch);
  return {
    byte_size: bytesOf(payload),
    catalog_hash: input.catalogHash,
    catalog_id: input.catalogId,
    channel_id: scope.channelId,
    channel_key: encodeChannelKey(scope.channelName),
    fingerprint_hash: null,
    generation: input.generation,
    is_tombstone: false,
    payload,
    platform: scope.platform,
    scope_key: scope.scopeKey,
    strategy: "APP_VERSION",
    updated_at_ms: input.updatedAtMs,
  };
};

const writeHead = (
  tx: CoreTransaction,
  base: Base,
  head: ReleaseCatalogRow,
) => {
  const { scope_key: _scopeKey, ...set } = head;
  if (base.row === null) tx.create("release_catalogs", head);
  else tx.update("release_catalogs", base.row, set);
};

/** Rule W: every 1.2 transaction that creates a scope's row writes R, so a base-0 stager learns. */
const resetStaging = async (tx: CoreTransaction, scopeKey: string) => {
  const payload = canonical({ base: 0, epoch: null });
  const values = await controlRow(payload, 0);
  const current = await tx.findOne(PARTITIONS, stagingKey(scopeKey));
  if (current === null) {
    tx.create(PARTITIONS, { ...stagingKey(scopeKey), ...values });
  } else {
    tx.update(PARTITIONS, current, values);
  }
};

// --- Diagnostics --------------------------------------------------------------

type Diagnostics = ReleaseCatalogCompilation["diagnostics"];

const diagnosticsOf = (
  catalog: CompiledReleaseCatalog,
  byteSize: number,
  releaseCount: number,
): Diagnostics => ({
  byteSize,
  descriptorCount: catalog.releaseDescriptors.length,
  distinctTargetCohortCount: new Set(
    catalog.releaseDescriptors.flatMap(({ targetCohorts }) => targetCohorts),
  ).size,
  releaseCount,
  segmentCount:
    catalog.strategy === "APP_VERSION" ? catalog.segments.length : 1,
});

/** An insert's diagnostics, over the rows it rewrote. */
const rowDiagnostics = (
  rows: readonly ReleaseCatalogPartition[],
): Diagnostics => {
  const ids = new Set<string>();
  const cohorts = new Set<string>();
  let segments = 0;
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as Extract<
      CompiledReleaseCatalog,
      { readonly strategy: "APP_VERSION" }
    >;
    segments += payload.segments.length;
    for (const descriptor of payload.releaseDescriptors) {
      ids.add(descriptor.releaseId);
      for (const cohort of descriptor.targetCohorts) cohorts.add(cohort);
    }
  }
  return {
    byteSize: rows.reduce((total, row) => total + row.byteSize, 0),
    descriptorCount: ids.size,
    distinctTargetCohortCount: cohorts.size,
    releaseCount: ids.size,
    segmentCount: segments,
  };
};

// --- The writer -----------------------------------------------------------------

/**
 * How a call's transaction writes partitioned scopes:
 * - `atomic`: in place, or a new epoch, in this transaction;
 * - `plan`: inside `fits`, computes each partitioned scope's whole tiling
 *   for staging and writes what its flip will, with stand-ins for R and
 *   the epoch, so the probe compiles the final transaction;
 * - `flip`: publishes the staged epochs, each under its R and base;
 * - `compact`: today's single row for every scope;
 * - `preflight`: computes the whole tiling and writes nothing, answering
 *   with public rows: the current catalog and the projected one, both
 *   compact-format.
 */
export type CatalogWriteMode =
  | "atomic"
  | "plan"
  | "flip"
  | "compact"
  | "preflight";

/** A staged publication of one scope, computed in `plan` mode. */
export interface StagedPlan {
  readonly scope: ReleaseCatalogScope;
  /** The scope row's `_v` the tiling was computed from; null when it was absent. */
  readonly baseVersion: number | null;
  readonly baseGeneration: number;
  readonly rows: readonly ReleaseCatalogPartition[];
  /** The release the change wrote, so the flip writes the very same one. */
  readonly release: ReleaseRow | null;
  /** Assigned at registration. */
  epoch?: string;
}

/** What a committed atomic write leaves for its one cleanup step. */
interface Written {
  readonly scopeKey: string;
  readonly discovery: Discovery | null;
  readonly liveEpoch: string | null;
  readonly generation: number;
}

/** A head moved between the transaction's read of it and the rows read after: run again. */
class CatalogWriteRace extends Error {
  constructor(readonly scopeKey: string) {
    super(`The release catalog of ${scopeKey} moved while it was written`);
  }
}

/** A staged attempt that can no longer flip: R or the base moved on. */
class StagingLost extends Error {}

/** The base a staged tiling was computed from changed before registration (ruling 2). */
class ComputationStale extends Error {}

/** One partitioned scope's change, as `changeRelease` hands it over. */
export type PartitionedChange =
  | {
      readonly kind: "insert";
      readonly release: ReleaseRow;
      /** The scope's enabled releases with the change applied, read only when needed. */
      readonly next: () => Promise<readonly ReleaseRow[]>;
    }
  | {
      readonly kind: "recompute";
      readonly next: readonly ReleaseRow[];
      /** A rebuild publishes nothing when the live rows are what it computes. */
      readonly rebuild?: boolean;
    };

export interface PartitionedResult {
  /** Null: the scope stays compact; the caller writes today's row. */
  readonly catalog: ReleaseCatalogRow | null;
  readonly diagnostics?: Diagnostics;
  readonly changed?: boolean;
  /** In `preflight` mode, the scope's current public row. */
  readonly current?: ReleaseCatalogRow | null;
}

export interface CatalogWriter {
  readonly mode: CatalogWriteMode;
  /**
   * Whether this transaction writes the scope partitioned: its row is a
   * head, or the persisted switch is on for an APP_VERSION scope whose row
   * is compact or absent. FINGERPRINT scopes, and every scope in `compact`
   * mode, stay compact. Reads the switch only for a compact or absent
   * APP_VERSION scope, one point read.
   */
  layout(
    tx: CoreTransaction,
    scope: ReleaseCatalogScope,
    row: StoredCatalog | null,
  ): Promise<"compact" | "partitioned">;
  /** The release ID a staged plan fixed for this scope, so its flip writes the same release. */
  plannedReleaseId(scopeKey: string): string | undefined;
  /** Throws the staged attempt's restart when `id` is its planned release, now overtaken. */
  checkPlannedRelease(scopeKey: string, id: string): void;
  /** Writes (or plans, or flips) a partitioned scope's next catalog. */
  publish(
    tx: CoreTransaction,
    input: {
      readonly scope: ReleaseCatalogScope;
      readonly row: StoredCatalog | null;
      readonly change: PartitionedChange;
      readonly release: ReleaseRow | null;
      readonly updatedAtMs: number;
    },
  ): Promise<PartitionedResult>;
  /**
   * After a scope's row is written compact: rule W when it was created with
   * the switch on, and a cleanup step after the commit when it was a head.
   */
  wroteCompact(
    tx: CoreTransaction,
    scope: ReleaseCatalogScope,
    row: StoredCatalog | null,
  ): Promise<void>;
}

const sameRelease = (left: ReleaseRow | null, right: ReleaseRow | null) =>
  canonical(left) === canonical(right);

/** The rows of a head's epoch a change reads: those its ranges cover, or all of them. */
const readLive = async (
  db: CoreDatabase,
  head: ReleaseCatalogHead,
  ranges: ReturnType<typeof releaseCatalogKeyRanges> | "all",
) =>
  db.unguardedSnapshot(async (reader) => {
    const again = db.snapshots
      ? await reader.findOne("release_catalogs", {
          scope_key: head.row.scope_key,
        })
      : undefined;
    const discovery = await readDiscovery(reader, head.row.scope_key);
    const live = new Map<string, ReleaseCatalogPartition>();
    if (ranges === "all" || ranges === null) {
      // Every row, accepted only as one whole tiling.
      const tiling = await epochTiling(reader, head);
      if (tiling === RETRY) return RETRY;
      for (const { partition } of tiling.rows) {
        live.set(partition.lowerKey, partition);
      }
    } else {
      for (const range of ranges) {
        const over = await rowsOver(reader, head, range);
        if (over === RETRY) return RETRY;
        for (const { partition } of over)
          live.set(partition.lowerKey, partition);
      }
    }
    if (again !== undefined) {
      const stored =
        again === null ? null : readStoredCatalog(toCatalogRow(again));
      if (
        stored?.kind !== "partitioned" ||
        stored.head.identity !== head.identity
      ) {
        return RETRY;
      }
    }
    return {
      discovery,
      live: [...live.values()].sort((left, right) =>
        left.lowerKey < right.lowerKey ? -1 : 1,
      ),
    };
  });

/** A head's live rows' max byte size, from its marker in the discovery or one read. */
const liveMarker = async (
  tx: CoreTransaction,
  scopeKey: string,
  epoch: string,
) => tx.findOne(PARTITIONS, markerKey(scopeKey, epoch));

/**
 * Applies `next` over `live` in the live epoch: a row with the same key
 * and hash stays; another is rewritten in place or deleted; a new key is
 * inserted. Changed and new rows are stamped `generation`. Returns the
 * chain's changes and the largest row written.
 */
const writeDiff = async (
  db: CoreDatabase,
  tx: CoreTransaction,
  scopeKey: string,
  epoch: string,
  generation: number,
  live: readonly ReleaseCatalogPartition[],
  next: readonly ReleaseCatalogPartition[],
) => {
  const before = new Map(live.map((row) => [row.lowerKey, row]));
  const after = new Map(next.map((row) => [row.lowerKey, row]));
  const changes: { lowerKey: string; partitionHash: string | null }[] = [];
  const rewritten = next.filter(
    (row) => before.get(row.lowerKey)?.partitionHash !== row.partitionHash,
  );
  const removed = live.filter((row) => !after.has(row.lowerKey));
  // The rows this write replaces, read through the transaction in one batch.
  const replaced = [
    ...rewritten.filter((row) => before.has(row.lowerKey)),
    ...removed,
  ].map(({ lowerKey }) => lowerKey);
  const stored = await db.findByKeysIn(
    tx,
    PARTITIONS,
    replaced.map((lowerKey) => ({
      epoch,
      lower_key: lowerKey,
      scope_key: scopeKey,
    })),
  );
  const current = new Map(replaced.map((key, at) => [key, stored[at]]));
  const read = (lowerKey: string) => {
    const row = current.get(lowerKey);
    if (row === null || row === undefined) throw new CatalogWriteRace(scopeKey);
    return row;
  };
  let largest = 0;
  for (const row of rewritten) {
    const values = {
      byte_size: row.byteSize,
      generation,
      partition_hash: row.partitionHash,
      payload: row.payload,
    };
    largest = Math.max(largest, row.byteSize);
    changes.push({ lowerKey: row.lowerKey, partitionHash: row.partitionHash });
    if (before.has(row.lowerKey)) {
      tx.update(PARTITIONS, read(row.lowerKey), values);
    } else {
      tx.create(PARTITIONS, {
        epoch,
        lower_key: row.lowerKey,
        scope_key: scopeKey,
        ...values,
      });
    }
  }
  for (const row of removed) {
    changes.push({ lowerKey: row.lowerKey, partitionHash: null });
    await tx.delete(PARTITIONS, read(row.lowerKey));
  }
  changes.sort((left, right) => (left.lowerKey < right.lowerKey ? -1 : 1));
  return { changes, largest };
};

const compactPayloadOf = (row: StoredCatalog) =>
  JSON.parse(String(row.payload)) as CompiledReleaseCatalog;

/** A head's public row: its rows assembled into today's compact payload. */
const publicRowOf = (
  head: ReleaseCatalogHead,
  live: readonly ReleaseCatalogPartition[],
): ReleaseCatalogRow => {
  const { byteSize, canonicalPayload } = assembleReleaseCatalog(live);
  return { ...head.row, byte_size: byteSize, payload: canonicalPayload };
};

/** Whether two tilings store the same rows: lower keys and hashes. */
const sameLayout = (
  left: readonly ReleaseCatalogPartition[],
  right: readonly ReleaseCatalogPartition[],
) =>
  left.length === right.length &&
  left.every(
    (row, index) =>
      row.lowerKey === right[index]!.lowerKey &&
      row.partitionHash === right[index]!.partitionHash,
  );

/**
 * One call's writer: what its transaction attempts read and computed,
 * dropped when the call returns. Its decisions come from rows the
 * attempt reads; nothing here outlives the call.
 */
export const createCatalogWriter = (
  db: CoreDatabase,
  mode: CatalogWriteMode,
  plans: Map<string, StagedPlan> = new Map(),
): CatalogWriter & {
  readonly plans: Map<string, StagedPlan>;
  /** Scopes the last attempt wrote partitioned or retired: each gets a cleanup step. */
  readonly written: Map<string, Written>;
  /** Partitioned scopes the last attempt computed. */
  readonly partitioned: Set<string>;
} => {
  const written = new Map<string, Written>();
  const partitioned = new Set<string>();
  /** The switch, read once per call: it only ever goes from absent to on. */
  let switchOn: Promise<boolean> | undefined;
  const partitioning = () =>
    (switchOn ??= db
      .readSetting(PARTITIONING_SETTING)
      .then((value) => value === "on")
      .catch((error: unknown) => {
        switchOn = undefined;
        throw error;
      }));

  /** The tiling a change computes over a base, and what it read to do so. */
  const compute = async (
    scope: ReleaseCatalogScope,
    base: Base,
    change: PartitionedChange,
    whole: boolean,
  ): Promise<
    | {
        readonly kind: "compact";
        /** A head's whole live epoch, when the change read it. */
        readonly live?: readonly ReleaseCatalogPartition[];
      }
    | {
        readonly kind: "rows";
        /** The rows to write: the whole tiling, or an insert's replacements. */
        readonly rows: readonly ReleaseCatalogPartition[];
        /** The live rows those replace; all of them for a whole tiling. */
        readonly live: readonly ReleaseCatalogPartition[];
        readonly whole: boolean;
        readonly discovery: Discovery | null;
        readonly releaseCount: number | null;
      }
  > => {
    const { head } = base;
    if (head !== null) {
      const ranges =
        change.kind === "insert" && !whole
          ? releaseCatalogKeyRanges(change.release.target_app_version ?? "")
          : "all";
      if (ranges === null) return { kind: "compact" };
      const read = await readLive(db, head, ranges);
      if (read === RETRY) throw new CatalogWriteRace(scope.scopeKey);
      if (change.kind === "insert") {
        const rows = await insertReleaseIntoTiling({
          partitions: read.live,
          release: releaseRowToRelease(change.release),
        });
        if (rows === null) return { kind: "compact", live: read.live };
        return {
          discovery: read.discovery,
          kind: "rows",
          live: read.live,
          releaseCount: null,
          rows,
          whole: ranges === "all",
        };
      }
      const rows = await compileReleaseCatalogTiling({
        releases: change.next.map(releaseRowToRelease),
      });
      if (rows === null) return { kind: "compact", live: read.live };
      return {
        discovery: read.discovery,
        kind: "rows",
        live: read.live,
        releaseCount: change.next.length,
        rows,
        whole: true,
      };
    }
    // A conversion: a compact or absent scope, with the switch on.
    let rows: readonly ReleaseCatalogPartition[] | null = null;
    let releaseCount: number | null = null;
    if (change.kind === "insert" && base.row !== null) {
      try {
        const tiled = await tileCompiledReleaseCatalog(
          compactPayloadOf(base.row),
        );
        rows =
          tiled === null
            ? null
            : await insertReleaseIntoTiling({
                partitions: tiled,
                release: releaseRowToRelease(change.release),
              });
      } catch (error) {
        // A compact row another compiler wrote: compile the releases instead.
        if (!(error instanceof ReleaseCatalogTilingError)) throw error;
        const next = await change.next();
        releaseCount = next.length;
        rows = await compileReleaseCatalogTiling({
          releases: next.map(releaseRowToRelease),
        });
      }
    } else {
      const next = change.kind === "insert" ? await change.next() : change.next;
      releaseCount = next.length;
      rows = await compileReleaseCatalogTiling({
        releases: next.map(releaseRowToRelease),
      });
    }
    if (rows === null) return { kind: "compact" };
    return {
      discovery: null,
      kind: "rows",
      live: [],
      releaseCount,
      rows,
      whole: true,
    };
  };

  const writer: CatalogWriter = {
    mode,

    async layout(tx, scope, row) {
      if (mode === "compact" || scope.strategy !== "APP_VERSION") {
        return "compact";
      }
      if (baseOf(row).head !== null) return "partitioned";
      return (await partitioning()) ? "partitioned" : "compact";
    },

    plannedReleaseId: (scopeKey) =>
      mode === "flip" ? plans.get(scopeKey)?.release?.id : undefined,

    checkPlannedRelease(scopeKey, id) {
      if (mode === "flip" && plans.get(scopeKey)?.release?.id === id) {
        throw new StagingLost();
      }
    },

    async wroteCompact(tx, scope, row) {
      if (row !== null) {
        // A head written compact retires its epoch, which cleanup reclaims.
        if (baseOf(row).head !== null) {
          written.set(scope.scopeKey, {
            discovery: null,
            generation: row.generation + 1,
            liveEpoch: null,
            scopeKey: scope.scopeKey,
          });
        }
        return;
      }
      // Rule W, only with the switch on: with it off, no write touches the table.
      if (mode === "compact" || scope.strategy !== "APP_VERSION") return;
      if (!(await partitioning())) return;
      await resetStaging(tx, scope.scopeKey);
    },

    async publish(tx, { scope, row, change, release, updatedAtMs }) {
      const base = baseOf(row);
      partitioned.add(scope.scopeKey);
      const generation = nextGeneration(scope, base);

      const plan = mode === "flip" ? plans.get(scope.scopeKey) : undefined;
      if (plan !== undefined) {
        if (plan.epoch === undefined) throw new StagingLost();
        // The flip commits only while R names its epoch and the base holds.
        const same =
          plan.baseVersion === null
            ? base.row === null
            : base.row !== null && base.row._v === plan.baseVersion;
        const staging = await tx.findOne(
          PARTITIONS,
          stagingKey(scope.scopeKey),
        );
        const state = staging === null ? null : parseStaging(staging.payload);
        if (
          !same ||
          state?.epoch !== plan.epoch ||
          state.base !== plan.baseGeneration ||
          !sameRelease(release, plan.release)
        ) {
          throw new StagingLost();
        }
        const catalogId = catalogIdOf(base);
        const head = headRow(scope, {
          catalogId,
          catalogHash: await chainHash({
            catalogId,
            changes: plan.rows.map(({ lowerKey, partitionHash }) => ({
              lowerKey,
              partitionHash,
            })),
            epoch: plan.epoch,
            generation,
            previous: base.row === null ? null : String(base.row.catalog_hash),
          }),
          epoch: plan.epoch,
          generation,
          updatedAtMs,
        });
        writeHead(tx, base, head);
        if (base.row === null) await resetStaging(tx, scope.scopeKey);
        return { catalog: head, changed: true };
      }

      // A scope the plan left compact computes as an atomic write would.
      const computed = await compute(
        scope,
        base,
        change,
        mode === "plan" || mode === "preflight",
      );
      /** A preflight of a head answers its current public row even when it goes compact. */
      const currentOf = (
        live: readonly ReleaseCatalogPartition[] | undefined,
      ) =>
        mode === "preflight" && base.head !== null && live !== undefined
          ? { current: publicRowOf(base.head, live) }
          : {};
      if (computed.kind === "compact") {
        partitioned.delete(scope.scopeKey);
        return { catalog: null, ...currentOf(computed.live) };
      }
      const whole = computed.whole;
      const assembly = whole ? assembleReleaseCatalog(computed.rows) : null;
      // An empty catalog stays a compact tombstone, as today.
      if (
        assembly !== null &&
        assembly.payload.releaseDescriptors.length === 0
      ) {
        partitioned.delete(scope.scopeKey);
        return { catalog: null, ...currentOf(computed.live) };
      }
      const diagnostics =
        assembly === null
          ? rowDiagnostics(computed.rows)
          : diagnosticsOf(
              assembly.payload,
              assembly.byteSize,
              computed.releaseCount ??
                assembly.payload.releaseDescriptors.length,
            );

      if (mode === "preflight") {
        const current =
          base.row === null
            ? null
            : base.head === null
              ? toCatalogRow(base.row)
              : publicRowOf(base.head, computed.live);
        const projected = assembleReleaseCatalog(computed.rows);
        return {
          catalog: {
            ...headRow(scope, {
              catalogHash: await sha256(projected.canonicalPayload),
              catalogId: catalogIdOf(base),
              epoch: "",
              generation,
              updatedAtMs,
            }),
            byte_size: projected.byteSize,
            payload: projected.canonicalPayload,
          },
          changed: true,
          current,
          diagnostics,
        };
      }

      if (
        change.kind === "recompute" &&
        change.rebuild === true &&
        base.head !== null &&
        sameLayout(computed.live, computed.rows) &&
        String(base.row?.channel_id) === scope.channelId
      ) {
        // A rebuild whose rows are already live writes nothing.
        partitioned.delete(scope.scopeKey);
        return {
          catalog: toCatalogRow(base.row!),
          changed: false,
          diagnostics,
        };
      }

      if (mode === "plan") {
        plans.set(scope.scopeKey, {
          baseGeneration: base.generation,
          baseVersion: base.row === null ? null : base.row._v,
          release,
          rows: computed.rows,
          scope,
        });
        // What the flip writes, with stand-ins of the same size: the head
        // naming a fresh epoch, and R read (a check) or written.
        const epoch = crypto.randomUUID();
        const head = headRow(scope, {
          catalogId: catalogIdOf(base),
          catalogHash: await sha256(epoch),
          epoch,
          generation,
          updatedAtMs,
        });
        writeHead(tx, base, head);
        const staging = await tx.findOne(
          PARTITIONS,
          stagingKey(scope.scopeKey),
        );
        if (base.row === null) {
          await resetStaging(tx, scope.scopeKey);
        } else if (staging === null) {
          tx.create(PARTITIONS, {
            ...stagingKey(scope.scopeKey),
            ...(await controlRow(
              canonical({ base: base.generation, epoch }),
              base.generation,
            )),
          });
        }
        return { catalog: head, changed: true, diagnostics };
      }

      // Atomic: in the live epoch, or a fresh one.
      const largest = Math.max(0, ...computed.rows.map((row) => row.byteSize));
      let epoch: string;
      let changes: { lowerKey: string; partitionHash: string | null }[];
      if (base.head !== null) {
        epoch = base.head.epoch;
        const diff = await writeDiff(
          db,
          tx,
          scope.scopeKey,
          epoch,
          generation,
          computed.live,
          computed.rows,
        );
        changes = diff.changes;
        const known = computed.discovery?.markers.find(
          (marker) => marker.epoch === epoch,
        );
        if (diff.largest > (known?.maxRowBytes ?? 0)) {
          const marker = await liveMarker(tx, scope.scopeKey, epoch);
          const current =
            marker === null
              ? 0
              : parseMarker(epoch, marker.payload).maxRowBytes;
          if (diff.largest > current) {
            const values = await controlRow(
              canonical({ maxRowBytes: diff.largest }),
              marker === null ? base.generation : marker.generation,
            );
            if (marker === null) {
              tx.create(PARTITIONS, {
                ...markerKey(scope.scopeKey, epoch),
                ...values,
              });
            } else {
              tx.update(PARTITIONS, marker, values);
            }
          }
        }
      } else {
        epoch = crypto.randomUUID();
        changes = computed.rows.map(({ lowerKey, partitionHash }) => ({
          lowerKey,
          partitionHash,
        }));
        tx.create(PARTITIONS, {
          ...markerKey(scope.scopeKey, epoch),
          ...(await controlRow(
            canonical({ maxRowBytes: largest }),
            base.generation,
          )),
        });
        for (const row of computed.rows) {
          tx.create(PARTITIONS, {
            byte_size: row.byteSize,
            epoch,
            generation,
            lower_key: row.lowerKey,
            partition_hash: row.partitionHash,
            payload: row.payload,
            scope_key: scope.scopeKey,
          });
        }
        if (base.row === null) await resetStaging(tx, scope.scopeKey);
      }
      const catalogId = catalogIdOf(base);
      const head = headRow(scope, {
        catalogId,
        catalogHash: await chainHash({
          catalogId,
          changes,
          epoch,
          generation,
          previous: base.row === null ? null : String(base.row.catalog_hash),
        }),
        epoch,
        generation,
        updatedAtMs,
      });
      writeHead(tx, base, head);
      written.set(scope.scopeKey, {
        discovery: computed.discovery,
        generation,
        liveEpoch: epoch,
        scopeKey: scope.scopeKey,
      });
      return { catalog: head, changed: true, diagnostics };
    },
  };
  return Object.assign(writer, { partitioned, plans, written });
};

/**
 * What a rebuild of a partitioned scope would write: its live rows' layout
 * against the tiling of `enabled`, read in one snapshot. Null for a compact
 * scope, which the caller checks as today, and when the scope would go
 * compact: its keys don't fit, or its catalog is empty.
 */
export const projectRebuild = async (
  db: CoreDatabase,
  scope: ReleaseCatalogScope,
  stored: ReleaseCatalogRow,
  enabled: readonly ReleaseRow[],
): Promise<{
  readonly changed: boolean;
  readonly currentCatalog: ReleaseCatalogRow;
  readonly diagnostics: Diagnostics;
  readonly projectedCatalog: Pick<
    ReleaseCatalogRow,
    "byte_size" | "catalog_hash" | "is_tombstone" | "payload"
  >;
} | null> => {
  const layout = readStoredCatalog(stored);
  // A compact scope is judged on its content, as today: converting it on its
  // next write is a layout change, not a catalog that differs from its
  // releases. So this reads no switch.
  if (layout.kind === "compact") return null;
  const rows = await compileReleaseCatalogTiling({
    releases: enabled.map(releaseRowToRelease),
  });
  if (rows === null) return null;
  const projected = assembleReleaseCatalog(rows);
  if (projected.payload.releaseDescriptors.length === 0) return null;
  const diagnostics = diagnosticsOf(
    projected.payload,
    projected.byteSize,
    enabled.length,
  );
  const projectedCatalog = {
    byte_size: projected.byteSize,
    catalog_hash: await sha256(projected.canonicalPayload),
    is_tombstone: false,
    payload: projected.canonicalPayload,
  };
  const { head } = layout;
  const live = await db.snapshot(async (reader) => {
    const again = await reader.findOne("release_catalogs", {
      scope_key: scope.scopeKey,
    });
    const now = again === null ? null : readStoredCatalog(toCatalogRow(again));
    if (now?.kind !== "partitioned" || now.head.identity !== head.identity) {
      return RETRY;
    }
    const tiling = await epochTiling(reader, head);
    return tiling === RETRY
      ? RETRY
      : tiling.rows.map(({ partition }) => partition);
  });
  if (live === RETRY) throw new ReleaseCatalogReadConflictError(scope.scopeKey);
  const changed = !sameLayout(live, rows);
  return {
    changed,
    currentCatalog: publicRowOf(head, live),
    diagnostics,
    projectedCatalog,
  };
};

// --- Cleanup (rules D and E) --------------------------------------------------------

const pageRows = (maxRowBytes: number) =>
  Math.min(
    PAGE_ROWS,
    Math.max(1, Math.floor(PAGE_BYTES / (maxRowBytes + 1024))),
  );

/** The live epoch and generation a scope row names. */
const scopeState = (row: Readonly<Record<string, unknown>> | null) => {
  if (row === null) return { generation: 0, liveEpoch: null };
  const catalog = toCatalogRow(row);
  const stored = readStoredCatalog(catalog);
  return {
    generation: catalog.generation,
    liveEpoch: stored.kind === "partitioned" ? stored.head.epoch : null,
  };
};

/** Rule D: neither live nor flippable, by the transaction's own reads. */
const deletable = (
  epoch: string,
  scope: { readonly generation: number; readonly liveEpoch: string | null },
  staging: StagingState | null,
) =>
  scope.liveEpoch !== epoch &&
  !(staging?.epoch === epoch && staging.base === scope.generation);

/**
 * One cleanup step for a scope: one discovery query (or the writer's own),
 * then at most one page of a deletable epoch's rows, or one marker, deleted
 * in one transaction that reads the scope's row and R and checks rules D and
 * E on them. A marker R names is kept, and its empty epoch is skipped so the
 * step moves on to the next marker in the same window. A page the store
 * can't take in one write halves. Answers false when the window holds
 * nothing to delete; true when it deleted, or found another writer had.
 */
export const cleanupStep = async (
  db: CoreDatabase,
  scopeKey: string,
  known?: {
    readonly discovery: Discovery;
    readonly generation: number;
    readonly liveEpoch: string | null;
  },
): Promise<boolean> => {
  const discovery = known?.discovery ?? (await readDiscovery(db, scopeKey));
  if (discovery.markers.length === 0) return false;
  const state =
    known ??
    scopeState(await db.findOne("release_catalogs", { scope_key: scopeKey }));
  for (const marker of discovery.markers) {
    if (!deletable(marker.epoch, state, discovery.staging)) continue;
    const { rows } = await db.findMany(PARTITIONS, {
      index: "byScope",
      where: { scope_key: scopeKey },
      range: { gte: [marker.epoch], lte: [marker.epoch] },
      limit: pageRows(marker.maxRowBytes),
    });
    if (rows.length === 0 && discovery.staging?.epoch === marker.epoch) {
      // Rule E keeps the marker R names: skip it, and look further.
      continue;
    }
    /** The step's transaction over `page`: rule D, then its deletes. */
    const commit = (page: typeof rows) =>
      db.transaction(async (tx) => {
        const scope = scopeState(
          await tx.findOne("release_catalogs", { scope_key: scopeKey }),
        );
        const stagingRow = await tx.findOne(PARTITIONS, stagingKey(scopeKey));
        const staging =
          stagingRow === null ? null : parseStaging(stagingRow.payload);
        // Rows or R moved since discovery: another writer progressed; look again.
        if (!deletable(marker.epoch, scope, staging)) return true;
        if (page.length > 0) {
          // The page's rows, read through the transaction in one batch.
          const current = await db.findByKeysIn(
            tx,
            PARTITIONS,
            page.map((row) => ({
              epoch: row.epoch,
              lower_key: row.lower_key,
              scope_key: scopeKey,
            })),
          );
          for (const row of current) {
            if (row !== null) await tx.delete(PARTITIONS, row);
          }
          return true;
        }
        // Rule E: R doesn't name it, and no row of it exists, read after S and R.
        if (staging?.epoch === marker.epoch) return true;
        const left = await db.unguardedSnapshot((reader) =>
          reader.findMany(PARTITIONS, {
            index: "byScope",
            where: { scope_key: scopeKey },
            range: { gte: [marker.epoch], lte: [marker.epoch] },
            limit: 1,
          }),
        );
        if (left.rows.length > 0) return true;
        const current = await tx.findOne(
          PARTITIONS,
          markerKey(scopeKey, marker.epoch),
        );
        if (current !== null) await tx.delete(PARTITIONS, current);
        return true;
      });
    // A page over the store's atomic limit halves; one row always fits.
    for (let size = rows.length; ; size = Math.ceil(size / 2)) {
      try {
        return await commit(rows.slice(0, size));
      } catch (error) {
        if (!isConstraint(error, "too_large") || size <= 1) throw error;
      }
    }
  }
  return false;
};

/** One cleanup step per scope a committed write left work for, reusing its discovery. */
const cleanUpAfter = async (
  db: CoreDatabase,
  written: ReadonlyMap<string, Written>,
) => {
  for (const done of written.values()) {
    await quietly(() =>
      cleanupStep(
        db,
        done.scopeKey,
        done.discovery === null
          ? undefined
          : {
              discovery: done.discovery,
              generation: done.generation,
              liveEpoch: done.liveEpoch,
            },
      ),
    );
  }
};

/** Runs cleanup steps until one deletes nothing, at most `maxSteps`. */
export const drainScope = async (
  db: CoreDatabase,
  scopeKey: string,
  maxSteps = 10_000,
): Promise<number> => {
  let steps = 0;
  while (steps < maxSteps && (await cleanupStep(db, scopeKey))) steps += 1;
  return steps;
};

/** Optional cleanup never fails the write that ran it. */
const quietly = async (work: () => Promise<unknown>) => {
  try {
    await work();
  } catch {
    // The next write's step, or a staging drain, reclaims what this left.
  }
};

// --- Staging ---------------------------------------------------------------------

/**
 * Registers a fresh epoch for `plan`: reads the scope's row and R in one
 * transaction, requires the row the tiling was computed from (ruling 2),
 * writes R naming the epoch at the plan's base, and inserts its marker. A
 * registration whose outcome is unknown is never retried with its epoch.
 */
const register = async (db: CoreDatabase, plan: StagedPlan) => {
  const scopeKey = plan.scope.scopeKey;
  const maxRowBytes = Math.max(0, ...plan.rows.map((row) => row.byteSize));
  for (let attempt = 0; ; attempt += 1) {
    const epoch = crypto.randomUUID();
    try {
      await db.transaction(async (tx) => {
        const row = await tx.findOne("release_catalogs", {
          scope_key: scopeKey,
        });
        const same =
          plan.baseVersion === null
            ? row === null
            : row !== null && row._v === plan.baseVersion;
        if (!same) throw new ComputationStale();
        const values = await controlRow(
          canonical({ base: plan.baseGeneration, epoch }),
          plan.baseGeneration,
        );
        const staging = await tx.findOne(PARTITIONS, stagingKey(scopeKey));
        if (staging === null) {
          tx.create(PARTITIONS, { ...stagingKey(scopeKey), ...values });
        } else {
          tx.update(PARTITIONS, staging, values);
        }
        tx.create(PARTITIONS, {
          ...markerKey(scopeKey, epoch),
          ...(await controlRow(
            canonical({ maxRowBytes }),
            plan.baseGeneration,
          )),
        });
      });
      plan.epoch = epoch;
      return;
    } catch (error) {
      // Unknown outcome: register again with a fresh epoch, which supersedes it.
      if (error instanceof DatabaseAmbiguousCommitError && attempt < 3)
        continue;
      throw error;
    }
  }
};

const isConstraint = (error: unknown, reason: string) =>
  error instanceof DatabaseConstraintError && error.reason === reason;

/** Whether every row of a chunk is stored as staged: a chunk that committed. */
const chunkLanded = async (
  db: CoreDatabase,
  plan: StagedPlan,
  rows: readonly ReleaseCatalogPartition[],
) => {
  const stored = await db.findByKeys(
    PARTITIONS,
    rows.map((row) => ({
      epoch: plan.epoch!,
      lower_key: row.lowerKey,
      scope_key: plan.scope.scopeKey,
    })),
  );
  return stored.every(
    (row, index) =>
      row !== null &&
      row.partition_hash === rows[index]!.partitionHash &&
      row.generation === plan.baseGeneration + 1,
  );
};

/** The writes of one chunk: its guards, then its rows stamped `base + 1`. */
const chunkWrites = async (
  tx: CoreTransaction,
  plan: StagedPlan,
  rows: readonly ReleaseCatalogPartition[],
  epoch: string,
  probe: boolean,
) => {
  const scopeKey = plan.scope.scopeKey;
  const staging = await tx.findOne(PARTITIONS, stagingKey(scopeKey));
  if (probe && staging === null) {
    tx.create(PARTITIONS, {
      ...stagingKey(scopeKey),
      ...(await controlRow(
        canonical({ base: plan.baseGeneration, epoch }),
        plan.baseGeneration,
      )),
    });
  } else if (
    !probe &&
    (staging === null || parseStaging(staging.payload).epoch !== epoch)
  ) {
    throw new StagingLost();
  }
  if (plan.baseGeneration > 0) {
    const row = await tx.findOne("release_catalogs", { scope_key: scopeKey });
    if (!probe && (row === null || row._v !== plan.baseVersion)) {
      throw new StagingLost();
    }
  }
  for (const row of rows) {
    tx.create(PARTITIONS, {
      byte_size: row.byteSize,
      epoch,
      generation: plan.baseGeneration + 1,
      lower_key: row.lowerKey,
      partition_hash: row.partitionHash,
      payload: row.payload,
      scope_key: scopeKey,
    });
  }
};

/**
 * Inserts the plan's rows under its epoch in chunks. Each chunk commits only
 * while R names the epoch and, above base 0, the scope's row is the base.
 * A chunk halves when it doesn't fit; one whose outcome is unknown is
 * checked by reading its rows back.
 */
const stageRows = async (db: CoreDatabase, plan: StagedPlan) => {
  const epoch = plan.epoch!;
  let size = plan.rows.length;
  let unknown = 0;
  for (let at = 0; at < plan.rows.length; ) {
    const rows = plan.rows.slice(at, at + size);
    try {
      await db.transaction((tx) => chunkWrites(tx, plan, rows, epoch, false));
    } catch (error) {
      if (isConstraint(error, "too_large")) {
        if (size === 1) throw error;
        size = Math.max(1, Math.floor(size / 2));
        continue;
      }
      if (
        error instanceof DatabaseAmbiguousCommitError ||
        isConstraint(error, "exists")
      ) {
        if (await chunkLanded(db, plan, rows)) {
          at += rows.length;
          continue;
        }
        if (error instanceof DatabaseAmbiguousCommitError && unknown < 3) {
          unknown += 1;
          continue;
        }
        throw error instanceof DatabaseAmbiguousCommitError
          ? error
          : new StagingLost();
      }
      throw error;
    }
    at += rows.length;
  }
};

/** Whether the plan's largest row fits one chunk on this adapter. */
const largestRowFits = (db: CoreDatabase, plan: StagedPlan) => {
  const largest = plan.rows.reduce((best, row) =>
    JSON.stringify(row.payload).length + row.lowerKey.length >
    JSON.stringify(best.payload).length + best.lowerKey.length
      ? row
      : best,
  );
  return db.fits((tx) =>
    chunkWrites(tx, plan, [largest], crypto.randomUUID(), true),
  );
};

// --- The driver -----------------------------------------------------------------

export interface CatalogWriteOptions {
  /** The wait before a staged publication restarts; 0.5–2 s, for liveness only. */
  readonly restartDelay?: () => Promise<void>;
}

const defaultRestartDelay = () =>
  new Promise<void>((resolve) =>
    setTimeout(resolve, 500 + Math.random() * 1500),
  );

/** Runs one attempt kind, rerunning when a head moved under its reads. */
const attempt = async <T>(run: () => Promise<T>): Promise<T> => {
  for (let rerun = 0; ; rerun += 1) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof CatalogWriteRace)) throw error;
      if (rerun + 1 >= RACE_RERUNS) {
        throw new ReleaseCatalogReadConflictError(error.scopeKey, {
          cause: error,
        });
      }
    }
  }
};

/**
 * Runs `operation`, a set of release changes over one transaction, and
 * publishes each scope it changes. A partitioned scope's change commits in
 * that one transaction when it fits. When it doesn't:
 * 1. the call computes every partitioned scope's whole tiling and compiles
 *    the final transaction, with stand-ins for R and the epochs, against
 *    the adapter's `fits`. When it doesn't fit, or one row alone doesn't,
 *    the write keeps today's compact behaviour;
 * 2. each scope registers a fresh epoch under the very row its tiling was
 *    computed from, drains what earlier attempts left, and stages its rows
 *    in guarded chunks;
 * 3. one transaction runs `operation` again and flips every head, each
 *    under its R and base.
 * A base that moved restarts the computation, at most 5 times, then fails
 * with the retryable `CATALOG_PUBLICATION_CONFLICT`. After a commit, one
 * cleanup step per partitioned scope runs, and never fails the call.
 */
export const writeReleaseCatalogs = async <T>(
  db: CoreDatabase,
  operation: (tx: CoreTransaction, writer: CatalogWriter) => Promise<T>,
  { restartDelay = defaultRestartDelay }: CatalogWriteOptions = {},
): Promise<T> => {
  for (let restart = 0; ; restart += 1) {
    if (restart > 0) await restartDelay();
    const atomic = createCatalogWriter(db, "atomic");
    try {
      const result = await attempt(() =>
        db.transaction((tx) => {
          atomic.written.clear();
          atomic.partitioned.clear();
          return operation(tx, atomic);
        }),
      );
      await cleanUpAfter(db, atomic.written);
      return result;
    } catch (error) {
      if (!isConstraint(error, "too_large") || atomic.partitioned.size === 0) {
        throw error;
      }
    }

    // Too big for one atomic write: plan, check the final fit, stage, flip.
    const planner = createCatalogWriter(db, "plan");
    const fits = await attempt(() =>
      db.fits((tx) => {
        planner.plans.clear();
        return operation(tx, planner);
      }),
    );
    const plans = [...planner.plans.values()];
    let staged = fits && plans.length > 0;
    for (const plan of plans) {
      if (!staged) break;
      staged = await largestRowFits(db, plan);
    }
    if (!staged) {
      // Today's single rows, with today's limits and refusals.
      const compact = createCatalogWriter(db, "compact");
      const result = await db.transaction((tx) => {
        compact.written.clear();
        return operation(tx, compact);
      });
      await cleanUpAfter(db, compact.written);
      return result;
    }

    try {
      for (const plan of plans) {
        await register(db, plan);
        // A few steps before staging; the rest after the flip, where it can't
        // spend a capped invocation's budget before the publication commits.
        await quietly(() =>
          drainScope(db, plan.scope.scopeKey, PRE_STAGING_STEPS),
        );
        await stageRows(db, plan);
      }
      const flipper = createCatalogWriter(db, "flip", planner.plans);
      let result: T | undefined;
      for (let resend = 0; ; resend += 1) {
        try {
          result = await db.transaction(async (tx) => {
            const value = await operation(tx, flipper);
            result = value;
            return value;
          });
          break;
        } catch (error) {
          // The probe compiled this flip; one that no longer fits, or whose
          // reads moved under it, read another state: compute again.
          if (
            isConstraint(error, "too_large") ||
            error instanceof CatalogWriteRace
          ) {
            throw new StagingLost();
          }
          if (!(error instanceof DatabaseAmbiguousCommitError) || resend >= 3) {
            throw error;
          }
          // The flip is the only commit point: it committed when every head names its epoch.
          const heads = await Promise.all(
            plans.map((plan) =>
              db.findOne("release_catalogs", {
                scope_key: plan.scope.scopeKey,
              }),
            ),
          );
          const flipped = heads.every((row, index) => {
            if (row === null) return false;
            const stored = readStoredCatalog(toCatalogRow(row));
            return (
              stored.kind === "partitioned" &&
              stored.head.epoch === plans[index]!.epoch
            );
          });
          if (flipped && result !== undefined) break;
        }
      }
      for (const plan of plans) {
        await quietly(() => drainScope(db, plan.scope.scopeKey));
      }
      return result as T;
    } catch (error) {
      if (
        !(error instanceof StagingLost || error instanceof ComputationStale)
      ) {
        throw error;
      }
      if (restart + 1 >= STAGING_RESTARTS) {
        throw new ReleaseCatalogMutationError(
          "CATALOG_PUBLICATION_CONFLICT",
          `Release catalog ${plans.map((plan) => plan.scope.scopeKey).join(", ")} changed on every staged publication; try again.`,
        );
      }
    }
  }
};

export { StagingLost, ComputationStale, CatalogWriteRace };
export type { PartitionRow };
