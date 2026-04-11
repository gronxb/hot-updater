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

export async function getBundleChildren(
  { baseBundleId }: GetBundleChildrenInput,
  deps: GetBundleChildrenDeps,
): Promise<Bundle[]> {
  const baseBundle = await deps.databasePlugin.getBundleById(baseBundleId);

  if (!baseBundle) {
    return [];
  }

  const children: Bundle[] = [];
  const seenBundleIds = new Set<string>();
  const seenCursors = new Set<string>();
  let after: string | undefined;

  while (true) {
    const page = await deps.databasePlugin.getBundles({
      where: {
        channel: baseBundle.channel,
        platform: baseBundle.platform,
      },
      limit: CHILDREN_QUERY_LIMIT,
      cursor: after ? { after } : undefined,
    } as Parameters<DatabasePlugin["getBundles"]>[0]);

    for (const bundle of page.data) {
      if (
        bundle.metadata?.diff_base_bundle_id !== baseBundleId ||
        seenBundleIds.has(bundle.id)
      ) {
        continue;
      }

      seenBundleIds.add(bundle.id);
      children.push(bundle);
    }

    const pagination = page.pagination as CursorPaginationInfo;
    const nextCursor = pagination.nextCursor ?? undefined;
    if (!pagination.hasNextPage || !nextCursor || seenCursors.has(nextCursor)) {
      break;
    }

    seenCursors.add(nextCursor);
    after = nextCursor;
  }

  return children;
}
