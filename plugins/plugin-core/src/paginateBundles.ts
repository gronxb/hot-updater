import { calculatePagination } from "./calculatePagination";
import { sortBundles } from "./queryBundles";
import type {
  Bundle,
  DatabaseBundleCursor,
  DatabaseBundleQueryOrder,
  Paginated,
} from "./types";

export function paginateBundles({
  bundles,
  limit,
  cursor,
  orderBy,
}: {
  bundles: Bundle[];
  limit: number;
  cursor?: DatabaseBundleCursor;
  orderBy?: DatabaseBundleQueryOrder;
}): Paginated<Bundle[]> {
  const sortedBundles = sortBundles(bundles, orderBy);
  const direction = orderBy?.direction ?? "desc";

  let data: Bundle[];
  if (cursor?.after) {
    const candidates = sortedBundles.filter((bundle) =>
      direction === "desc"
        ? bundle.id.localeCompare(cursor.after!) < 0
        : bundle.id.localeCompare(cursor.after!) > 0,
    );
    data = limit > 0 ? candidates.slice(0, limit) : candidates;
  } else if (cursor?.before) {
    const candidates = sortedBundles.filter((bundle) =>
      direction === "desc"
        ? bundle.id.localeCompare(cursor.before!) > 0
        : bundle.id.localeCompare(cursor.before!) < 0,
    );
    data =
      limit > 0
        ? candidates.slice(Math.max(0, candidates.length - limit))
        : candidates;
  } else {
    data = limit > 0 ? sortedBundles.slice(0, limit) : sortedBundles;
  }

  const total = sortedBundles.length;
  const startIndex =
    data.length > 0
      ? sortedBundles.findIndex((bundle) => bundle.id === data[0]!.id)
      : cursor?.after
        ? total
        : 0;
  const pagination = calculatePagination(total, {
    limit,
    offset: startIndex,
  });
  const nextCursor =
    data.length > 0 && startIndex + data.length < total
      ? data.at(-1)?.id
      : undefined;
  const previousCursor =
    data.length > 0 && startIndex > 0 ? data[0]?.id : undefined;

  return {
    data,
    pagination: {
      ...pagination,
      ...(nextCursor ? { nextCursor } : {}),
      ...(previousCursor ? { previousCursor } : {}),
      ...(data.length === 0 && cursor?.after
        ? { previousCursor: cursor.after }
        : {}),
      ...(data.length === 0 && cursor?.before
        ? { nextCursor: cursor.before }
        : {}),
    },
  };
}
