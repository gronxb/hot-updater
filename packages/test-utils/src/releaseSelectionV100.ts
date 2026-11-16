// The release selector of hot-updater v1.0.0, copied verbatim from
// `git show v1.0.0:packages/protocol/src/releaseCatalog.ts`
// (`isReleaseEligibleForCohort` and `selectDesiredRelease`). Devices on a
// v1.0.0 bundle still run it, so a catalog change must keep its decisions.
// `rollout.ts` is unchanged since v1.0.0, so its helpers come from
// @hot-updater/protocol. v1.0.0 has no `runningReleaseId` and returns no
// `shouldForceUpdate`.
import {
  isCohortEligibleForUpdate,
  isCustomCohort,
  normalizeCohortValue,
  normalizeRolloutCohortCount,
  NUMERIC_COHORT_SIZE,
  RELEASE_CATALOG_FALLBACK_POLICY,
  type ReleaseCatalog,
  type ReleaseCatalogDescriptor,
  type SelectionKind,
} from "@hot-updater/protocol";

/** v1.0.0's selection input: no `runningReleaseId`. */
export interface ReleaseSelectionInputV100 {
  readonly builtInBundleId: string;
  readonly currentBundleId: string;
  readonly activeReleaseId?: string | null;
  readonly minimumReleaseId: string;
  readonly cohort: string | null | undefined;
  readonly crashedBundleIds: readonly string[];
}

/** v1.0.0's decision: no `shouldForceUpdate`. */
export type DesiredReleaseV100 = {
  readonly kind: SelectionKind;
  readonly releaseId: string | null;
  readonly bundleId: string;
  readonly release: ReleaseCatalogDescriptor | null;
  readonly status: "UPDATE" | "ROLLBACK";
};

function isReleaseEligibleForCohort(
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

/** v1.0.0's `selectDesiredRelease`, for decision-equivalence oracles. */
export function selectDesiredReleaseV100(
  catalog: ReleaseCatalog,
  input: ReleaseSelectionInputV100,
): DesiredReleaseV100 | null {
  const crashedBundleIds = new Set(input.crashedBundleIds);
  const activeReleaseId = input.activeReleaseId ?? null;
  const hasActiveBundle = input.currentBundleId !== input.builtInBundleId;

  const isSafeBundleRelease = (
    release: ReleaseCatalogDescriptor,
  ): release is ReleaseCatalogDescriptor & { readonly bundleId: string } =>
    release.bundleId !== null &&
    !crashedBundleIds.has(release.bundleId) &&
    release.bundleId >= input.minimumReleaseId;

  const desiredBundle = (
    release: ReleaseCatalogDescriptor & { readonly bundleId: string },
    status: "UPDATE" | "ROLLBACK",
  ): DesiredReleaseV100 => ({
    bundleId: release.bundleId,
    kind: "BUNDLE",
    release,
    releaseId: release.releaseId,
    status,
  });

  for (const release of catalog.releases) {
    if (!isReleaseEligibleForCohort(release, input.cohort)) {
      continue;
    }

    if (
      (activeReleaseId !== null && release.releaseId <= activeReleaseId) ||
      (activeReleaseId === null &&
        hasActiveBundle &&
        (release.bundleId === null ||
          release.bundleId <= input.currentBundleId))
    ) {
      continue;
    }

    if (isSafeBundleRelease(release)) {
      return desiredBundle(release, "UPDATE");
    }
  }

  if (activeReleaseId !== null || hasActiveBundle) {
    const { rollbackReleases } = catalog;
    const current = rollbackReleases.find(
      (release) =>
        release.releaseId === activeReleaseId ||
        (activeReleaseId === null &&
          release.bundleId === input.currentBundleId),
    );
    if (
      current !== undefined &&
      isSafeBundleRelease(current) &&
      isReleaseEligibleForCohort(current, input.cohort)
    ) {
      return desiredBundle(current, "UPDATE");
    }

    const rollback = rollbackReleases.find(
      (release) =>
        isSafeBundleRelease(release) &&
        (activeReleaseId !== null
          ? release.releaseId < activeReleaseId
          : release.bundleId < input.currentBundleId),
    );
    if (rollback !== undefined && isSafeBundleRelease(rollback)) {
      return desiredBundle(rollback, "ROLLBACK");
    }

    if (input.currentBundleId <= input.minimumReleaseId) {
      return null;
    }
  }

  if (catalog.fallbackPolicy !== RELEASE_CATALOG_FALLBACK_POLICY) {
    return null;
  }

  return {
    bundleId: input.builtInBundleId,
    kind: "BUILTIN",
    release: null,
    releaseId: null,
    status: "ROLLBACK",
  };
}
