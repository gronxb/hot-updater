import {
  type Bundle,
  type HotUpdaterCoreApi,
  rowToBundle,
} from "@hot-updater/plugin-core";

/** The most children the lineage panel lists; the count comes from the base bundle's counter. */
export const BUNDLE_CHILDREN_LIMIT = 100;

/**
 * The bundles with a patch from this base, newest first: one read of the
 * patches index, then each child bundle.
 */
export async function getBundleChildren(
  core: Pick<HotUpdaterCoreApi, "getBundle" | "listPatchesFromBase">,
  baseBundleId: string,
): Promise<Bundle[]> {
  const patches = await core.listPatchesFromBase(baseBundleId, {
    order: "desc",
    limit: BUNDLE_CHILDREN_LIMIT,
  });
  const details = await Promise.all(
    [...new Set(patches.map(({ bundle_id }) => bundle_id))].map((id) =>
      core.getBundle(id),
    ),
  );
  return details.flatMap((detail) =>
    detail === null ? [] : [rowToBundle(detail.bundle, detail.patches)],
  );
}

/** How many bundles patch from each base: each base bundle's reference counter, no scan. */
export async function getBundleChildCounts(
  core: Pick<HotUpdaterCoreApi, "getBundle">,
  baseBundleIds: readonly string[],
): Promise<Record<string, number>> {
  const ids = [...new Set(baseBundleIds.filter(Boolean))];
  const details = await Promise.all(ids.map((id) => core.getBundle(id)));
  return Object.fromEntries(
    ids.map((id, position) => [id, details[position]?.childCount ?? 0]),
  );
}
