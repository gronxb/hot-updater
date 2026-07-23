import type { BundleEventRow } from "@hot-updater/plugin-core";

import { compareBundleEventNewest } from "./bundleEventScan";

type RecentBundleEventsRequest<TRow extends BundleEventRow> = {
  readonly rows: readonly TRow[];
  readonly limit: number;
  readonly offset: number;
};

export const collectRecentBundleEvents = <TRow extends BundleEventRow>(
  request: RecentBundleEventsRequest<TRow>,
) => {
  const ordered = [...request.rows].sort(compareBundleEventNewest);
  return {
    rows: ordered.slice(request.offset, request.offset + request.limit),
    total: ordered.length,
  };
};
