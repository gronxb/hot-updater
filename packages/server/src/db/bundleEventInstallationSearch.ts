import type { BundleEventRow, DatabaseWhere } from "@hot-updater/plugin-core";

import { latestInstallOrder, scanBundleEventRows } from "./bundleEventScan";
import type { BundleEventScanScope } from "./bundleEventScan";
import type { InstallationSearchRow, OffsetPaginationResult } from "./types";

type InstallationSearchRequest = {
  readonly query: string;
  readonly limit: number;
  readonly offset: number;
};

type LatestRowsRequest = {
  readonly installIds: readonly string[];
};

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
  scope: BundleEventScanScope<TContext>,
  request: LatestRowsRequest,
): Promise<readonly BundleEventRow[]> => {
  if (request.installIds.length === 0) return [];
  const rowsByInstallId = new Map<string, BundleEventRow>();
  let previousInstallId: string | undefined;
  for await (const row of scanBundleEventRows(scope, {
    where: [{ field: "install_id", operator: "in", value: request.installIds }],
    orderBy: latestInstallOrder,
  })) {
    if (row.install_id === previousInstallId) continue;
    previousInstallId = row.install_id;
    rowsByInstallId.set(row.install_id, row);
  }
  return request.installIds.flatMap((installId) => {
    const row = rowsByInstallId.get(installId);
    return row ? [row] : [];
  });
};

export const searchBundleEventInstallations = async <TContext>(
  scope: BundleEventScanScope<TContext>,
  request: InstallationSearchRequest,
): Promise<OffsetPaginationResult<InstallationSearchRow>> => {
  const where =
    request.query.length === 0 ? undefined : identitySearchWhere(request.query);
  const pageSize = Math.min(Math.max(request.limit, 0), 100);
  const pageInstallIds: string[] = [];
  let previousInstallId: string | undefined;
  let total = 0;
  for await (const row of scanBundleEventRows(scope, {
    where,
    orderBy: latestInstallOrder,
  })) {
    if (row.install_id === previousInstallId) continue;
    previousInstallId = row.install_id;
    if (total >= request.offset && pageInstallIds.length < pageSize) {
      pageInstallIds.push(row.install_id);
    }
    total += 1;
  }
  if (total === 0) {
    return {
      data: [],
      pagination: { total, limit: request.limit, offset: request.offset },
    };
  }
  const latestRows = await fetchLatestRowsForInstalls(scope, {
    installIds: pageInstallIds,
  });
  return {
    data: latestRows.map(toSearchRow),
    pagination: { total, limit: request.limit, offset: request.offset },
  };
};
