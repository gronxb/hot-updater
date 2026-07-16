import type { BundleEventRow } from "@hot-updater/plugin-core";

import type {
  DatabaseAdapter,
  InstallationSearchRow,
  OffsetPaginationResult,
} from "./types";

const toSearchRow = (row: BundleEventRow): InstallationSearchRow => ({
  installId: row.install_id,
  username: row.username,
  userId: row.user_id,
  lastKnownBundleId: row.to_bundle_id,
  latestStatus: row.type,
  platform: row.platform,
  appVersion: row.app_version,
  channel: row.channel,
  cohort: row.cohort,
  receivedAtMs: row.received_at_ms,
});

// `distinctOn` keeps the first row, so install ID is the cross-adapter page order.
const stableLatestPerInstallOrder = [
  { field: "install_id", direction: "asc" },
  { field: "received_at_ms", direction: "desc" },
  { field: "id", direction: "desc" },
] as const;

const identitySearchWhere = (query: string) =>
  [
    {
      field: "username",
      operator: "contains",
      value: query,
      mode: "insensitive",
    },
    {
      field: "user_id",
      operator: "contains",
      value: query,
      mode: "insensitive",
      connector: "OR",
    },
    {
      field: "install_id",
      operator: "contains",
      value: query,
      mode: "insensitive",
      connector: "OR",
    },
  ] as const;

const fetchLatestRowsForInstalls = async <TContext>(
  database: DatabaseAdapter<TContext>,
  installIds: readonly string[],
  context?: TContext,
): Promise<readonly BundleEventRow[]> => {
  if (installIds.length === 0) return [];
  const rows = await database.findMany(
    {
      model: "bundle_events",
      where: [{ field: "install_id", operator: "in", value: installIds }],
      distinctOn: { fields: ["install_id"] },
      orderBy: stableLatestPerInstallOrder,
      limit: installIds.length,
      offset: 0,
    },
    context,
  );
  const rowsByInstallId = new Map(rows.map((row) => [row.install_id, row]));
  return installIds.flatMap((installId) => {
    const row = rowsByInstallId.get(installId);
    return row ? [row] : [];
  });
};

export const searchBundleEventInstallations = async <TContext>(
  database: DatabaseAdapter<TContext>,
  query: string,
  limit: number,
  offset: number,
  context?: TContext,
): Promise<OffsetPaginationResult<InstallationSearchRow>> => {
  const where = query.length === 0 ? undefined : identitySearchWhere(query);
  const total = await database.count(
    { model: "bundle_events", where, distinct: ["install_id"] },
    context,
  );
  if (total === 0) {
    return { data: [], pagination: { total, limit, offset } };
  }

  const pageRows = await database.findMany(
    {
      model: "bundle_events",
      where,
      distinctOn: { fields: ["install_id"] },
      orderBy: stableLatestPerInstallOrder,
      limit,
      offset,
    },
    context,
  );
  const latestRows =
    query.length === 0
      ? pageRows
      : await fetchLatestRowsForInstalls(
          database,
          pageRows.map((row) => row.install_id),
          context,
        );
  return {
    data: latestRows.map(toSearchRow),
    pagination: { total, limit, offset },
  };
};
