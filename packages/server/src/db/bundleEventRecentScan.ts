import type { BundleEventRow } from "@hot-updater/plugin-core";

import { compareBundleEventNewest } from "./bundleEventScan";

type RecentBundleEventsRequest = {
  readonly rows: readonly BundleEventRow[];
  readonly limit: number;
  readonly offset: number;
};

export const collectRecentBundleEvents = (
  request: RecentBundleEventsRequest,
) => {
  const ordered = [...request.rows].sort(compareBundleEventNewest);
  return {
    rows: ordered.slice(request.offset, request.offset + request.limit),
    total: ordered.length,
  };
};
