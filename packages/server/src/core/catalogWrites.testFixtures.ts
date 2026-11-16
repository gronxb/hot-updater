import {
  assembleReleaseCatalog,
  compileReleaseCatalog,
  compileReleaseCatalogTiling,
  createMemoryAdapter,
  type DatabaseAdapter,
  projectCompiledCatalog,
  projectCompiledRollbackCatalog,
  type ReleaseCatalogPartition,
  releaseRowToRelease,
  type SnapshotReader,
  type WriteOp,
  type WriteResult,
} from "@hot-updater/plugin-core";
import {
  assessCatalogAcceptance,
  authorizeReleaseTransition,
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  type PersistedSelectionReceipt,
  type Release,
  type ReleaseCatalog,
} from "@hot-updater/protocol";
import {
  cohortClasses,
  createReleaseCatalogPartitionFixture,
  decideReleaseCatalog,
  deviceStates,
  probeAppVersions,
  type ReleaseCatalogDeviceState,
} from "@hot-updater/test-utils";

import { createHotUpdaterHandlers } from "../handler";
import type { CoreApiOptions, ServerCoreApi } from "./api";
import { createInProcessCoreApi } from "./inProcess.testFixtures";

export const appVersionScope = (channel: string) =>
  createReleaseCatalogScopeKey({
    channelKey: encodeChannelKey(channel),
    platform: "ios",
    strategy: "APP_VERSION",
  });

/** A write about to be sent, which a hook may hold or fail. */
export interface PendingWrite {
  readonly ops: readonly WriteOp[];
  /** Tables the write touches. */
  readonly tables: ReadonlySet<string>;
}

export interface WriteHooks {
  /** Runs before a snapshot opens: a write here lands before the snapshot's state. */
  beforeSnapshot?: () => Promise<void> | void;
  /** Runs before each write reaches the store; it may await, throw, or write itself. */
  beforeWrite?: (write: PendingWrite) => Promise<void> | void;
  /**
   * Runs after a write reached the store. Throwing makes its outcome
   * unknown to the engine: an ambiguous commit, whether it committed or not.
   */
  afterWrite?: (
    write: PendingWrite,
    result: WriteResult,
  ) => Promise<void> | void;
}

/**
 * The memory adapter with an op limit standing in for a store's atomic
 * limit, and hooks around each write, so a spec forces staging and lands
 * other writers' commits at exact points of a publication.
 */
export const createWriteTestAdapter = ({
  maxOps = Number.POSITIVE_INFINITY,
  memory = createMemoryAdapter(),
  snapshots = false,
}: {
  readonly maxOps?: number;
  readonly memory?: DatabaseAdapter;
  /** Gives the adapter a `readSnapshot` over the store, as MongoDB's: core then reads heads again inside it. */
  readonly snapshots?: boolean;
} = {}) => {
  const hooks: WriteHooks = {};
  const writes: PendingWrite[] = [];
  let limit = maxOps;
  let snapshotsOpened = 0;
  const adapter: DatabaseAdapter = Object.assign(
    Object.create(memory) as DatabaseAdapter,
    snapshots
      ? {
          async readSnapshot<T>(read: (reader: SnapshotReader) => Promise<T>) {
            await hooks.beforeSnapshot?.();
            snapshotsOpened += 1;
            return read({
              get: (table, keys) => memory.get(table, keys),
              query: (table, request) => memory.query(table, request),
            });
          },
        }
      : {},
    {
      fits: (ops: readonly WriteOp[]) =>
        ops.length <= limit && memory.fits(ops),
      async write(ops: readonly WriteOp[]) {
        const pending: PendingWrite = {
          ops,
          tables: new Set(ops.map((op) => op.table.name)),
        };
        writes.push(pending);
        await hooks.beforeWrite?.(pending);
        const result = await memory.write(ops);
        await hooks.afterWrite?.(pending, result);
        return result;
      },
    },
  );
  return {
    adapter,
    hooks,
    memory,
    writes,
    snapshotsOpened: () => snapshotsOpened,
    setMaxOps: (next: number) => {
      limit = next;
    },
  };
};

export const createWriteTestCore = (
  adapter: DatabaseAdapter,
  options: CoreApiOptions = {},
): ServerCoreApi =>
  createInProcessCoreApi(adapter, {
    catalogWrites: { restartDelay: async () => {} },
    ...options,
  });

export const releasePolicy = (
  channel: string,
  targetAppVersion: string,
  extra: {
    readonly enabled?: boolean;
    readonly rolloutCohortCount?: number;
    readonly targetCohorts?: string[];
    readonly message?: string | null;
  } = {},
) => ({
  channel,
  enabled: extra.enabled ?? true,
  fingerprintHash: null,
  message: extra.message ?? null,
  shouldForceUpdate: false,
  targetAppVersion,
  ...(extra.rolloutCohortCount === undefined
    ? {}
    : { rolloutCohortCount: extra.rolloutCohortCount }),
  ...(extra.targetCohorts === undefined
    ? {}
    : { targetCohorts: extra.targetCohorts }),
});

/** Every release row of a scope, enabled or not. */
export const releasesIn = async (core: ServerCoreApi, scopeKey: string) =>
  (
    await core.listReleases({
      filter: { kind: "scope", scopeKey },
      limit: 500,
    })
  ).map(releaseRowToRelease);

/** The full compact catalog of `releases`' enabled ones, with no size cap: what a compact row would hold. */
export const fullCatalogOf = async (releases: readonly Release[]) => {
  const enabled = releases.filter((release) => release.enabled);
  const tiling = await compileReleaseCatalogTiling({ releases: enabled });
  if (tiling === null) {
    // Keys that don't fit: the scope is compact, as today.
    const compiled = await compileReleaseCatalog({
      releases: enabled,
      strategy: "APP_VERSION",
    });
    return {
      assembly: {
        byteSize: compiled.byteSize,
        canonicalPayload: compiled.canonicalPayload,
        payload: JSON.parse(
          compiled.canonicalPayload,
        ) as typeof compiled.payload,
      },
      tiling: null,
    };
  }
  return { assembly: assembleReleaseCatalog(tiling), tiling };
};

/**
 * What a scope stores: its row, its partition rows by epoch, and checks of
 * the invariants every committed state keeps:
 * - every partition row has its epoch's marker;
 * - a head's live epoch tiles the line with rows stamped at or below it;
 * - R never makes the live epoch flippable.
 */
export const storedScope = async (
  memory: DatabaseAdapter,
  scopeKey: string,
) => {
  const fixture = createReleaseCatalogPartitionFixture(memory);
  const all = await fixture.rows(scopeKey);
  const row = await fixture.readRow(scopeKey).catch(() => null);
  const parsed =
    row === null ? null : (JSON.parse(row.payload) as Record<string, unknown>);
  const liveEpoch =
    parsed !== null && "layout" in parsed ? String(parsed.epoch) : null;
  const markers = new Set(
    all.filter((r) => r.epoch === "#").map((r) => r.lowerKey),
  );
  const staging = all.find((r) => r.epoch === "!");
  const partitions = all.filter((r) => r.epoch !== "#" && r.epoch !== "!");
  const problems: string[] = [];
  for (const partition of partitions) {
    if (!markers.has(partition.epoch)) {
      problems.push(
        `row ${partition.epoch}/${partition.lowerKey} has no marker`,
      );
    }
  }
  const live = partitions.filter((r) => r.epoch === liveEpoch);
  if (liveEpoch !== null) {
    if (!markers.has(liveEpoch)) problems.push("the live epoch has no marker");
    for (const partition of live) {
      if (partition.generation > row!.generation) {
        problems.push(`live row ${partition.lowerKey} is newer than its head`);
      }
    }
    try {
      assembleReleaseCatalog(live.map((r) => r.partition));
    } catch {
      problems.push("the live epoch doesn't tile the line");
    }
    // A live epoch never flips again: R may still name it, never at its base.
    const state =
      staging === undefined
        ? null
        : (JSON.parse(staging.partition.payload) as {
            base: number;
            epoch: string | null;
          });
    if (state?.epoch === liveEpoch && state.base === row!.generation) {
      problems.push("R can flip the live epoch");
    }
  }
  return {
    epochs: new Set(partitions.map((r) => r.epoch)),
    live: live.map((r) => r.partition) as ReleaseCatalogPartition[],
    liveEpoch,
    markers,
    problems,
    row,
    staging:
      staging === undefined
        ? null
        : (JSON.parse(staging.partition.payload) as {
            base: number;
            epoch: string | null;
          }),
    total: all.length,
  };
};

const check = async (
  core: ServerCoreApi,
  channel: string,
  appVersion: string,
) => {
  // A fresh server process each time: no memo outlives a write.
  const { client } = createHotUpdaterHandlers({ api: { core } });
  const response = await client(
    new Request(
      `http://localhost/release-catalogs/app-version/ios/${encodeChannelKey(channel)}/${appVersion}`,
    ),
  );
  return { body: await response.text(), status: response.status };
};

/** A device's persisted state across checks, as the SDK keeps it. */
interface DeviceMemory {
  highWater: { generation: number; catalogHash: string } | null;
  active: PersistedSelectionReceipt | null;
}

/**
 * The differential oracle over one scope's write sequence. After each write
 * it checks every probed app version through the real update check against
 * the full compact catalog of the scope's enabled releases, both selectors'
 * decisions for sampled devices, and the persisted receipt transitions of
 * each device in two streams: the served one (head generation and chain
 * hash) and today's twin (the same generations with content hashes). The
 * verdicts must be equal at every step. Returns the mismatches.
 */
export const createScopeOracle = (channel: string) => {
  const scopeKey = appVersionScope(channel);
  const served = new Map<string, DeviceMemory>();
  const twin = new Map<string, DeviceMemory>();
  let checks = 0;
  let decisions = 0;

  const verdict = (
    memory: Map<string, DeviceMemory>,
    key: string,
    catalog: ReleaseCatalog,
    device: ReleaseCatalogDeviceState,
  ) => {
    const state = memory.get(key) ?? { active: null, highWater: null };
    memory.set(key, state);
    const acceptance = assessCatalogAcceptance(
      { catalogHash: catalog.catalogHash, generation: catalog.generation },
      state.highWater,
    );
    const decided = JSON.parse(decideReleaseCatalog(catalog, device)) as {
      current: {
        kind: string;
        releaseId: string | null;
        bundleId: string;
      } | null;
    };
    if (!acceptance.accepted || decided.current === null) {
      return JSON.stringify([acceptance, decided]);
    }
    if (acceptance.shouldAdvanceHighWater) {
      state.highWater = {
        catalogHash: catalog.catalogHash,
        generation: catalog.generation,
      };
    }
    const desired: PersistedSelectionReceipt = {
      bundleId: decided.current.bundleId,
      catalogHash: catalog.catalogHash,
      catalogId: catalog.catalogId,
      channel,
      generation: catalog.generation,
      kind: decided.current.kind as PersistedSelectionReceipt["kind"],
      releaseId: decided.current.releaseId,
      scopeKey: catalog.scopeKey,
      selectionContextHash: "context",
    };
    const authorization = authorizeReleaseTransition({
      active: state.active,
      desired,
      explicitScopeSwitch: false,
    });
    // The SDK's `sameReceipt`: every field equal, hashes included.
    const same = JSON.stringify(state.active) === JSON.stringify(desired);
    if (authorization.authorized) state.active = desired;
    return JSON.stringify([acceptance, decided, authorization, same]);
  };

  return {
    scopeKey,
    counts: () => ({ checks, decisions }),
    /** Checks the scope after one write; `history` is every release it ever had. */
    async step(core: ServerCoreApi, history: readonly Release[]) {
      const mismatches: string[] = [];
      const releases = await releasesIn(core, scopeKey);
      const stored = await core.getReleaseCatalogRow(scopeKey);
      if (stored === null) {
        if (releases.length > 0) mismatches.push("catalog row missing");
        return mismatches;
      }
      const { assembly } = await fullCatalogOf(releases);
      if (stored.payload !== assembly.canonicalPayload) {
        mismatches.push("public row differs from the full compile");
      }
      const contentHash = (await (
        await import("node:crypto")
      ).subtle.digest(
        "SHA-256",
        new TextEncoder().encode(assembly.canonicalPayload),
      )) as ArrayBuffer;
      const twinHash = `sha256:${Buffer.from(contentHash).toString("hex")}`;
      const versions = probeAppVersions(
        assembly.payload,
        history.flatMap(({ targetAppVersion }) =>
          targetAppVersion === null ? [] : [targetAppVersion],
        ),
      );
      const devices = deviceStates({
        builtInBundleId: "00000000-0000-0000-0000-000000000000",
        cohorts: cohortClasses(
          history.map((release) => ({
            releaseId: release.id,
            rolloutCohortCount: release.rolloutCohortCount,
            targetCohorts: release.targetCohorts,
          })),
        ),
        exhaustive: false,
        history,
        limit: 24,
        seed: 11,
      });
      for (const version of versions) {
        checks += 1;
        const { status, body } = await check(core, channel, version);
        if (status !== 200) {
          mismatches.push(`check ${version}: ${status}`);
          continue;
        }
        const answered = JSON.parse(body) as ReleaseCatalog;
        const expected: ReleaseCatalog = {
          ...answered,
          catalogHash: twinHash,
          releases: projectCompiledCatalog(assembly.payload, version),
          rollbackReleases: projectCompiledRollbackCatalog(
            assembly.payload,
            version,
          ),
        };
        if (
          JSON.stringify([answered.releases, answered.rollbackReleases]) !==
          JSON.stringify([expected.releases, expected.rollbackReleases])
        ) {
          mismatches.push(`answer ${version}`);
        }
        if (
          answered.generation !== stored.generation ||
          answered.catalogId !== stored.catalog_id ||
          answered.catalogHash !== stored.catalog_hash
        ) {
          mismatches.push(`identity ${version}`);
        }
        for (const [index, device] of devices.entries()) {
          decisions += 1;
          const key = `${version}#${index}`;
          if (
            verdict(served, key, answered, device) !==
            verdict(twin, key, expected, device)
          ) {
            mismatches.push(`receipt ${version} ${JSON.stringify(device)}`);
          }
        }
      }
      return mismatches;
    },
  };
};
