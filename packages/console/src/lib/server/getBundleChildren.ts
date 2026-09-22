import type {
  Bundle,
  BundlePatchModel,
  DatabaseClient,
} from "@hot-updater/plugin-core";

interface GetBundleChildrenDeps {
  databaseClient: DatabaseClient;
  bundlePatches: BundlePatchModel;
}

async function childIds(
  baseBundleIds: readonly string[],
  { bundlePatches }: GetBundleChildrenDeps,
): Promise<Map<string, Set<string>>> {
  const ids = [...new Set(baseBundleIds.filter(Boolean))];
  const result = new Map(ids.map((id) => [id, new Set<string>()]));
  if (ids.length === 0) return result;
  if (bundlePatches.findByBaseBundleIds === undefined)
    throw new Error(
      "The database provider must support indexed patch children lookup",
    );
  for (const row of await bundlePatches.findByBaseBundleIds(ids))
    result.get(row.base_bundle_id)?.add(row.bundle_id);
  return result;
}

export async function getBundleChildren(
  { baseBundleId }: { baseBundleId: string },
  deps: GetBundleChildrenDeps,
): Promise<Bundle[]> {
  const children =
    (await childIds([baseBundleId], deps)).get(baseBundleId) ??
    new Set<string>();
  const bundles = [];
  for (const id of [...children].sort().reverse()) {
    const bundle = await deps.databaseClient.getBundleById(id);
    if (bundle !== null) bundles.push(bundle);
  }
  return bundles;
}

export async function getBundleChildCounts(
  baseBundleIds: string[],
  deps: GetBundleChildrenDeps,
): Promise<Record<string, number>> {
  return Object.fromEntries(
    [...(await childIds(baseBundleIds, deps))].map(([id, children]) => [
      id,
      children.size,
    ]),
  );
}
