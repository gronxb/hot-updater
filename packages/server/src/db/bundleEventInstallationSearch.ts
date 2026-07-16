import type { BundleEventRow, DatabaseWhere } from "@hot-updater/plugin-core";

import { latestInstallOrder, scanBundleEventRows } from "./bundleEventScan";
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

const identitySearchWhere = (
  query: string,
): readonly DatabaseWhere<"bundle_events">[] => [
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
];

const fetchLatestRowsForInstalls = async <TContext>(
  database: DatabaseAdapter<TContext>,
  installIds: readonly string[],
  context?: TContext,
): Promise<readonly BundleEventRow[]> => {
  if (installIds.length === 0) return [];
  const rowsByInstallId = new Map<string, BundleEventRow>();
  let previousInstallId: string | undefined;
  for await (const row of scanBundleEventRows(
    database,
    {
      where: [{ field: "install_id", operator: "in", value: installIds }],
      orderBy: latestInstallOrder,
    },
    context,
  )) {
    if (row.install_id === previousInstallId) continue;
    previousInstallId = row.install_id;
    rowsByInstallId.set(row.install_id, row);
  }
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
  const pageSize = Math.min(Math.max(limit, 0), 100);
  const pageInstallIds: string[] = [];
  let previousInstallId: string | undefined;
  let total = 0;
  for await (const row of scanBundleEventRows(
    database,
    { where, orderBy: latestInstallOrder },
    context,
  )) {
    if (row.install_id === previousInstallId) continue;
    previousInstallId = row.install_id;
    if (total >= offset && pageInstallIds.length < pageSize) {
      pageInstallIds.push(row.install_id);
    }
    total += 1;
  }
  if (total === 0) {
    return { data: [], pagination: { total, limit, offset } };
  }
  const latestRows = await fetchLatestRowsForInstalls(
    database,
    pageInstallIds,
    context,
  );
  return {
    data: latestRows.map(toSearchRow),
    pagination: { total, limit, offset },
  };
};
