import type { InstallationSearchRow, OffsetPaginationResult } from "../domain";
import type { BundleEventPersistenceRow } from "../persistence";
import { compareCodePoints, compareEventNewest } from "./scan";

type InstallationSearchRequest = {
  readonly rows: readonly BundleEventPersistenceRow[];
  readonly query: string;
  readonly limit: number;
  readonly offset: number;
};

function toSearchRow(row: BundleEventPersistenceRow): InstallationSearchRow {
  return {
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
  };
}

function matchesIdentity(
  row: BundleEventPersistenceRow,
  query: string,
): boolean {
  return (
    row.install_id.toLowerCase().includes(query) ||
    row.user_id?.toLowerCase().includes(query) === true ||
    row.username?.toLowerCase().includes(query) === true
  );
}

export function searchEventInstallations(
  request: InstallationSearchRequest,
): OffsetPaginationResult<InstallationSearchRow> {
  const query = request.query.toLowerCase();
  const matchingInstallIds = new Set<string>();
  for (const row of request.rows) {
    if (query.length === 0 || matchesIdentity(row, query)) {
      matchingInstallIds.add(row.install_id);
    }
  }
  const latestByInstall = new Map<string, BundleEventPersistenceRow>();
  for (const row of request.rows) {
    if (!matchingInstallIds.has(row.install_id)) continue;
    const current = latestByInstall.get(row.install_id);
    if (current === undefined || compareEventNewest(row, current) < 0) {
      latestByInstall.set(row.install_id, row);
    }
  }
  const matchingRows = [...latestByInstall.values()].sort((left, right) =>
    compareCodePoints(left.install_id, right.install_id),
  );
  const pageSize = Math.min(Math.max(request.limit, 0), 100);
  const page = matchingRows.slice(request.offset, request.offset + pageSize);
  return {
    data: page.map(toSearchRow),
    pagination: {
      total: matchingRows.length,
      limit: request.limit,
      offset: request.offset,
    },
  };
}
