import type { Bundle } from "@hot-updater/core";

import { calculatePagination } from "./calculatePagination";
import { DatabasePluginInputError } from "./databasePluginCrud";
import { validateBundlePagination } from "./databasePluginCrudValidationQueries";
import { rowsToBundles } from "./databaseRows";
import type {
  BundleRow,
  DatabaseBundleCursor,
  DatabaseBundleIdFilter,
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryWhere,
  BundleRepository,
  PaginatedResult,
} from "./types";

const PAGE_SIZE = 100;

const mergeIdFilter = (
  where: DatabaseBundleQueryWhere | undefined,
  id: DatabaseBundleIdFilter,
): DatabaseBundleQueryWhere => ({
  ...where,
  id: { ...where?.id, ...id },
});

export const loadBundleRows = async (
  database: BundleRepository,
  where?: DatabaseBundleQueryWhere,
): Promise<BundleRow[]> => {
  const finiteIds = where?.id?.in;
  if (finiteIds) {
    if (finiteIds.length === 0) return [];
    return [
      ...(await database.bundles.findMany({
        where,
        limit: finiteIds.length,
        offset: 0,
        orderBy: { field: "id", direction: "asc" },
      })),
    ];
  }
  const [cutoff] = await database.bundles.findMany({
    where,
    limit: 1,
    offset: 0,
    orderBy: { field: "id", direction: "desc" },
  });
  if (!cutoff) return [];

  const rows: BundleRow[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await database.bundles.findMany({
      where: mergeIdFilter(where, {
        lte: cutoff.id,
        ...(after ? { gt: after } : {}),
      }),
      limit: PAGE_SIZE,
      offset: 0,
      orderBy: { field: "id", direction: "asc" },
    });
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    after = page.at(-1)?.id;
  }
};

export const hydrateRows = async (
  database: BundleRepository,
  ownerRows: readonly BundleRow[],
): Promise<Bundle[]> => {
  const patchRows = await database.bundlePatches.findByBundleIds(
    ownerRows.map(({ id }) => id),
  );
  const ownerIds = new Set(ownerRows.map(({ id }) => id));
  const referencedIds = [
    ...new Set(
      patchRows
        .map(({ base_bundle_id }) => base_bundle_id)
        .filter((id) => !ownerIds.has(id)),
    ),
  ];
  const referencedRows =
    referencedIds.length === 0
      ? []
      : await loadBundleRows(database, { id: { in: referencedIds } });
  return rowsToBundles(ownerRows, patchRows, referencedRows);
};

const cursorIdFilter = (
  cursor: DatabaseBundleCursor | undefined,
  direction: "asc" | "desc",
): DatabaseBundleIdFilter | undefined => {
  if (cursor?.after) {
    return { [direction === "desc" ? "lt" : "gt"]: cursor.after };
  }
  if (cursor?.before) {
    return { [direction === "desc" ? "gt" : "lt"]: cursor.before };
  }
  return undefined;
};

export const responsePage = async (
  database: BundleRepository,
  options: DatabaseBundleQueryOptions,
): Promise<PaginatedResult> => {
  validateBundlePagination(options);
  const direction = options.orderBy?.direction ?? "desc";
  const offset = options.page
    ? Math.max(0, options.page - 1) * options.limit
    : 0;
  const cursor = options.page ? undefined : options.cursor;
  const queryLimit = cursor ? options.limit + 1 : options.limit;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(queryLimit) ||
    !Number.isSafeInteger(offset + queryLimit)
  ) {
    throw new DatabasePluginInputError("invalid-pagination");
  }
  const cursorFilter = cursorIdFilter(cursor, direction);
  const where = cursorFilter
    ? mergeIdFilter(options.where, cursorFilter)
    : options.where;
  const queryDirection = cursor?.before
    ? direction === "desc"
      ? "asc"
      : "desc"
    : direction;
  const [queriedRows, total] = await Promise.all([
    database.bundles.findMany({
      where,
      limit: queryLimit,
      offset,
      orderBy: { field: "id", direction: queryDirection },
    }),
    database.bundles.count(options.where),
  ]);
  const hasMore = cursor ? queriedRows.length > options.limit : false;
  const pageRows = cursor ? queriedRows.slice(0, options.limit) : queriedRows;
  const ownerRows = cursor?.before ? pageRows.toReversed() : pageRows;
  const pagination = calculatePagination(total, {
    limit: options.limit,
    offset,
  });
  const hasPreviousPage = cursor
    ? Boolean(cursor.after) || hasMore
    : pagination.hasPreviousPage;
  const hasNextPage = cursor
    ? Boolean(cursor.before) || hasMore
    : pagination.hasNextPage;
  const firstId = ownerRows[0]?.id;
  const lastId = ownerRows.at(-1)?.id;

  return {
    data: await hydrateRows(database, ownerRows),
    pagination: {
      ...pagination,
      hasNextPage,
      hasPreviousPage,
      ...(hasNextPage && lastId ? { nextCursor: lastId } : {}),
      ...(hasPreviousPage && firstId ? { previousCursor: firstId } : {}),
      ...(!firstId && cursor?.after ? { previousCursor: cursor.after } : {}),
      ...(!lastId && cursor?.before ? { nextCursor: cursor.before } : {}),
    },
  };
};
