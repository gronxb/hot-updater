import {
  assembleReleaseCatalog,
  compileReleaseCatalogTiling,
  type CompiledReleaseCatalog,
  insertReleaseIntoTiling,
  projectCompiledCatalog,
  projectCompiledRollbackCatalog,
  projectReleaseCatalogPartition,
  releaseCatalogKeyRanges,
  releaseCatalogLookupKey,
  type ReleaseCatalogPartition,
  tileCompiledReleaseCatalog,
} from "@hot-updater/plugin-core";
import {
  canonicalizeAppVersion,
  isReleaseEligibleForCohort,
  MAX_CRASHED_BUNDLES,
  NIL_UUID,
  RELEASE_CATALOG_FALLBACK_POLICY,
  type Release,
  type ReleaseCatalog,
  type ReleaseCatalogDescriptor,
  selectDesiredRelease,
} from "@hot-updater/protocol";

import { selectDesiredReleaseV100 } from "./releaseSelectionV100";

/**
 * The tiling kit the oracle checks, passed in so a test can hand it a
 * deliberately broken variant and see the oracle catch it.
 */
export interface ReleaseCatalogTilingKit {
  readonly compileReleaseCatalogTiling: typeof compileReleaseCatalogTiling;
  readonly tileCompiledReleaseCatalog: typeof tileCompiledReleaseCatalog;
  readonly insertReleaseIntoTiling: typeof insertReleaseIntoTiling;
  readonly assembleReleaseCatalog: typeof assembleReleaseCatalog;
  readonly projectReleaseCatalogPartition: typeof projectReleaseCatalogPartition;
  readonly releaseCatalogKeyRanges: typeof releaseCatalogKeyRanges;
  readonly releaseCatalogLookupKey: typeof releaseCatalogLookupKey;
}

/** `@hot-updater/plugin-core`'s tiling kit, as published. */
export const releaseCatalogTilingKit: ReleaseCatalogTilingKit = {
  assembleReleaseCatalog,
  compileReleaseCatalogTiling,
  insertReleaseIntoTiling,
  projectReleaseCatalogPartition,
  releaseCatalogKeyRanges,
  releaseCatalogLookupKey,
  tileCompiledReleaseCatalog,
};

/**
 * What the oracle compares, each against today's single-row catalog:
 * - `conversion`: the tiling of the stored compact catalog;
 * - `incremental`: the tiling kept up by inserts, against a full compile;
 * - `assembly`: the compact catalog the tiling assembles to, byte for byte;
 * - `answers`: what a device on each probed app version receives;
 * - `decisions`: what both selectors decide from those answers.
 */
export type ReleaseCatalogOracleLayer =
  | "conversion"
  | "incremental"
  | "assembly"
  | "answers"
  | "decisions";

export interface ReleaseCatalogOracleMismatch {
  readonly layer: ReleaseCatalogOracleLayer;
  readonly detail: string;
}

/** How often the oracle saw each case, so a run that never reaches one fails. */
export interface ReleaseCatalogOracleCounters {
  probes: number;
  gapProbes: number;
  decisions: number;
  rollbackToBundle: number;
  rollbackToBuiltIn: number;
  truncatedFrontiers: number;
}

export const createReleaseCatalogOracleCounters =
  (): ReleaseCatalogOracleCounters => ({
    decisions: 0,
    gapProbes: 0,
    probes: 0,
    rollbackToBuiltIn: 0,
    rollbackToBundle: 0,
    truncatedFrontiers: 0,
  });

const sameRows = (
  left: readonly ReleaseCatalogPartition[] | null,
  right: readonly ReleaseCatalogPartition[] | null,
): boolean => JSON.stringify(left) === JSON.stringify(right);

/**
 * The rows an insert of a release with `targetAppVersion` reads, as core
 * reads them: for each key range, the row at or below its start, and every
 * row after it below its stop. Null when the range doesn't fit the keys.
 */
export const rowsForInsert = (
  kit: ReleaseCatalogTilingKit,
  rows: readonly ReleaseCatalogPartition[],
  targetAppVersion: string,
): readonly ReleaseCatalogPartition[] | null => {
  const ranges = kit.releaseCatalogKeyRanges(targetAppVersion);
  if (ranges === null) return null;
  const sorted = [...rows].sort((left, right) =>
    left.lowerKey < right.lowerKey
      ? -1
      : left.lowerKey > right.lowerKey
        ? 1
        : 0,
  );
  const picked = new Set<ReleaseCatalogPartition>();
  for (const { start, stop } of ranges) {
    const first = sorted.findLast((row) => row.lowerKey <= start);
    if (first !== undefined) picked.add(first);
    for (const row of sorted) {
      if (row.lowerKey > start && (stop === null || row.lowerKey < stop)) {
        picked.add(row);
      }
    }
  }
  return [...picked];
};

/** Replaces the rows `read` by `written`, keeping the others. */
export const replaceRows = (
  rows: readonly ReleaseCatalogPartition[],
  read: readonly ReleaseCatalogPartition[],
  written: readonly ReleaseCatalogPartition[],
): readonly ReleaseCatalogPartition[] =>
  [...rows.filter((row) => !read.includes(row)), ...written].sort(
    (left, right) =>
      left.lowerKey < right.lowerKey
        ? -1
        : left.lowerKey > right.lowerKey
          ? 1
          : 0,
  );

/** A device's row: the greatest lower key at or below its version's key. */
export const lookupPartition = (
  kit: ReleaseCatalogTilingKit,
  rows: readonly ReleaseCatalogPartition[],
  appVersion: string,
): ReleaseCatalogPartition | undefined => {
  const key = kit.releaseCatalogLookupKey(appVersion);
  if (key === null) return undefined;
  let found: ReleaseCatalogPartition | undefined;
  for (const row of rows) {
    if (
      row.lowerKey <= key &&
      (found === undefined || row.lowerKey > found.lowerKey)
    ) {
      found = row;
    }
  }
  return found;
};

const bump = (version: string, part: 0 | 1 | 2): string => {
  const parts = version.split(".").map(Number);
  parts[part]! += 1;
  for (let index = part + 1; index < 3; index += 1) parts[index] = 0;
  return parts.join(".");
};

/**
 * The app versions a device can report that tell the catalog's intervals
 * apart: every endpoint's `x.y.z`, its neighbours, and versions below and
 * above everything. Devices send only `x.y.z`, so intervals between
 * prerelease endpoints are covered by row and assembly equality instead.
 */
export const probeAppVersions = (
  catalog: CompiledReleaseCatalog,
  ranges: readonly string[],
): readonly string[] => {
  const endpoints = new Set<string>(["0.0.0", "999.999.999"]);
  const add = (version: string | undefined) => {
    const canonical = version && canonicalizeAppVersion(version);
    if (!canonical) return;
    endpoints.add(canonical);
    const [major, minor, patch] = canonical.split(".").map(Number);
    if (patch! > 0) endpoints.add(`${major}.${minor}.${patch! - 1}`);
    if (minor! > 0) endpoints.add(`${major}.${minor! - 1}.0`);
    for (const part of [0, 1, 2] as const) endpoints.add(bump(canonical, part));
  };
  if (catalog.strategy === "APP_VERSION") {
    for (const segment of catalog.segments) {
      add(segment.lower?.version);
      add(segment.upper?.version);
    }
  }
  for (const range of ranges) {
    for (const match of range.matchAll(/\d+\.\d+\.\d+/g)) add(match[0]);
  }
  return [...endpoints].sort();
};

/** One device whose decisions the oracle compares. */
export interface ReleaseCatalogDeviceState {
  readonly builtInBundleId: string;
  readonly currentBundleId: string;
  readonly activeReleaseId: string | null;
  /** Omitted: the running release is the active one. */
  readonly runningReleaseId?: string | null;
  readonly minimumReleaseId: string;
  readonly cohort: string | null;
  readonly crashedBundleIds: readonly string[];
}

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

const eligibleByRelease = new Map<string, ReadonlySet<number>>();

/** The numeric cohorts 1–1000 a release reaches, computed once per policy. */
const eligibleNumericCohorts = (
  release: Pick<
    ReleaseCatalogDescriptor,
    "releaseId" | "rolloutCohortCount" | "targetCohorts"
  >,
): ReadonlySet<number> => {
  const key = JSON.stringify([
    release.releaseId,
    release.rolloutCohortCount,
    release.targetCohorts,
  ]);
  let cohorts = eligibleByRelease.get(key);
  if (cohorts === undefined) {
    const reached = new Set<number>();
    for (let cohort = 1; cohort <= 1000; cohort += 1) {
      if (isReleaseEligibleForCohort(release, String(cohort))) {
        reached.add(cohort);
      }
    }
    cohorts = reached;
    eligibleByRelease.set(key, cohorts);
  }
  return cohorts;
};

/**
 * The cohorts that select differently over `releases`: no cohort, one
 * numeric cohort per distinct eligibility over the releases, every target
 * cohort, and a custom cohort no release targets.
 */
export const cohortClasses = (
  releases: readonly Pick<
    ReleaseCatalogDescriptor,
    "releaseId" | "rolloutCohortCount" | "targetCohorts"
  >[],
): readonly (string | null)[] => {
  const eligible = releases.map(eligibleNumericCohorts);
  const numeric = new Map<string, string>();
  for (let cohort = 1; cohort <= 1000; cohort += 1) {
    const vector = eligible
      .map((cohorts) => (cohorts.has(cohort) ? "1" : "0"))
      .join("");
    if (!numeric.has(vector)) numeric.set(vector, String(cohort));
  }
  const targets = new Set(
    releases.flatMap(({ targetCohorts }) => targetCohorts),
  );
  return [null, ...numeric.values(), ...[...targets].sort(), "zz-not-targeted"];
};

/** Every subset of `items` when there are at most 6, else samples, all ≤ 10. */
const crashedSets = (
  items: readonly string[],
  random: () => number,
  samples: number,
): readonly (readonly string[])[] => {
  if (items.length <= 6) {
    return Array.from({ length: 2 ** items.length }, (_, mask) =>
      items.filter((_, index) => mask & (1 << index)),
    );
  }
  const sets: string[][] = [[], items.slice(-MAX_CRASHED_BUNDLES)];
  while (sets.length < samples) {
    // Uniform over subsets, then cut to the device's cap.
    sets.push(items.filter(() => random() < 0.5).slice(0, MAX_CRASHED_BUNDLES));
  }
  return sets;
};

/**
 * Device states from a scope's history, never from either catalog: every
 * release ever made as the active one, enabled, disabled or deleted; the
 * running release equal to it, null, or an older staged one with its
 * bundle; no active release on each bundle or the built-in; each floor
 * position; each cohort class; and crashed sets. `exhaustive` takes the
 * whole product, otherwise `limit` states drawn from it with every active
 * release and cohort class kept.
 */
export const deviceStates = (input: {
  readonly history: readonly Pick<Release, "id" | "bundleId">[];
  readonly cohorts: readonly (string | null)[];
  readonly builtInBundleId: string;
  readonly seed: number;
  readonly exhaustive: boolean;
  readonly limit?: number;
}): readonly ReleaseCatalogDeviceState[] => {
  const random = createRandom(input.seed);
  const history = [...input.history].sort((left, right) =>
    left.id < right.id ? -1 : 1,
  );
  const bundles = [
    ...new Set(history.flatMap(({ bundleId }) => (bundleId ? [bundleId] : []))),
  ].sort();
  // Floors below, at and above the bundles; the selector compares IDs only.
  const floors = [
    ...new Set([
      NIL_UUID,
      input.builtInBundleId,
      ...bundles.filter(
        (_, index) =>
          index === 0 ||
          index === bundles.length - 1 ||
          index === Math.floor(bundles.length / 2),
      ),
    ]),
  ];
  const starts: Omit<
    ReleaseCatalogDeviceState,
    "minimumReleaseId" | "cohort" | "crashedBundleIds" | "builtInBundleId"
  >[] = [
    { activeReleaseId: null, currentBundleId: input.builtInBundleId },
    ...bundles.map((bundle) => ({
      activeReleaseId: null,
      currentBundleId: bundle,
    })),
  ];
  for (const [index, release] of history.entries()) {
    const current = release.bundleId ?? input.builtInBundleId;
    starts.push({ activeReleaseId: release.id, currentBundleId: current });
    starts.push({
      activeReleaseId: release.id,
      currentBundleId: current,
      runningReleaseId: null,
    });
    const older = history[Math.floor(random() * index)];
    if (index > 0 && older !== undefined) {
      // Staged: the newer bundle waits for the next launch while the older
      // one runs.
      starts.push({
        activeReleaseId: release.id,
        currentBundleId: older.bundleId ?? input.builtInBundleId,
        runningReleaseId: older.id,
      });
    }
  }
  const crashed = crashedSets(bundles, random, input.exhaustive ? 8 : 4);
  const states: ReleaseCatalogDeviceState[] = [];
  const state = (
    start: (typeof starts)[number],
    cohort: string | null,
    floor: string,
    crashedBundleIds: readonly string[],
  ): ReleaseCatalogDeviceState => ({
    ...start,
    builtInBundleId: input.builtInBundleId,
    cohort,
    crashedBundleIds,
    minimumReleaseId: floor,
  });
  if (input.exhaustive) {
    for (const start of starts) {
      for (const cohort of input.cohorts) {
        for (const floor of floors) {
          for (const set of crashed)
            states.push(state(start, cohort, floor, set));
        }
      }
    }
    return states;
  }
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)]!;
  // Every start and every cohort class at least once, then random draws.
  for (const start of starts) {
    states.push(state(start, pick(input.cohorts), input.builtInBundleId, []));
  }
  for (const cohort of input.cohorts) {
    states.push(state(pick(starts), cohort, input.builtInBundleId, []));
  }
  for (let index = 0; index < (input.limit ?? 200); index += 1) {
    states.push(
      state(pick(starts), pick(input.cohorts), pick(floors), pick(crashed)),
    );
  }
  return states;
};

const catalogOf = (
  releases: readonly ReleaseCatalogDescriptor[],
  rollbackReleases: readonly ReleaseCatalogDescriptor[],
): ReleaseCatalog => ({
  catalogHash: `sha256:${"0".repeat(64)}`,
  catalogId: "catalog",
  fallbackPolicy: RELEASE_CATALOG_FALLBACK_POLICY,
  generation: 1,
  releases,
  rollbackReleases,
  schemaVersion: 1,
  scopeKey: "scope",
});

/** Both selectors' complete decisions, kind, status, IDs, descriptor and force. */
export const decide = (
  catalog: ReleaseCatalog,
  device: ReleaseCatalogDeviceState,
): string => {
  const { runningReleaseId: _running, ...v100Input } = device;
  return JSON.stringify({
    current: selectDesiredRelease(catalog, device),
    v100: selectDesiredReleaseV100(catalog, v100Input),
  });
};

/**
 * One step of a write sequence, checked against today's catalog:
 * `stored` is the compact catalog today's core persisted after the write,
 * `releases` the scope's release rows after it, `tiling` the rows kept up
 * by the kit's inserts across the sequence, and `history` every release
 * the scope has had, deleted ones included.
 */
export const checkReleaseCatalogTiling = async (input: {
  readonly kit: ReleaseCatalogTilingKit;
  readonly stored: string;
  readonly releases: readonly Release[];
  readonly tiling: readonly ReleaseCatalogPartition[] | null;
  readonly history: readonly Release[];
  readonly builtInBundleId: string;
  readonly seed: number;
  readonly exhaustive: boolean;
  /** States drawn when not exhaustive, beyond one per start and cohort. */
  readonly limit?: number;
  readonly counters: ReleaseCatalogOracleCounters;
}): Promise<readonly ReleaseCatalogOracleMismatch[]> => {
  const { kit, counters } = input;
  const mismatches: ReleaseCatalogOracleMismatch[] = [];
  const fail = (layer: ReleaseCatalogOracleLayer, detail: string) => {
    mismatches.push({ detail, layer });
  };
  // A kit call that throws fails its layer, as a wrong result would.
  const attempt = async <T>(
    layer: ReleaseCatalogOracleLayer,
    call: () => Promise<T> | T,
  ): Promise<{ readonly value: T } | null> => {
    try {
      return { value: await call() };
    } catch (error) {
      fail(layer, `the kit threw: ${String(error)}`);
      return null;
    }
  };
  const stored = JSON.parse(input.stored) as CompiledReleaseCatalog;
  const compiled = await attempt("incremental", () =>
    kit.compileReleaseCatalogTiling({ releases: input.releases }),
  );
  const full = compiled?.value ?? null;
  if (full === null) {
    if (compiled !== null) {
      fail("incremental", "the full compile doesn't fit the keys");
    }
    return mismatches;
  }

  const converted = await attempt("conversion", () =>
    kit.tileCompiledReleaseCatalog(stored),
  );
  if (converted !== null && !sameRows(converted.value, full)) {
    fail(
      "conversion",
      "the stored catalog tiles differently from a full compile",
    );
  }
  if (!sameRows(input.tiling, full)) {
    fail(
      "incremental",
      `the inserted tiling ${JSON.stringify(input.tiling?.map(({ lowerKey }) => lowerKey))} differs from a full compile ${JSON.stringify(full.map(({ lowerKey }) => lowerKey))}`,
    );
  }
  const tiling = input.tiling ?? full;

  const assembled = await attempt("assembly", () =>
    kit.assembleReleaseCatalog(tiling),
  );
  if (assembled !== null && assembled.value.canonicalPayload !== input.stored) {
    fail("assembly", "the assembled catalog differs from the stored one");
  }

  if (stored.strategy === "APP_VERSION") {
    counters.truncatedFrontiers += stored.segments.filter(
      (segment) =>
        segment.releaseIndexes.length < segment.rollbackReleaseIndexes.length,
    ).length;
  }
  const cohorts = cohortClasses(
    input.history.map((release) => ({
      releaseId: release.id,
      rolloutCohortCount: release.rolloutCohortCount,
      targetCohorts: release.targetCohorts,
    })),
  );
  const devices = deviceStates({
    builtInBundleId: input.builtInBundleId,
    cohorts,
    exhaustive: input.exhaustive,
    history: input.history,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    seed: input.seed,
  });
  const versions = probeAppVersions(
    stored,
    input.history.flatMap(({ targetAppVersion }) =>
      targetAppVersion === null ? [] : [targetAppVersion],
    ),
  );
  for (const version of versions) {
    counters.probes += 1;
    const expected = catalogOf(
      projectCompiledCatalog(stored, version),
      projectCompiledRollbackCatalog(stored, version),
    );
    const row = lookupPartition(kit, tiling, version);
    const projection =
      row === undefined
        ? null
        : ((
            await attempt("answers", () =>
              kit.projectReleaseCatalogPartition(row, version),
            )
          )?.value ?? null);
    if (projection === null) {
      fail("answers", `no row covers ${version}`);
    } else if (
      projection.releases.length === 0 &&
      projection.rollbackReleases.length === 0
    ) {
      counters.gapProbes += 1;
    }
    // A row that doesn't cover the version answers nothing, as a gap would.
    const actual = catalogOf(
      projection?.releases ?? [],
      projection?.rollbackReleases ?? [],
    );
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail("answers", `app version ${version} receives other lists`);
    }
    // Decisions run on their own, so this layer is seen to fail by itself.
    for (const device of devices) {
      counters.decisions += 1;
      const want = decide(expected, device);
      if (decide(actual, device) !== want) {
        fail(
          "decisions",
          `app version ${version}, device ${JSON.stringify(device)}`,
        );
        break;
      }
      const chosen = selectDesiredRelease(expected, device);
      if (chosen?.status === "ROLLBACK") {
        if (chosen.kind === "BUNDLE") counters.rollbackToBundle += 1;
        else counters.rollbackToBuiltIn += 1;
      }
    }
  }
  return mismatches;
};

/** Every layer the mismatches name, sorted. */
export const oracleLayers = (
  mismatches: readonly ReleaseCatalogOracleMismatch[],
): readonly ReleaseCatalogOracleLayer[] =>
  [...new Set(mismatches.map(({ layer }) => layer))].sort();
