import type { Bundle } from "@hot-updater/core";

import { calculatePagination } from "./calculatePagination";
import { rowsToBundles } from "./databaseRows";
import type {
  BundlePatchRow,
  BundleRow,
  DatabaseBundleCursor,
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryWhere,
  DatabasePlugin,
  DatabaseWhere,
  PaginatedResult,
  TransactionDatabasePlugin,
} from "./types";

const PAGE_SIZE = 100;

export const toBundleWhere = (
  where: DatabaseBundleQueryWhere | undefined,
): readonly DatabaseWhere<"bundles">[] => {
  if (!where) return [];
  const filters: DatabaseWhere<"bundles">[] = [];
  if (where.channel !== undefined)
    filters.push({ field: "channel", value: where.channel });
  if (where.platform !== undefined)
    filters.push({ field: "platform", value: where.platform });
  if (where.enabled !== undefined)
    filters.push({ field: "enabled", value: where.enabled });
  if (where.id?.eq !== undefined)
    filters.push({ field: "id", value: where.id.eq });
  if (where.id?.gt !== undefined)
    filters.push({ field: "id", operator: "gt", value: where.id.gt });
  if (where.id?.gte !== undefined)
    filters.push({ field: "id", operator: "gte", value: where.id.gte });
  if (where.id?.lt !== undefined)
    filters.push({ field: "id", operator: "lt", value: where.id.lt });
  if (where.id?.lte !== undefined)
    filters.push({ field: "id", operator: "lte", value: where.id.lte });
  if (where.id?.in !== undefined)
    filters.push({ field: "id", operator: "in", value: where.id.in });
  if (where.targetAppVersionNotNull)
    filters.push({
      field: "target_app_version",
      operator: "ne",
      value: null,
    });
  if (where.targetAppVersion !== undefined)
    filters.push({
      field: "target_app_version",
      value: where.targetAppVersion,
    });
  if (where.targetAppVersionIn !== undefined)
    filters.push({
      field: "target_app_version",
      operator: "in",
      value: where.targetAppVersionIn,
    });
  if (where.fingerprintHash !== undefined)
    filters.push({
      field: "fingerprint_hash",
      value: where.fingerprintHash,
    });
  return filters;
};

export const loadBundleRows = async (
  database: TransactionDatabasePlugin,
  where: readonly DatabaseWhere<"bundles">[] = [],
): Promise<BundleRow[]> => {
  const [cutoff] = await database.findMany({
    model: "bundles",
    where,
    select: ["id"],
    limit: 1,
    offset: 0,
    orderBy: [{ field: "id", direction: "desc" }],
  });
  if (!cutoff) return [];

  const rows: BundleRow[] = [];
  let after: string | undefined;
  for (;;) {
    const afterWhere: readonly DatabaseWhere<"bundles">[] = after
      ? [{ field: "id", operator: "gt", value: after }]
      : [];
    const page = await database.findMany({
      model: "bundles",
      where: [
        ...where,
        { field: "id", operator: "lte", value: cutoff.id },
        ...afterWhere,
      ],
      limit: PAGE_SIZE,
      offset: 0,
      orderBy: [{ field: "id", direction: "asc" }],
    });
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    after = page.at(-1)?.id;
  }
};

const loadPatchRows = async (
  database: TransactionDatabasePlugin,
  ownerIds: readonly string[],
): Promise<BundlePatchRow[]> => {
  if (ownerIds.length === 0) return [];
  const rows: BundlePatchRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await database.findMany({
      model: "bundle_patches",
      where: [{ field: "bundle_id", operator: "in", value: ownerIds }],
      limit: PAGE_SIZE,
      offset,
      orderBy: [{ field: "id", direction: "asc" }],
    });
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
};

export const hydrateRows = async (
  database: TransactionDatabasePlugin,
  ownerRows: readonly BundleRow[],
): Promise<Bundle[]> => {
  const patchRows = await loadPatchRows(
    database,
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
      : await loadBundleRows(database, [
          { field: "id", operator: "in", value: referencedIds },
        ]);
  return rowsToBundles(ownerRows, patchRows, referencedRows);
};

const cursorWhere = (
  cursor: DatabaseBundleCursor | undefined,
  direction: "asc" | "desc",
): DatabaseWhere<"bundles"> | undefined => {
  if (cursor?.after) {
    return {
      field: "id",
      operator: direction === "desc" ? "lt" : "gt",
      value: cursor.after,
    };
  }
  if (cursor?.before) {
    return {
      field: "id",
      operator: direction === "desc" ? "gt" : "lt",
      value: cursor.before,
    };
  }
  return undefined;
};

export const responsePage = async (
  database: DatabasePlugin,
  options: DatabaseBundleQueryOptions,
): Promise<PaginatedResult> => {
  const where = toBundleWhere(options.where);
  const direction = options.orderBy?.direction ?? "desc";
  const offset = options.page
    ? Math.max(0, options.page - 1) * options.limit
    : 0;
  const cursor = options.page ? undefined : options.cursor;
  const cursorFilter = cursorWhere(cursor, direction);
  const queryDirection = cursor?.before
    ? direction === "desc"
      ? "asc"
      : "desc"
    : direction;
  const [queriedRows, total] = await Promise.all([
    database.findMany({
      model: "bundles",
      where: cursorFilter ? [...where, cursorFilter] : where,
      limit: options.limit,
      offset,
      orderBy: [{ field: "id", direction: queryDirection }],
    }),
    database.count({ model: "bundles", where }),
  ]);
  const ownerRows = cursor?.before ? queriedRows.toReversed() : queriedRows;
  const pagination = calculatePagination(total, {
    limit: options.limit,
    offset,
  });
  const hasPreviousPage = cursor
    ? Boolean(cursor.after) || queriedRows.length === options.limit
    : pagination.hasPreviousPage;
  const hasNextPage = cursor
    ? Boolean(cursor.before) || queriedRows.length === options.limit
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
