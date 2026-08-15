import {
  getNumericCohortValue,
  getRolledOutNumericCohorts,
  isCustomCohort,
  MAX_COMPILED_CATALOG_BYTES,
  MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE,
  MAX_TARGET_COHORTS_PER_RELEASE,
  normalizeCohortValue,
  normalizeRolloutCohortCount,
  NUMERIC_COHORT_SIZE,
  RELEASE_CATALOG_FALLBACK_POLICY,
  RELEASE_CATALOG_SCHEMA_VERSION,
  type Release,
  type ReleaseCatalogDescriptor,
  type ReleaseStrategy,
} from "@hot-updater/core";
import {
  coerce,
  compare,
  normalize,
  parseRange,
  satisfies,
  type SemVerComparator,
} from "verkit";

export interface CatalogVersionBound {
  readonly version: string;
  readonly inclusive: boolean;
}

export interface CompiledCatalogSegment {
  readonly lower: CatalogVersionBound | null;
  readonly upper: CatalogVersionBound | null;
  readonly releaseIndexes: readonly number[];
}

export type CompiledReleaseCatalog =
  | {
      readonly schemaVersion: typeof RELEASE_CATALOG_SCHEMA_VERSION;
      readonly strategy: "APP_VERSION";
      readonly fallbackPolicy: typeof RELEASE_CATALOG_FALLBACK_POLICY;
      readonly releaseDescriptors: readonly ReleaseCatalogDescriptor[];
      readonly segments: readonly CompiledCatalogSegment[];
    }
  | {
      readonly schemaVersion: typeof RELEASE_CATALOG_SCHEMA_VERSION;
      readonly strategy: "FINGERPRINT";
      readonly fallbackPolicy: typeof RELEASE_CATALOG_FALLBACK_POLICY;
      readonly releaseDescriptors: readonly ReleaseCatalogDescriptor[];
      readonly releaseIndexes: readonly number[];
    };

export interface ReleaseCatalogCompilerDiagnostics {
  readonly releaseCount: number;
  readonly descriptorCount: number;
  readonly segmentCount: number;
  readonly distinctTargetCohortCount: number;
  readonly byteSize: number;
}

export interface ReleaseCatalogCompilation {
  readonly payload: CompiledReleaseCatalog;
  readonly canonicalPayload: string;
  readonly catalogHash: string;
  readonly byteSize: number;
  readonly diagnostics: ReleaseCatalogCompilerDiagnostics;
}

export class ReleaseCatalogCompilationError extends Error {
  readonly code:
    | "INVALID_RELEASE"
    | "INVALID_TARGET_RANGE"
    | "TARGET_COHORT_LIMIT"
    | "DISTINCT_TARGET_COHORT_LIMIT"
    | "CATALOG_OVERSIZE";

  constructor(
    code:
      | "INVALID_RELEASE"
      | "INVALID_TARGET_RANGE"
      | "TARGET_COHORT_LIMIT"
      | "DISTINCT_TARGET_COHORT_LIMIT"
      | "CATALOG_OVERSIZE",
    message: string,
  ) {
    super(message);
    this.name = "ReleaseCatalogCompilationError";
    this.code = code;
  }
}

type VersionInterval = {
  readonly lower: CatalogVersionBound | null;
  readonly upper: CatalogVersionBound | null;
};

function compareBounds(left: string, right: string): number {
  return compare(left, right);
}

function strongerLower(
  current: CatalogVersionBound | null,
  candidate: CatalogVersionBound,
): CatalogVersionBound {
  if (current === null) return candidate;
  const compared = compareBounds(candidate.version, current.version);
  if (compared > 0) return candidate;
  if (compared < 0) return current;
  return {
    version: current.version,
    inclusive: current.inclusive && candidate.inclusive,
  };
}

function strongerUpper(
  current: CatalogVersionBound | null,
  candidate: CatalogVersionBound,
): CatalogVersionBound {
  if (current === null) return candidate;
  const compared = compareBounds(candidate.version, current.version);
  if (compared < 0) return candidate;
  if (compared > 0) return current;
  return {
    version: current.version,
    inclusive: current.inclusive && candidate.inclusive,
  };
}

function comparatorVersion(comparator: SemVerComparator): string {
  const version = comparator.version && normalize(comparator.version);
  if (version === null) {
    throw new ReleaseCatalogCompilationError(
      "INVALID_TARGET_RANGE",
      `Invalid comparator: ${comparator.value}`,
    );
  }
  return version;
}

function comparatorSetToInterval(
  comparators: readonly SemVerComparator[],
): VersionInterval | null {
  let lower: CatalogVersionBound | null = null;
  let upper: CatalogVersionBound | null = null;

  for (const comparator of comparators) {
    if (comparator.version === null) continue;
    const version = comparatorVersion(comparator);
    if (comparator.operator === "") {
      lower = strongerLower(lower, { inclusive: true, version });
      upper = strongerUpper(upper, { inclusive: true, version });
    } else if (comparator.operator === ">") {
      lower = strongerLower(lower, { inclusive: false, version });
    } else if (comparator.operator === ">=") {
      lower = strongerLower(lower, { inclusive: true, version });
    } else if (comparator.operator === "<") {
      upper = strongerUpper(upper, { inclusive: false, version });
    } else if (comparator.operator === "<=") {
      upper = strongerUpper(upper, { inclusive: true, version });
    }
  }

  if (lower !== null && upper !== null) {
    const compared = compareBounds(lower.version, upper.version);
    if (
      compared > 0 ||
      (compared === 0 && (!lower.inclusive || !upper.inclusive))
    ) {
      return null;
    }
  }
  return { lower, upper };
}

function rangeToIntervals(range: string): readonly VersionInterval[] {
  try {
    return parseRange(range).sets.flatMap((comparators) => {
      const interval = comparatorSetToInterval(comparators);
      return interval === null ? [] : [interval];
    });
  } catch {
    throw new ReleaseCatalogCompilationError(
      "INVALID_TARGET_RANGE",
      `Invalid target app-version range: ${range}`,
    );
  }
}

function releaseDescriptor(release: Release): ReleaseCatalogDescriptor {
  return {
    releaseId: release.id,
    kind: release.kind,
    bundleId: release.bundleId,
    rolloutCohortCount: release.rolloutCohortCount,
    targetCohorts: [...new Set(release.targetCohorts)].sort(),
    shouldForceUpdate: release.shouldForceUpdate,
    message: release.message,
  };
}

function validateReleases(
  releases: readonly Release[],
  strategy: ReleaseStrategy,
): readonly Release[] {
  const enabled = releases
    .filter((release) => release.enabled)
    .sort((left, right) => right.id.localeCompare(left.id));
  const seenIds = new Set<string>();

  for (const release of enabled) {
    if (seenIds.has(release.id)) {
      throw new ReleaseCatalogCompilationError(
        "INVALID_RELEASE",
        `Duplicate Release ID: ${release.id}`,
      );
    }
    seenIds.add(release.id);

    if (release.strategy !== strategy) {
      throw new ReleaseCatalogCompilationError(
        "INVALID_RELEASE",
        `Release ${release.id} has the wrong strategy`,
      );
    }
    if (
      (release.kind === "BUNDLE" && release.bundleId === null) ||
      (release.kind === "EMBEDDED" && release.bundleId !== null)
    ) {
      throw new ReleaseCatalogCompilationError(
        "INVALID_RELEASE",
        `Release ${release.id} has an invalid kind/Bundle combination`,
      );
    }
    if (release.targetCohorts.length > MAX_TARGET_COHORTS_PER_RELEASE) {
      throw new ReleaseCatalogCompilationError(
        "TARGET_COHORT_LIMIT",
        `Release ${release.id} exceeds ${MAX_TARGET_COHORTS_PER_RELEASE} target cohorts`,
      );
    }
    if (
      strategy === "APP_VERSION" &&
      (release.targetAppVersion === null || release.fingerprintHash !== null)
    ) {
      throw new ReleaseCatalogCompilationError(
        "INVALID_RELEASE",
        `Release ${release.id} has an invalid app-version target`,
      );
    }
    if (
      strategy === "FINGERPRINT" &&
      (release.fingerprintHash === null || release.targetAppVersion !== null)
    ) {
      throw new ReleaseCatalogCompilationError(
        "INVALID_RELEASE",
        `Release ${release.id} has an invalid fingerprint target`,
      );
    }
  }
  return enabled;
}

function collectFrontierReleaseIds(
  releases: readonly Release[],
): ReadonlySet<string> {
  if (
    releases.every(
      (release) =>
        normalizeRolloutCohortCount(release.rolloutCohortCount) >=
        NUMERIC_COHORT_SIZE,
    )
  ) {
    const retained = new Set<string>();
    const bundleIds = new Set<string>();
    let embedded = false;
    for (const release of releases) {
      if (release.kind === "EMBEDDED") {
        if (!embedded) {
          embedded = true;
          retained.add(release.id);
        }
      } else if (
        release.bundleId !== null &&
        bundleIds.size < 11 &&
        !bundleIds.has(release.bundleId)
      ) {
        bundleIds.add(release.bundleId);
        retained.add(release.id);
      }
      if (embedded && bundleIds.size >= 11) break;
    }
    return retained;
  }

  const explicitTargetCohorts = new Set(
    releases.flatMap((release) => release.targetCohorts),
  );
  const cohortStates = [
    undefined,
    ...Array.from({ length: 1000 }, (_, index) => String(index + 1)),
    ...[...explicitTargetCohorts].sort(),
    "release-catalog-non-targeted-cohort",
  ].map((cohort) => {
    const normalized =
      cohort === undefined ? undefined : normalizeCohortValue(cohort);
    return {
      isCustom: normalized !== undefined && isCustomCohort(normalized),
      normalized,
      numeric:
        normalized === undefined ? null : getNumericCohortValue(normalized),
      bundleIds: new Set<string>(),
      embedded: false,
      complete: false,
    };
  });
  const stateIndexesByCohort = new Map<string, number[]>();
  const fullRolloutStateIndexes: number[] = [];
  for (const [index, state] of cohortStates.entries()) {
    if (state.normalized !== undefined) {
      const indexes = stateIndexesByCohort.get(state.normalized) ?? [];
      indexes.push(index);
      stateIndexesByCohort.set(state.normalized, indexes);
    }
    if (
      state.normalized === undefined ||
      state.numeric !== null ||
      state.isCustom
    ) {
      fullRolloutStateIndexes.push(index);
    }
  }
  const retained = new Set<string>();
  let incompleteStateCount = cohortStates.length;
  for (const release of releases) {
    const rolloutCohortCount = normalizeRolloutCohortCount(
      release.rolloutCohortCount,
    );
    const eligibleStateIndexes = new Set<number>();
    if (rolloutCohortCount >= NUMERIC_COHORT_SIZE) {
      for (const index of fullRolloutStateIndexes) {
        eligibleStateIndexes.add(index);
      }
    } else if (rolloutCohortCount > 0) {
      for (const numericCohort of getRolledOutNumericCohorts(
        release.id,
        rolloutCohortCount,
      )) {
        for (const index of stateIndexesByCohort.get(String(numericCohort)) ??
          []) {
          eligibleStateIndexes.add(index);
        }
      }
    }
    for (const targetCohort of new Set(
      release.targetCohorts.map(normalizeCohortValue),
    )) {
      for (const index of stateIndexesByCohort.get(targetCohort) ?? []) {
        eligibleStateIndexes.add(index);
      }
    }

    for (const index of eligibleStateIndexes) {
      const state = cohortStates[index]!;
      if (state.complete) continue;
      if (release.kind === "EMBEDDED") {
        if (!state.embedded) {
          state.embedded = true;
          retained.add(release.id);
        }
      } else if (
        release.bundleId !== null &&
        state.bundleIds.size < 11 &&
        !state.bundleIds.has(release.bundleId)
      ) {
        state.bundleIds.add(release.bundleId);
        retained.add(release.id);
      }
      if (state.embedded && state.bundleIds.size >= 11) {
        state.complete = true;
        incompleteStateCount -= 1;
      }
    }
    if (incompleteStateCount === 0) break;
  }
  return retained;
}

function intervalContainsSegment(
  interval: VersionInterval,
  segment: VersionInterval,
): boolean {
  if (interval.lower !== null) {
    if (segment.lower === null) return false;
    const compared = compareBounds(
      segment.lower.version,
      interval.lower.version,
    );
    if (
      compared < 0 ||
      (compared === 0 && segment.lower.inclusive && !interval.lower.inclusive)
    ) {
      return false;
    }
  }
  if (interval.upper !== null) {
    if (segment.upper === null) return false;
    const compared = compareBounds(
      segment.upper.version,
      interval.upper.version,
    );
    if (
      compared > 0 ||
      (compared === 0 && segment.upper.inclusive && !interval.upper.inclusive)
    ) {
      return false;
    }
  }
  return true;
}

function atomicVersionSegments(
  intervals: readonly VersionInterval[],
): readonly VersionInterval[] {
  const endpoints = [
    ...new Set(
      intervals.flatMap((interval) =>
        [interval.lower?.version, interval.upper?.version].filter(
          (version): version is string => version !== undefined,
        ),
      ),
    ),
  ].sort(compareBounds);

  if (endpoints.length === 0) return [{ lower: null, upper: null }];

  const segments: VersionInterval[] = [
    {
      lower: null,
      upper: { inclusive: false, version: endpoints[0]! },
    },
  ];
  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index]!;
    segments.push({
      lower: { inclusive: true, version: endpoint },
      upper: { inclusive: true, version: endpoint },
    });
    const next = endpoints[index + 1];
    if (next !== undefined) {
      segments.push({
        lower: { inclusive: false, version: endpoint },
        upper: { inclusive: false, version: next },
      });
    }
  }
  segments.push({
    lower: { inclusive: false, version: endpoints.at(-1)! },
    upper: null,
  });
  return segments;
}

function sameIndexes(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function mergeSegments(
  segments: readonly CompiledCatalogSegment[],
): readonly CompiledCatalogSegment[] {
  const merged: CompiledCatalogSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (
      previous &&
      sameIndexes(previous.releaseIndexes, segment.releaseIndexes)
    ) {
      merged[merged.length - 1] = { ...previous, upper: segment.upper };
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

function compileAppVersion(releases: readonly Release[]): {
  readonly envelope: Omit<
    Extract<CompiledReleaseCatalog, { strategy: "APP_VERSION" }>,
    "releaseDescriptors"
  >;
  readonly retainedReleases: readonly Release[];
} {
  const ranges = new Map<string, readonly VersionInterval[]>();
  for (const release of releases) {
    ranges.set(release.id, rangeToIntervals(release.targetAppVersion!));
  }
  const intervals = [...ranges.values()].flat();
  const segmentReleases = atomicVersionSegments(intervals).map((segment) => {
    const applicable = releases.filter((release) =>
      ranges
        .get(release.id)!
        .some((range) => intervalContainsSegment(range, segment)),
    );
    return { segment, retainedIds: collectFrontierReleaseIds(applicable) };
  });
  const retainedIds = new Set(
    segmentReleases.flatMap(({ retainedIds }) => [...retainedIds]),
  );
  const retainedReleases = releases.filter((release) =>
    retainedIds.has(release.id),
  );
  const descriptorIndex = new Map(
    retainedReleases.map((release, index) => [release.id, index]),
  );
  const segments = mergeSegments(
    segmentReleases
      .map(({ segment, retainedIds }) => ({
        ...segment,
        releaseIndexes: releases
          .filter((release) => retainedIds.has(release.id))
          .map((release) => descriptorIndex.get(release.id)!)
          .filter((index) => index !== undefined),
      }))
      .filter((segment) => segment.releaseIndexes.length > 0),
  );

  return {
    envelope: {
      fallbackPolicy: RELEASE_CATALOG_FALLBACK_POLICY,
      schemaVersion: RELEASE_CATALOG_SCHEMA_VERSION,
      segments,
      strategy: "APP_VERSION",
    },
    retainedReleases,
  };
}

function compileFingerprint(releases: readonly Release[]): {
  readonly envelope: Omit<
    Extract<CompiledReleaseCatalog, { strategy: "FINGERPRINT" }>,
    "releaseDescriptors"
  >;
  readonly retainedReleases: readonly Release[];
} {
  const retainedIds = collectFrontierReleaseIds(releases);
  const retainedReleases = releases.filter((release) =>
    retainedIds.has(release.id),
  );
  return {
    envelope: {
      fallbackPolicy: RELEASE_CATALOG_FALLBACK_POLICY,
      releaseIndexes: retainedReleases.map((_, index) => index),
      schemaVersion: RELEASE_CATALOG_SCHEMA_VERSION,
      strategy: "FINGERPRINT",
    },
    retainedReleases,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
    .join(",")}}`;
}

export async function compileReleaseCatalog(input: {
  readonly strategy: ReleaseStrategy;
  readonly releases: readonly Release[];
}): Promise<ReleaseCatalogCompilation> {
  const releases = validateReleases(input.releases, input.strategy);
  const targetCohorts = new Set(
    releases.flatMap((release) => release.targetCohorts),
  );
  if (targetCohorts.size > MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE) {
    throw new ReleaseCatalogCompilationError(
      "DISTINCT_TARGET_COHORT_LIMIT",
      `Scope exceeds ${MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE} distinct target cohorts`,
    );
  }

  const { envelope, retainedReleases } =
    input.strategy === "APP_VERSION"
      ? compileAppVersion(releases)
      : compileFingerprint(releases);
  const payload = {
    ...envelope,
    releaseDescriptors: retainedReleases.map(releaseDescriptor),
  } as CompiledReleaseCatalog;
  const canonicalPayload = canonicalStringify(payload);
  const byteSize = new TextEncoder().encode(canonicalPayload).byteLength;
  if (byteSize > MAX_COMPILED_CATALOG_BYTES) {
    throw new ReleaseCatalogCompilationError(
      "CATALOG_OVERSIZE",
      `Compiled Release catalog is ${byteSize} bytes; maximum is ${MAX_COMPILED_CATALOG_BYTES}`,
    );
  }

  return {
    byteSize,
    canonicalPayload,
    catalogHash: await sha256(canonicalPayload),
    diagnostics: {
      byteSize,
      descriptorCount: payload.releaseDescriptors.length,
      distinctTargetCohortCount: targetCohorts.size,
      releaseCount: releases.length,
      segmentCount:
        payload.strategy === "APP_VERSION" ? payload.segments.length : 1,
    },
    payload,
  };
}

function versionInSegment(
  version: string,
  segment: CompiledCatalogSegment,
): boolean {
  if (segment.lower !== null) {
    const compared = compareBounds(version, segment.lower.version);
    if (compared < 0 || (compared === 0 && !segment.lower.inclusive)) {
      return false;
    }
  }
  if (segment.upper !== null) {
    const compared = compareBounds(version, segment.upper.version);
    if (compared > 0 || (compared === 0 && !segment.upper.inclusive)) {
      return false;
    }
  }
  return true;
}

export function canonicalizeAppVersion(appVersion: string): string | null {
  return coerce(appVersion);
}

export function projectCompiledCatalog(
  catalog: CompiledReleaseCatalog,
  appVersion?: string,
): readonly ReleaseCatalogDescriptor[] {
  let indexes: readonly number[];
  if (catalog.strategy === "FINGERPRINT") {
    indexes = catalog.releaseIndexes;
  } else {
    const canonicalVersion = appVersion && canonicalizeAppVersion(appVersion);
    if (!canonicalVersion) return [];
    indexes =
      catalog.segments.find((segment) =>
        versionInSegment(canonicalVersion, segment),
      )?.releaseIndexes ?? [];
  }
  return indexes.map((index) => catalog.releaseDescriptors[index]!);
}

export function referenceCompatibleReleases(
  releases: readonly Release[],
  appVersion: string,
): readonly Release[] {
  const canonicalVersion = canonicalizeAppVersion(appVersion);
  if (!canonicalVersion) return [];
  return releases.filter(
    (release) =>
      release.enabled &&
      release.targetAppVersion !== null &&
      satisfies(canonicalVersion, release.targetAppVersion),
  );
}
