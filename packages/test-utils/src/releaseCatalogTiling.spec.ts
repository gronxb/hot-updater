import {
  type CompiledReleaseCatalog,
  createMemoryAdapter,
  type HotUpdaterCoreApi,
  projectCompiledCatalog,
  projectCompiledRollbackCatalog,
  type ReleaseCatalogPartition,
  releaseRowToRelease,
} from "@hot-updater/plugin-core";
import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  type Release,
  type ReleaseCatalog,
  type ReleaseCatalogDescriptor,
  selectDesiredRelease,
} from "@hot-updater/protocol";
import { describe, expect, it } from "vitest";

import { createMeasuredDatabase } from "./createMeasuredDatabase";
import { createBundleFixture } from "./databaseTestFixtures";
import {
  checkReleaseCatalogTiling,
  createReleaseCatalogOracleCounters,
  oracleLayers,
  type ReleaseCatalogOracleCounters,
  type ReleaseCatalogOracleLayer,
  type ReleaseCatalogTilingKit,
  releaseCatalogTilingKit,
  replaceRows,
  rowsForInsert,
} from "./releaseCatalogTilingOracle";
import { selectDesiredReleaseV100 } from "./releaseSelectionV100";

// The differential oracle of the release catalog tiling kit: write
// sequences run through today's core on the memory adapter, and after every
// write the persisted single-row catalog is the reference. The tiling is
// kept up the way partitioned writes will keep it (inserts touch only the
// rows they cover, other writes recompile) and stored between steps as rows.

type Strategy = "APP_VERSION" | "FINGERPRINT";
const channel = "production";
const scopeKeyOf = (strategy: Strategy) =>
  createReleaseCatalogScopeKey(
    strategy === "APP_VERSION"
      ? { channelKey: encodeChannelKey(channel), platform: "ios", strategy }
      : {
          channelKey: encodeChannelKey(channel),
          fingerprintHash: "fingerprint-a",
          platform: "ios",
          strategy,
        },
  );
const BUILT_IN = createBundleFixture("0").id;

/** Plain rows, as a database hands them back. */
const persisted = (
  rows: readonly ReleaseCatalogPartition[] | null,
): readonly ReleaseCatalogPartition[] | null =>
  rows === null ? null : (JSON.parse(JSON.stringify(rows)) as never);

interface SequenceCounters {
  inserts: number;
  dips: number;
  promotes: number;
  edits: number;
  disables: number;
  enables: number;
  deletes: number;
  rebuilds: number;
  exclusiveEndpointInserts: number;
  unionInserts: number;
  prereleaseInserts: number;
  openInserts: number;
  cutInserts: number;
}

/** A scope written through today's core, with the kit's tiling beside it. */
const createSequence = async (options: {
  readonly kit: ReleaseCatalogTilingKit;
  readonly strategy?: Strategy;
}) => {
  const strategy = options.strategy ?? "APP_VERSION";
  const scopeKey = scopeKeyOf(strategy);
  const { core } = await createMeasuredDatabase(createMemoryAdapter(), []);
  const { kit } = options;
  const history = new Map<string, Release>();
  let tiling: readonly ReleaseCatalogPartition[] | null =
    strategy === "APP_VERSION"
      ? persisted(await kit.compileReleaseCatalogTiling({ releases: [] }))
      : null;
  let bundleSequence = 0;
  const errors: string[] = [];
  const bundles: string[] = [];
  const counters: SequenceCounters = {
    cutInserts: 0,
    deletes: 0,
    dips: 0,
    promotes: 0,
    disables: 0,
    edits: 0,
    enables: 0,
    exclusiveEndpointInserts: 0,
    inserts: 0,
    openInserts: 0,
    prereleaseInserts: 0,
    rebuilds: 0,
    unionInserts: 0,
  };

  const releases = async (): Promise<Release[]> => {
    const rows = await Promise.all(
      [...history.keys()].map((id) => core.getRelease(id)),
    );
    const live: Release[] = [];
    for (const row of rows) {
      if (row === null) continue;
      const release = releaseRowToRelease(row);
      history.set(release.id, release);
      live.push(release);
    }
    return live;
  };

  const recompile = async () => {
    if (strategy !== "APP_VERSION") return;
    tiling = persisted(
      await kit.compileReleaseCatalogTiling({ releases: await releases() }),
    );
  };

  const insert = async (release: Release) => {
    history.set(release.id, release);
    counters.inserts += 1;
    if (strategy !== "APP_VERSION" || tiling === null) return;
    const range = release.targetAppVersion!;
    const keys = kit.releaseCatalogKeyRanges(range) ?? [];
    if (keys.length > 1) counters.unionInserts += 1;
    if (
      keys.some(
        ({ start, stop }) =>
          start.endsWith(">") || stop?.endsWith("=") === true,
      )
    ) {
      counters.exclusiveEndpointInserts += 1;
    }
    if (keys.some(({ start, stop }) => start === "-" || stop === null)) {
      counters.openInserts += 1;
    }
    if (/-[a-z]/.test(range)) counters.prereleaseInserts += 1;
    const read = rowsForInsert(kit, tiling, range);
    if (read === null) {
      tiling = null;
      return;
    }
    let written: readonly ReleaseCatalogPartition[] | null;
    try {
      written = await kit.insertReleaseIntoTiling({
        partitions: read,
        release,
      });
    } catch (error) {
      // The next check reports the lost tiling as an incremental mismatch.
      errors.push(String(error));
      tiling = null;
      return;
    }
    if (written === null) {
      tiling = null;
      return;
    }
    if (written.length > read.length) counters.cutInserts += 1;
    tiling = persisted(replaceRows(tiling, read, written));
  };

  const policy = (input: {
    readonly channel?: string;
    readonly range?: string;
    readonly enabled?: boolean;
    readonly rollout?: number;
    readonly cohorts?: readonly string[];
    readonly force?: boolean;
    readonly message?: string | null;
  }) => ({
    channel: input.channel ?? channel,
    enabled: input.enabled ?? true,
    fingerprintHash: strategy === "FINGERPRINT" ? "fingerprint-a" : null,
    message: input.message ?? null,
    rolloutCohortCount: input.rollout ?? 1000,
    shouldForceUpdate: input.force ?? false,
    targetAppVersion:
      strategy === "APP_VERSION" ? (input.range ?? "1.0.0") : null,
    targetCohorts: [...(input.cohorts ?? [])],
  });

  return {
    core: core as HotUpdaterCoreApi,
    counters,
    /** Errors the kit's inserts threw, each failing the step it ran in. */
    errors,
    history,
    bundles,
    scopeKey,
    get tiling() {
      return tiling;
    },
    releases,
    /** Deploys a new bundle, which sorts after every earlier one. */
    async deploy(input: Parameters<typeof policy>[0] = {}) {
      bundleSequence += 1;
      const bundle = createBundleFixture(String(bundleSequence));
      bundles.push(bundle.id);
      const [result] = await core.deploy([{ bundle, release: policy(input) }]);
      const release = releaseRowToRelease(result!.release!);
      await insert(release);
      return release;
    },
    /** Deploys a stored bundle again: a dip when a newer one is enabled. */
    async redeploy(bundleId: string, input: Parameters<typeof policy>[0] = {}) {
      const dip = (await releases()).some(
        (release) => release.enabled && release.bundleId! > bundleId,
      );
      const [result] = await core.deploy([
        { bundleId, release: policy(input) },
      ]);
      const release = releaseRowToRelease(result!.release!);
      if (dip) counters.dips += 1;
      await insert(release);
      return release;
    },
    /** Deploys a new bundle to staging and promotes a copy into this scope. */
    async promote(input: Parameters<typeof policy>[0] = {}) {
      await core.ensureChannel("staging");
      bundleSequence += 1;
      const bundle = createBundleFixture(String(bundleSequence));
      bundles.push(bundle.id);
      const [staged] = await core.deploy([
        { bundle, release: policy({ ...input, channel: "staging" }) },
      ]);
      const { target } = await core.promoteRelease({
        releaseId: staged!.release!.id,
        targetChannel: channel,
      });
      expect(target.release!.scope_key).toBe(scopeKey);
      const release = releaseRowToRelease(target.release!);
      counters.promotes += 1;
      await insert(release);
      return release;
    },
    async edit(
      releaseId: string,
      patch: Parameters<HotUpdaterCoreApi["updateReleasePolicy"]>[0]["patch"],
    ) {
      await core.updateReleasePolicy({ patch, releaseId });
      if (patch.enabled === false) counters.disables += 1;
      else if (patch.enabled === true) counters.enables += 1;
      else counters.edits += 1;
      await recompile();
    },
    async remove(releaseId: string) {
      const row = await core.getRelease(releaseId);
      if (row?.enabled) {
        await core.updateReleasePolicy({
          patch: { enabled: false },
          releaseId,
        });
      }
      await core.deleteRelease({ releaseId });
      counters.deletes += 1;
      await recompile();
    },
    async rebuild() {
      await core.rebuildReleaseCatalog(scopeKey);
      counters.rebuilds += 1;
      await recompile();
    },
    async stored(): Promise<string> {
      const row = await core.getReleaseCatalogRow(scopeKey);
      return row!.payload;
    },
    async storedHash(): Promise<string> {
      const row = await core.getReleaseCatalogRow(scopeKey);
      return row!.catalog_hash;
    },
  };
};

type Sequence = Awaited<ReturnType<typeof createSequence>>;

const check = async (
  sequence: Sequence,
  kit: ReleaseCatalogTilingKit,
  counters: ReleaseCatalogOracleCounters,
  options: {
    readonly seed: number;
    readonly exhaustive?: boolean;
    readonly limit?: number;
  },
) =>
  checkReleaseCatalogTiling({
    builtInBundleId: BUILT_IN,
    counters,
    exhaustive: options.exhaustive ?? false,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    history: [...sequence.history.values()],
    kit,
    releases: await sequence.releases(),
    seed: options.seed,
    stored: await sequence.stored(),
    storedHash: await sequence.storedHash(),
    tiling: sequence.tiling,
  });

// --- Generated write sequences --------------------------------------------

const createRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

/** Exact versions, x-ranges, carets, tildes, one- and two-sided, unions, prereleases, open ends and ranges matching nothing. */
const rangeOf = (random: () => number, versions: number): string => {
  const a = Math.floor(random() * versions);
  const b = Math.min(versions, a + 1 + Math.floor(random() * 3));
  const ranges = [
    `1.${a}.0`,
    `1.${a}.0`,
    `1.${a}.0`,
    `1.${a}.x`,
    `^1.${a}.0`,
    `~1.${a}.0`,
    `>=1.${a}.0`,
    `>1.${a}.0`,
    `<1.${b}.0`,
    `<=1.${a}.0`,
    `>=1.${a}.0 <1.${b}.0`,
    `>1.${a}.0 <=1.${b}.0`,
    `1.${a}.0 - 1.${b}.0`,
    `1.${a}.0 || 1.${b}.0`,
    `<1.${a}.0 || >=1.${b}.0`,
    `>=1.${a}.0-beta.1 <1.${b}.0`,
    `>=1.${a}.0-rc.2 <=1.${a}.0`,
    "*",
    `2.${a}.0`,
    `>=3.0.0 <2.0.0`,
  ];
  return ranges[Math.floor(random() * ranges.length)]!;
};

const runSequence = async (input: {
  readonly kit: ReleaseCatalogTilingKit;
  readonly seed: number;
  readonly steps: number;
  readonly versions: number;
  readonly counters: ReleaseCatalogOracleCounters;
}) => {
  const random = createRandom(input.seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)]!;
  const sequence = await createSequence({ kit: input.kit });
  const failures: {
    step: number;
    op: string;
    layers: string[];
    detail: string;
  }[] = [];
  const rollout = () => pick([0, 1, 10, 500, 1000, 1000, 1000, 1000]);
  const cohorts = () =>
    random() < 0.8 ? [] : pick([["qa"], ["5", "vip"], ["beta"]]);
  for (let step = 0; step < input.steps; step += 1) {
    const current = await sequence.releases();
    const live = current.map(({ id, enabled }) => ({ enabled, id }));
    // A bundle whose last release was deleted is gone with it.
    const stored = [...new Set(current.map(({ bundleId }) => bundleId!))];
    const roll = random();
    let op: string;
    if (step === 0 || live.length === 0 || roll < 0.45) {
      op = "deploy";
      await sequence.deploy({
        cohorts: cohorts(),
        enabled: random() > 0.05,
        force: random() < 0.2,
        range: rangeOf(random, input.versions),
        rollout: rollout(),
      });
    } else if (roll < 0.5) {
      op = "promote";
      await sequence.promote({
        range: rangeOf(random, input.versions),
        rollout: rollout(),
      });
    } else if (roll < 0.58) {
      op = "dip";
      await sequence.redeploy(pick(stored), {
        range: rangeOf(random, input.versions),
        rollout: rollout(),
      });
    } else if (roll < 0.75) {
      const target = pick(live).id;
      const patch = pick([
        { rolloutCohortCount: rollout() },
        { targetCohorts: cohorts() },
        { shouldForceUpdate: random() < 0.5 },
        { message: `message ${step}` },
        { targetAppVersion: rangeOf(random, input.versions) },
      ]);
      op = `edit ${Object.keys(patch)[0]}`;
      await sequence.edit(target, patch);
    } else if (roll < 0.85) {
      const target = pick(live);
      op = target.enabled ? "disable" : "enable";
      await sequence.edit(target.id, { enabled: !target.enabled });
    } else if (roll < 0.95) {
      op = "delete";
      await sequence.remove(pick(live).id);
    } else {
      op = "rebuild";
      await sequence.rebuild();
    }
    const mismatches = await check(sequence, input.kit, input.counters, {
      // The last step draws ten times as many device states.
      limit: step === input.steps - 1 ? 2000 : 200,
      seed: input.seed * 1000 + step,
    });
    const thrown = sequence.errors.splice(0);
    if (mismatches.length > 0 || thrown.length > 0) {
      failures.push({
        detail: thrown[0] ?? mismatches[0]!.detail,
        layers: [
          ...new Set([
            ...oracleLayers(mismatches),
            ...(thrown.length > 0 ? ["incremental"] : []),
          ]),
        ].sort(),
        op,
        step,
      });
    }
  }
  return { failures, sequence };
};

// --- The 15-release counterexample -----------------------------------------

/**
 * The v1 bounded-catalog review's P1 (catalog-bound/review-design.md):
 * R1…R15 on one app version with increasing bundles B1…B15, all at
 * rollout 0, R3 disabled or deleted. A device on R3/B3 in cohort 5, with
 * the built-in and floor B0, rolls back to R2/B2 under the full catalog.
 * The APP_VERSION scope also holds releases for 2.0.0 with large messages,
 * so the tiling has several rows and gaps.
 */
const counterexample = async (input: {
  readonly kit: ReleaseCatalogTilingKit;
  readonly strategy: Strategy;
  readonly r3: "disabled" | "deleted";
}) => {
  const sequence = await createSequence(input);
  const r: Release[] = [];
  for (let index = 1; index <= 15; index += 1) {
    r.push(await sequence.deploy({ range: "1.0.0" }));
  }
  if (input.strategy === "APP_VERSION") {
    for (let index = 0; index < 3; index += 1) {
      await sequence.deploy({
        message: "m".repeat(20_000),
        range: "2.0.0",
      });
    }
  }
  for (const release of r) {
    await sequence.edit(release.id, { rolloutCohortCount: 0 });
  }
  if (input.r3 === "disabled") {
    await sequence.edit(r[2]!.id, { enabled: false });
  } else {
    await sequence.remove(r[2]!.id);
  }
  return { r, sequence };
};

const decisionsAt = (
  catalog: ReleaseCatalog,
  device: Parameters<typeof selectDesiredRelease>[1],
) => ({
  current: selectDesiredRelease(catalog, device),
  v100: selectDesiredReleaseV100(catalog, device),
});

const catalogFromLists = (
  releases: readonly ReleaseCatalogDescriptor[],
  rollbackReleases: readonly ReleaseCatalogDescriptor[],
): ReleaseCatalog => ({
  catalogHash: `sha256:${"0".repeat(64)}`,
  catalogId: "catalog",
  fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
  generation: 1,
  releases,
  rollbackReleases,
  schemaVersion: 1,
  scopeKey: "scope",
});

// --- Deliberately broken kits, each a bug the oracle must catch -------------

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
};

type OneSegment = Extract<CompiledReleaseCatalog, { strategy: "APP_VERSION" }>;

const rewrite = async (
  row: ReleaseCatalogPartition,
  change: (catalog: OneSegment) => OneSegment,
): Promise<ReleaseCatalogPartition> => {
  const payload = canonical(change(JSON.parse(row.payload) as OneSegment));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return {
    byteSize: new TextEncoder().encode(payload).byteLength,
    lowerKey: row.lowerKey,
    partitionHash: `sha256:${[...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`,
    payload,
  };
};

const releaseIdsOf = (row: ReleaseCatalogPartition, frontier: boolean) => {
  const catalog = JSON.parse(row.payload) as OneSegment;
  const segment = catalog.segments[0]!;
  return (
    frontier ? segment.releaseIndexes : segment.rollbackReleaseIndexes
  ).map((index) => catalog.releaseDescriptors[index]!.releaseId);
};

/** Two neighbouring rows as one: the left one's lists over both spans. */
const mergeRows = (
  left: ReleaseCatalogPartition,
  right: ReleaseCatalogPartition,
) =>
  rewrite(left, (catalog) => ({
    ...catalog,
    segments: [
      {
        ...catalog.segments[0]!,
        upper: (JSON.parse(right.payload) as OneSegment).segments[0]!.upper,
      },
    ],
  }));

const mapRows = async (
  rows: readonly ReleaseCatalogPartition[] | null,
  change: (row: ReleaseCatalogPartition) => Promise<ReleaseCatalogPartition>,
) => (rows === null ? null : Promise.all(rows.map(change)));

/** v1's bounded catalog: each row keeps only its 11 newest rollback descriptors. */
const boundRollback = (row: ReleaseCatalogPartition) =>
  rewrite(row, (catalog) => {
    const keep = catalog.releaseDescriptors.slice(0, 11);
    const segment = catalog.segments[0]!;
    return {
      ...catalog,
      releaseDescriptors: keep,
      segments: [
        {
          ...segment,
          releaseIndexes: segment.releaseIndexes.filter((index) => index < 11),
          rollbackReleaseIndexes: keep.map((_, index) => index),
        },
      ],
    };
  });

/** Whether `right` starts where `left` ends. */
const meets = (
  left: ReleaseCatalogPartition,
  right: ReleaseCatalogPartition,
) => {
  const upper = (JSON.parse(left.payload) as OneSegment).segments[0]!.upper;
  const lower = (JSON.parse(right.payload) as OneSegment).segments[0]!.lower;
  return (
    upper !== null &&
    lower !== null &&
    upper.version === lower.version &&
    upper.inclusive !== lower.inclusive
  );
};

/** Merges neighbouring rows that meet, where `shouldMerge` says so. */
const mergeAdjacent = async (
  rows: readonly ReleaseCatalogPartition[],
  shouldMerge: (
    left: ReleaseCatalogPartition,
    right: ReleaseCatalogPartition,
  ) => boolean,
) => {
  const result: ReleaseCatalogPartition[] = [];
  for (const row of rows) {
    const previous = result.at(-1);
    if (
      previous !== undefined &&
      meets(previous, row) &&
      shouldMerge(previous, row)
    ) {
      result[result.length - 1] = await mergeRows(previous, row);
    } else {
      result.push(row);
    }
  }
  return result;
};

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  left.every((id, index) => id === right[index]);

const kit = releaseCatalogTilingKit;
const ablations: Record<
  string,
  {
    readonly kit: ReleaseCatalogTilingKit;
    readonly layers: readonly ReleaseCatalogOracleLayer[];
  }
> = {
  "a dropped rollback descriptor (v1's 11-descriptor bound)": {
    kit: {
      ...kit,
      compileReleaseCatalogTiling: async (input) =>
        mapRows(await kit.compileReleaseCatalogTiling(input), boundRollback),
      insertReleaseIntoTiling: async (input) =>
        mapRows(await kit.insertReleaseIntoTiling(input), boundRollback),
      tileCompiledReleaseCatalog: async (input) =>
        mapRows(await kit.tileCompiledReleaseCatalog(input), boundRollback),
    },
    layers: ["answers", "assembly", "decisions", "hashes"],
  },
  "no cut at an exclusive upper endpoint on insert": {
    kit: {
      ...kit,
      insertReleaseIntoTiling: async (input) => {
        const written = await kit.insertReleaseIntoTiling(input);
        if (written === null) return null;
        const id = input.release.id;
        return mergeAdjacent(
          written,
          (left, right) =>
            !input.partitions.includes(right) &&
            releaseIdsOf(left, false).includes(id) &&
            !releaseIdsOf(right, false).includes(id) &&
            (JSON.parse(left.payload) as OneSegment).segments[0]!.upper
              ?.inclusive === false,
        );
      },
    },
    layers: ["answers", "assembly", "decisions", "hashes", "incremental"],
  },
  "a merge on insert of rows with equal frontiers": {
    kit: {
      ...kit,
      insertReleaseIntoTiling: async (input) => {
        const written = await kit.insertReleaseIntoTiling(input);
        if (written === null) return null;
        return mergeAdjacent(written, (left, right) => {
          const frontier = releaseIdsOf(left, true);
          return (
            frontier.length > 0 && sameIds(frontier, releaseIdsOf(right, true))
          );
        });
      },
    },
    layers: ["answers", "assembly", "decisions", "hashes", "incremental"],
  },
  "a frontier not computed again on insert": {
    kit: {
      ...kit,
      insertReleaseIntoTiling: async (input) => {
        const written = await kit.insertReleaseIntoTiling(input);
        if (written === null) return null;
        const id = input.release.id;
        const before = new Map(
          input.partitions.map((row) => [row.lowerKey, row]),
        );
        return Promise.all(
          written.map((row) =>
            rewrite(row, (catalog) => {
              const ids = releaseIdsOf(row, false);
              if (!ids.includes(id)) return catalog;
              // The new release on top of the frontier of the row it came from.
              const source = [...before.values()]
                .filter((old) => old.lowerKey <= row.lowerKey)
                .at(-1);
              const old =
                source === undefined ? [] : releaseIdsOf(source, true);
              const frontier = new Set([id, ...old]);
              return {
                ...catalog,
                segments: [
                  {
                    ...catalog.segments[0]!,
                    releaseIndexes: catalog.releaseDescriptors.flatMap(
                      (descriptor, index) =>
                        frontier.has(descriptor.releaseId) ? [index] : [],
                    ),
                  },
                ],
              };
            }),
          ),
        );
      },
    },
    // Frontiers keep only releases some device can select, so a longer
    // frontier changes the lists but no decision.
    layers: ["answers", "assembly", "hashes", "incremental"],
  },
  "a stale partition hash on insert": {
    kit: {
      ...kit,
      insertReleaseIntoTiling: async (input) => {
        const written = await kit.insertReleaseIntoTiling(input);
        return (
          written?.map((row) =>
            input.partitions.includes(row)
              ? row
              : { ...row, partitionHash: `sha256:${"0".repeat(64)}` },
          ) ?? null
        );
      },
    },
    layers: ["hashes", "incremental"],
  },
  "a lookup by the plain dotted version": {
    kit: {
      ...kit,
      releaseCatalogLookupKey: (appVersion) => appVersion,
    },
    layers: ["answers", "decisions"],
  },
  "a conversion that drops gap rows": {
    kit: {
      ...kit,
      tileCompiledReleaseCatalog: async (input) => {
        const rows = await kit.tileCompiledReleaseCatalog(input);
        return (
          rows?.filter(
            (row) =>
              (JSON.parse(row.payload) as OneSegment).releaseDescriptors
                .length > 0,
          ) ?? null
        );
      },
    },
    layers: ["conversion"],
  },
  "an assembly that merges equal segments across a gap": {
    kit: {
      ...kit,
      assembleReleaseCatalog: (rows) => {
        const assembled = kit.assembleReleaseCatalog(rows);
        const payload = assembled.payload as OneSegment;
        const segments: OneSegment["segments"][number][] = [];
        for (const segment of payload.segments) {
          const previous = segments.at(-1);
          if (
            previous !== undefined &&
            sameIds(
              previous.rollbackReleaseIndexes.map(String),
              segment.rollbackReleaseIndexes.map(String),
            ) &&
            sameIds(
              previous.releaseIndexes.map(String),
              segment.releaseIndexes.map(String),
            )
          ) {
            segments[segments.length - 1] = {
              ...previous,
              upper: segment.upper,
            };
          } else {
            segments.push(segment);
          }
        }
        const merged = canonical({ ...payload, segments });
        return {
          byteSize: new TextEncoder().encode(merged).byteLength,
          canonicalPayload: merged,
          payload: { ...payload, segments },
        };
      },
    },
    layers: ["assembly", "hashes"],
  },
};

// --- Specs ------------------------------------------------------------------

/**
 * Seeds and their shapes: six minor versions; twelve, so keys compare
 * 1.10.0 with 1.9.0; and two versions over many steps, so rows hold more
 * than eleven releases and frontiers fall short of rollback lists.
 */
const SEQUENCES = [
  { seed: 1, steps: 36, versions: 6 },
  { seed: 2, steps: 36, versions: 6 },
  { seed: 3, steps: 36, versions: 12 },
  { seed: 4, steps: 36, versions: 12 },
  { seed: 5, steps: 90, versions: 2 },
  { seed: 6, steps: 90, versions: 2 },
] as const;

describe("release catalog tiling: differential oracle against today's compiler", () => {
  it("keeps every layer equal over generated write sequences", async () => {
    const counters = createReleaseCatalogOracleCounters();
    const sequences: SequenceCounters[] = [];
    for (const { seed, steps, versions } of SEQUENCES) {
      const { failures, sequence } = await runSequence({
        counters,
        kit,
        seed,
        steps,
        versions,
      });
      expect(failures, `seed ${seed}`).toEqual([]);
      sequences.push(sequence.counters);
    }
    // Every case the oracle claims to cover was reached.
    const total = (key: keyof SequenceCounters) =>
      sequences.reduce((sum, counters) => sum + counters[key], 0);
    for (const key of [
      "inserts",
      "dips",
      "promotes",
      "edits",
      "disables",
      "enables",
      "deletes",
      "rebuilds",
      "exclusiveEndpointInserts",
      "unionInserts",
      "prereleaseInserts",
      "openInserts",
      "cutInserts",
    ] as const) {
      expect(total(key), key).toBeGreaterThan(0);
    }
    expect(counters.gapProbes).toBeGreaterThan(0);
    expect(counters.truncatedFrontiers).toBeGreaterThan(0);
    expect(counters.rollbackToBundle).toBeGreaterThan(0);
    expect(counters.rollbackToBuiltIn).toBeGreaterThan(0);
  }, 300_000);

  it("keeps a frontier cut short by more than 11 bundles on one version", async () => {
    const counters = createReleaseCatalogOracleCounters();
    const sequence = await createSequence({ kit });
    for (let index = 0; index < 14; index += 1) {
      await sequence.deploy({ range: index % 3 === 0 ? "1.0.x" : "1.0.0" });
      expect(
        await check(sequence, kit, counters, { seed: index }),
        `deploy ${index}`,
      ).toEqual([]);
    }
    await sequence.deploy({ range: ">=1.0.0", rollout: 10 });
    await sequence.deploy({ range: "1.0.0", cohorts: ["qa"], rollout: 0 });
    expect(
      await check(sequence, kit, counters, { exhaustive: true, seed: 99 }),
    ).toEqual([]);
    expect(counters.truncatedFrontiers).toBeGreaterThan(0);
  }, 120_000);

  it("keeps a FINGERPRINT scope single-row", async () => {
    const sequence = await createSequence({ kit, strategy: "FINGERPRINT" });
    await sequence.deploy();
    const stored = JSON.parse(
      await sequence.stored(),
    ) as CompiledReleaseCatalog;
    expect(stored.strategy).toBe("FINGERPRINT");
    await expect(kit.tileCompiledReleaseCatalog(stored)).rejects.toMatchObject({
      code: "FINGERPRINT_NOT_PARTITIONED",
    });
    await expect(
      kit.compileReleaseCatalogTiling({ releases: await sequence.releases() }),
    ).rejects.toMatchObject({ code: "INVALID_RELEASE" });
  });

  for (const r3 of ["disabled", "deleted"] as const) {
    for (const strategy of ["APP_VERSION", "FINGERPRINT"] as const) {
      it(`rolls back to R2 in the 15-release counterexample (${strategy}, R3 ${r3})`, async () => {
        const { r, sequence } = await counterexample({ kit, r3, strategy });
        const stored = JSON.parse(
          await sequence.stored(),
        ) as CompiledReleaseCatalog;
        const full = catalogFromLists(
          projectCompiledCatalog(stored, "1.0.0"),
          projectCompiledRollbackCatalog(stored, "1.0.0"),
        );
        const b = sequence.bundles;
        const devices = [
          // Active R3 on B3, and with no active ID on B3.
          { activeReleaseId: r[2]!.id, currentBundleId: b[2]! },
          { activeReleaseId: null, currentBundleId: b[2]! },
        ].map((start) => ({
          ...start,
          builtInBundleId: BUILT_IN,
          cohort: "5",
          crashedBundleIds: [],
          minimumReleaseId: BUILT_IN,
        }));
        for (const device of devices) {
          const expected = decisionsAt(full, device);
          expect(expected.current).toMatchObject({
            bundleId: b[1],
            kind: "BUNDLE",
            releaseId: r[1]!.id,
            status: "ROLLBACK",
          });
          expect(expected.v100).toMatchObject({
            bundleId: b[1],
            kind: "BUNDLE",
            releaseId: r[1]!.id,
            status: "ROLLBACK",
          });
          if (strategy === "FINGERPRINT") continue;
          const projection = kit.projectReleaseCatalogPartition(
            lookupRow(sequence.tiling!, "1.0.0"),
            "1.0.0",
          )!;
          expect(
            decisionsAt(
              catalogFromLists(
                projection.releases,
                projection.rollbackReleases,
              ),
              device,
            ),
          ).toEqual(expected);
        }
        if (strategy === "APP_VERSION") {
          expect(sequence.tiling!.length).toBeGreaterThan(2);
          expect(
            await check(sequence, kit, createReleaseCatalogOracleCounters(), {
              exhaustive: true,
              seed: 15,
            }),
          ).toEqual([]);
        }
      }, 120_000);
    }
  }
});

const lookupRow = (
  rows: readonly ReleaseCatalogPartition[],
  version: string,
) => {
  const key = kit.releaseCatalogLookupKey(version)!;
  return rows.filter((row) => row.lowerKey <= key).at(-1)!;
};

describe("release catalog tiling oracle: red on broken kits", () => {
  for (const [name, ablation] of Object.entries(ablations)) {
    it(`catches ${name}`, async () => {
      const layers = new Set<string>();
      for (const { seed, steps, versions } of SEQUENCES) {
        const { failures } = await runSequence({
          counters: createReleaseCatalogOracleCounters(),
          kit: ablation.kit,
          seed,
          steps,
          versions,
        });
        for (const failure of failures) {
          for (const layer of failure.layers) layers.add(layer);
        }
      }
      for (const r3 of ["disabled", "deleted"] as const) {
        const { sequence } = await counterexample({
          kit: ablation.kit,
          r3,
          strategy: "APP_VERSION",
        });
        for (const mismatch of await check(
          sequence,
          ablation.kit,
          createReleaseCatalogOracleCounters(),
          { seed: 15 },
        )) {
          layers.add(mismatch.layer);
        }
      }
      expect([...layers].sort()).toEqual([...ablation.layers].sort());
    }, 300_000);
  }
});
