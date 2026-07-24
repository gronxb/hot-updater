import type { DatabaseRow } from "@hot-updater/plugin-core";

import type {
  InstallationSearchRow,
  OffsetPaginationResult,
} from "../../domain";
import { compareCodePoints, compareEventNewest } from "./scan";

type BundleEventRow = DatabaseRow<"bundle_events">;

type InstallationSearchRequest = {
  readonly rows: readonly BundleEventRow[];
  readonly query: string;
  readonly limit: number;
  readonly offset: number;
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

const matchesIdentity = (row: BundleEventRow, query: string): boolean =>
  row.install_id.toLowerCase().includes(query) ||
  row.user_id?.toLowerCase().includes(query) === true ||
  row.username?.toLowerCase().includes(query) === true;

export const searchEventInstallations = (
  request: InstallationSearchRequest,
): OffsetPaginationResult<InstallationSearchRow> => {
  const query = request.query.toLowerCase();
  const matchingInstallIds = new Set<string>();
  for (const row of request.rows) {
    if (query.length === 0 || matchesIdentity(row, query)) {
      matchingInstallIds.add(row.install_id);
    }
  }
  const latestByInstall = new Map<string, BundleEventRow>();
  for (const row of request.rows) {
    if (!matchingInstallIds.has(row.install_id)) continue;
    const current = latestByInstall.get(row.install_id);
    if (!current || compareEventNewest(row, current) < 0) {
      latestByInstall.set(row.install_id, row);
    }
  }
  const installIds = [...matchingInstallIds].sort(compareCodePoints);
  const pageSize = Math.min(Math.max(request.limit, 0), 100);
  const page = installIds.slice(request.offset, request.offset + pageSize);
  return {
    data: page.flatMap((installId) => {
      const row = latestByInstall.get(installId);
      return row ? [toSearchRow(row)] : [];
    }),
    pagination: {
      total: installIds.length,
      limit: request.limit,
      offset: request.offset,
    },
  };
};
