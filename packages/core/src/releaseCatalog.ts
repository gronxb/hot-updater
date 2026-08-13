import {
  isCohortEligibleForUpdate,
  isCustomCohort,
  normalizeCohortValue,
  normalizeRolloutCohortCount,
  NUMERIC_COHORT_SIZE,
} from "./rollout";

export const RELEASE_CATALOG_SCHEMA_VERSION = 1 as const;
export const RELEASE_CATALOG_FALLBACK_POLICY =
  "BUILTIN_IF_ACTIVE_INELIGIBLE" as const;
export const MAX_CRASHED_BUNDLES = 10;
export const MAX_TARGET_COHORTS_PER_RELEASE = 100;
export const MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE = 512;
export const MAX_COMPILED_CATALOG_BYTES = 256 * 1024;

export type ReleaseKind = "BUNDLE" | "EMBEDDED";
export type ReleaseStrategy = "APP_VERSION" | "FINGERPRINT";
export type ReleaseOperation = "DEPLOY" | "PROMOTE" | "ROLLBACK";
export type SelectionKind = ReleaseKind | "BUILTIN";

export interface Release {
  readonly id: string;
  readonly revision: number;
  readonly channelId: string;
  readonly platform: "ios" | "android";
  readonly kind: ReleaseKind;
  readonly bundleId: string | null;
  readonly strategy: ReleaseStrategy;
  readonly targetAppVersion: string | null;
  readonly fingerprintHash: string | null;
  readonly enabled: boolean;
  readonly shouldForceUpdate: boolean;
  readonly message: string | null;
  readonly rolloutCohortCount: number;
  readonly targetCohorts: readonly string[];
  readonly operation: ReleaseOperation;
  readonly sourceReleaseId: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ReleaseCatalogDescriptor {
  readonly releaseId: string;
  readonly kind: ReleaseKind;
  readonly bundleId: string | null;
  readonly rolloutCohortCount: number;
  readonly targetCohorts: readonly string[];
  readonly shouldForceUpdate: boolean;
  readonly message: string | null;
}

export interface ReleaseCatalog {
  readonly schemaVersion: typeof RELEASE_CATALOG_SCHEMA_VERSION;
  readonly authorityId: string;
  readonly scopeKey: string;
  readonly generation: number;
  readonly catalogHash: string;
  readonly fallbackPolicy: typeof RELEASE_CATALOG_FALLBACK_POLICY;
  /** Release descriptors ordered newest first. */
  readonly releases: readonly ReleaseCatalogDescriptor[];
}

export interface CatalogHighWater {
  readonly generation: number;
  readonly catalogHash: string;
}

export interface PersistedSelectionReceipt {
  readonly kind: SelectionKind;
  readonly releaseId: string | null;
  readonly bundleId: string;
  readonly authorityId: string | null;
  readonly scopeKey: string | null;
  readonly generation: number | null;
  readonly catalogHash: string | null;
  readonly channel: string;
  readonly selectionContextHash: string | null;
}

export interface ReleaseSelectionInput {
  readonly builtInBundleId: string;
  readonly minimumReleaseId: string;
  readonly cohort: string | null | undefined;
  readonly crashedBundleIds: readonly string[];
}

export interface ReleaseSelectionContextInput {
  readonly cohort: string | null | undefined;
  readonly minimumReleaseId: string;
  readonly strategy: ReleaseStrategy;
  readonly strategyValue: string;
  readonly crashedBundleIds: readonly string[];
}

const hashSelectionContext = (value: string): string => {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }

  return `v1:${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
};

export function createReleaseSelectionContextHash(
  input: ReleaseSelectionContextInput,
): string {
  const crashedBundleIds = [...new Set(input.crashedBundleIds)]
    .sort()
    .slice(0, MAX_CRASHED_BUNDLES);
  const canonical = JSON.stringify({
    cohort: normalizeCohortValue(input.cohort ?? ""),
    crashedBundleIds,
    minimumReleaseId: input.minimumReleaseId,
    selectorSchemaVersion: RELEASE_CATALOG_SCHEMA_VERSION,
    strategy: input.strategy,
    strategyValue: input.strategyValue,
  });
  return hashSelectionContext(canonical);
}

export type DesiredRelease = {
  readonly kind: SelectionKind;
  readonly releaseId: string | null;
  readonly bundleId: string;
  readonly release: ReleaseCatalogDescriptor | null;
};

export function isReleaseEligibleForCohort(
  release: Pick<
    ReleaseCatalogDescriptor,
    "releaseId" | "rolloutCohortCount" | "targetCohorts"
  >,
  cohort: string | null | undefined,
): boolean {
  if (
    isCohortEligibleForUpdate(
      release.releaseId,
      cohort,
      release.rolloutCohortCount,
      release.targetCohorts,
    )
  ) {
    return true;
  }

  return (
    cohort !== null &&
    cohort !== undefined &&
    isCustomCohort(normalizeCohortValue(cohort)) &&
    normalizeRolloutCohortCount(release.rolloutCohortCount) ===
      NUMERIC_COHORT_SIZE
  );
}

export function selectDesiredRelease(
  catalog: ReleaseCatalog,
  input: ReleaseSelectionInput,
): DesiredRelease | null {
  const crashedBundleIds = new Set(input.crashedBundleIds);

  for (const release of catalog.releases) {
    if (release.releaseId < input.minimumReleaseId) {
      continue;
    }

    if (!isReleaseEligibleForCohort(release, input.cohort)) {
      continue;
    }

    if (release.kind === "BUNDLE") {
      if (release.bundleId === null) {
        continue;
      }
      if (crashedBundleIds.has(release.bundleId)) {
        continue;
      }

      return {
        bundleId: release.bundleId,
        kind: "BUNDLE",
        release,
        releaseId: release.releaseId,
      };
    }

    if (release.bundleId !== null) {
      continue;
    }

    return {
      bundleId: input.builtInBundleId,
      kind: "EMBEDDED",
      release,
      releaseId: release.releaseId,
    };
  }

  if (catalog.fallbackPolicy !== RELEASE_CATALOG_FALLBACK_POLICY) {
    return null;
  }

  return {
    bundleId: input.builtInBundleId,
    kind: "BUILTIN",
    release: null,
    releaseId: null,
  };
}

export type CatalogAcceptance =
  | {
      readonly accepted: true;
      readonly shouldAdvanceHighWater: boolean;
    }
  | {
      readonly accepted: false;
      readonly reason: "STALE_GENERATION" | "GENERATION_HASH_MISMATCH";
    };

export function assessCatalogAcceptance(
  incoming: CatalogHighWater,
  highestSeen: CatalogHighWater | null,
): CatalogAcceptance {
  if (highestSeen === null) {
    return { accepted: true, shouldAdvanceHighWater: true };
  }

  if (incoming.generation < highestSeen.generation) {
    return { accepted: false, reason: "STALE_GENERATION" };
  }

  if (
    incoming.generation === highestSeen.generation &&
    incoming.catalogHash !== highestSeen.catalogHash
  ) {
    return { accepted: false, reason: "GENERATION_HASH_MISMATCH" };
  }

  return {
    accepted: true,
    shouldAdvanceHighWater: incoming.generation > highestSeen.generation,
  };
}

export type ReleaseTransitionAuthorization =
  | {
      readonly authorized: true;
      readonly reason:
        | "FIRST_AUTHENTICATED_SELECTION"
        | "NEWER_POLICY"
        | "CONTEXT_RESELECTION"
        | "EXPLICIT_SCOPE_SWITCH";
    }
  | {
      readonly authorized: false;
      readonly reason:
        | "BACKWARD_NOT_AUTHORIZED"
        | "EMPTY_TARGET_SCOPE"
        | "STALE_GENERATION"
        | "UNSOLICITED_SCOPE";
    };

export function authorizeReleaseTransition(input: {
  readonly active: PersistedSelectionReceipt | null;
  readonly desired: PersistedSelectionReceipt;
  readonly explicitScopeSwitch: boolean;
}): ReleaseTransitionAuthorization {
  const { active, desired, explicitScopeSwitch } = input;

  if (
    active === null ||
    active.scopeKey === null ||
    active.generation === null
  ) {
    return { authorized: true, reason: "FIRST_AUTHENTICATED_SELECTION" };
  }

  if (
    desired.authorityId !== active.authorityId ||
    desired.scopeKey !== active.scopeKey
  ) {
    if (!explicitScopeSwitch) {
      return { authorized: false, reason: "UNSOLICITED_SCOPE" };
    }
    if (desired.releaseId === null || desired.kind === "BUILTIN") {
      return { authorized: false, reason: "EMPTY_TARGET_SCOPE" };
    }
    return { authorized: true, reason: "EXPLICIT_SCOPE_SWITCH" };
  }

  if (desired.generation === null || desired.generation < active.generation) {
    return { authorized: false, reason: "STALE_GENERATION" };
  }

  if (desired.generation > active.generation) {
    return { authorized: true, reason: "NEWER_POLICY" };
  }

  if (desired.selectionContextHash !== active.selectionContextHash) {
    return { authorized: true, reason: "CONTEXT_RESELECTION" };
  }

  return { authorized: false, reason: "BACKWARD_NOT_AUTHORIZED" };
}
