import type { BundleEventRow, DatabaseWhere } from "@hot-updater/plugin-core";

import { newestEventOrder, scanBundleEventRows } from "./bundleEventScan";
import type { BundleEventScanScope } from "./bundleEventScan";

type RecentBundleEventsRequest = {
  readonly installedWhere: readonly DatabaseWhere<"bundle_events">[];
  readonly recoveredWhere: readonly DatabaseWhere<"bundle_events">[];
  readonly limit: number;
  readonly offset: number;
};

const installedIsNewer = (
  installed: BundleEventRow,
  recovered: BundleEventRow,
): boolean =>
  installed.received_at_ms > recovered.received_at_ms ||
  (installed.received_at_ms === recovered.received_at_ms &&
    installed.id > recovered.id);

export const scanRecentBundleEvents = async <TContext>(
  scope: BundleEventScanScope<TContext>,
  request: RecentBundleEventsRequest,
) => {
  const installed = scanBundleEventRows(scope, {
    where: request.installedWhere,
    orderBy: newestEventOrder,
  })[Symbol.asyncIterator]();
  const recovered = scanBundleEventRows(scope, {
    where: request.recoveredWhere,
    orderBy: newestEventOrder,
  })[Symbol.asyncIterator]();
  let installedNext = await installed.next();
  let recoveredNext = await recovered.next();
  let total = 0;
  const rows: BundleEventRow[] = [];
  while (!installedNext.done || !recoveredNext.done) {
    const takeInstalled =
      recoveredNext.done ||
      (!installedNext.done &&
        installedIsNewer(installedNext.value, recoveredNext.value));
    const row = takeInstalled ? installedNext.value : recoveredNext.value;
    if (total >= request.offset && rows.length < request.limit) rows.push(row);
    total += 1;
    if (takeInstalled) installedNext = await installed.next();
    else recoveredNext = await recovered.next();
  }
  return { rows, total };
};
