import { getBundlePatches } from "@hot-updater/core";
import type { Bundle, DatabasePlugin } from "@hot-updater/plugin-core";

const CHILDREN_QUERY_LIMIT = 100;

interface GetBundleChildrenInput {
  baseBundleId: string;
}

interface GetBundleChildrenDeps {
  databasePlugin: DatabasePlugin;
}

type CursorPaginationInfo = {
  hasNextPage: boolean;
  nextCursor?: string | null;
};

async function collectBundleChildrenByBaseIds(
  baseBundleIds: string[],
  deps: GetBundleChildrenDeps,
): Promise<Record<string, Bundle[]>> {
  const uniqueBaseBundleIds = [...new Set(baseBundleIds.filter(Boolean))];
  const bundlesByBaseId = Object.fromEntries(
    uniqueBaseBundleIds.map((bundleId) => [bundleId, [] as Bundle[]]),
  );

  const baseBundles = (
    await Promise.all(
      uniqueBaseBundleIds.map((bundleId) =>
        deps.databasePlugin.getBundleById(bundleId),
      ),
    )
  ).filter((bundle): bundle is Bundle => Boolean(bundle));

  const groupMap = new Map<
    string,
    { channel: string; platform: Bundle["platform"]; bundleIds: Set<string> }
  >();

  for (const baseBundle of baseBundles) {
    const groupKey = `${baseBundle.channel}:${baseBundle.platform}`;
    const existingGroup = groupMap.get(groupKey);

    if (existingGroup) {
      existingGroup.bundleIds.add(baseBundle.id);
      continue;
    }

    groupMap.set(groupKey, {
      channel: baseBundle.channel,
      platform: baseBundle.platform,
      bundleIds: new Set([baseBundle.id]),
    });
  }

  for (const group of groupMap.values()) {
    const seenBundleIds = new Set<string>();
    const seenCursors = new Set<string>();
    let after: string | undefined;

    while (true) {
      const page = await deps.databasePlugin.getBundles({
        where: {
          channel: group.channel,
          platform: group.platform,
        },
        limit: CHILDREN_QUERY_LIMIT,
        cursor: after ? { after } : undefined,
      } as Parameters<DatabasePlugin["getBundles"]>[0]);

      for (const bundle of page.data) {
        const parentBundleIds = getBundlePatches(bundle).map(
          (patch) => patch.baseBundleId,
        );
        const matchedParentBundleIds = parentBundleIds.filter((bundleId) =>
          group.bundleIds.has(bundleId),
        );

        if (
          matchedParentBundleIds.length === 0 ||
          seenBundleIds.has(bundle.id)
        ) {
          continue;
        }

        seenBundleIds.add(bundle.id);
        for (const parentBundleId of matchedParentBundleIds) {
          bundlesByBaseId[parentBundleId]?.push(bundle);
        }
      }

      const pagination = page.pagination as CursorPaginationInfo;
      const nextCursor = pagination.nextCursor ?? undefined;

      if (
        !pagination.hasNextPage ||
        !nextCursor ||
        seenCursors.has(nextCursor)
      ) {
        break;
      }

      seenCursors.add(nextCursor);
      after = nextCursor;
    }
  }

  return bundlesByBaseId;
}

export async function getBundleChildren(
  { baseBundleId }: GetBundleChildrenInput,
  deps: GetBundleChildrenDeps,
): Promise<Bundle[]> {
  const childrenByBaseId = await collectBundleChildrenByBaseIds(
    [baseBundleId],
    deps,
  );

  return childrenByBaseId[baseBundleId] ?? [];
}

export async function getBundleChildCounts(
  baseBundleIds: string[],
  deps: GetBundleChildrenDeps,
): Promise<Record<string, number>> {
  const childrenByBaseId = await collectBundleChildrenByBaseIds(
    baseBundleIds,
    deps,
  );

  return Object.fromEntries(
    Object.entries(childrenByBaseId).map(([bundleId, bundles]) => [
      bundleId,
      bundles.length,
    ]),
  );
}
