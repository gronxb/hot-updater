import {
  isReleaseEligibleForCohort,
  NUMERIC_COHORT_SIZE,
} from "@hot-updater/core";
import type {
  CompiledReleaseCatalog,
  ReleaseCatalogModel,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import type { BundleEventSummary } from "@hot-updater/server";

export type ReleaseReachabilityRow = ReleaseRow & {
  readonly currentlyUnreachable: boolean;
};

export type ReleaseListRow = ReleaseReachabilityRow & {
  readonly activity30d: BundleEventSummary | null;
};

const NON_TARGETED_COHORT = "release-catalog-non-targeted-cohort";

function collectReachableFromIndexes(
  catalog: CompiledReleaseCatalog,
  indexes: readonly number[],
  reachableReleaseIds: Set<string>,
) {
  const descriptors = indexes.flatMap((index) => {
    const descriptor = catalog.releaseDescriptors[index];
    return descriptor === undefined ? [] : [descriptor];
  });
  const cohorts = new Set<string | undefined>([
    undefined,
    ...Array.from({ length: NUMERIC_COHORT_SIZE }, (_, index) =>
      String(index + 1),
    ),
    ...descriptors.flatMap(({ targetCohorts }) => targetCohorts),
    NON_TARGETED_COHORT,
  ]);

  for (const cohort of cohorts) {
    const selected = descriptors.find(
      (descriptor) =>
        descriptor.kind === "BUNDLE" &&
        descriptor.bundleId !== null &&
        isReleaseEligibleForCohort(descriptor, cohort),
    );
    if (selected !== undefined) {
      reachableReleaseIds.add(selected.releaseId);
    }
  }
}

export function collectCurrentlyReachableReleaseIds(
  catalog: CompiledReleaseCatalog,
): ReadonlySet<string> {
  const reachableReleaseIds = new Set<string>();
  const indexGroups =
    catalog.strategy === "APP_VERSION"
      ? catalog.segments.map(({ releaseIndexes }) => releaseIndexes)
      : [catalog.releaseIndexes];

  for (const indexes of indexGroups) {
    collectReachableFromIndexes(catalog, indexes, reachableReleaseIds);
  }

  return reachableReleaseIds;
}

export async function addReleaseReachability(
  releaseCatalogs: Pick<ReleaseCatalogModel, "findByScopeKey">,
  releases: readonly ReleaseRow[],
): Promise<readonly ReleaseReachabilityRow[]> {
  const scopeKeys = [...new Set(releases.map(({ scope_key }) => scope_key))];
  const reachableByScope = new Map(
    await Promise.all(
      scopeKeys.map(async (scopeKey) => {
        const row = await releaseCatalogs.findByScopeKey(scopeKey);
        const reachableReleaseIds =
          row === null
            ? new Set<string>()
            : collectCurrentlyReachableReleaseIds(
                JSON.parse(row.payload) as CompiledReleaseCatalog,
              );
        return [scopeKey, reachableReleaseIds] as const;
      }),
    ),
  );

  return releases.map((release) => ({
    ...release,
    currentlyUnreachable: !reachableByScope
      .get(release.scope_key)
      ?.has(release.id),
  }));
}
