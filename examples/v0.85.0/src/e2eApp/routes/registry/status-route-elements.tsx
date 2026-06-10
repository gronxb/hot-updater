import { crashHistoryCountRoute } from "../crash-history-count-route";
import { launchCrashedBundleRoute } from "../launch-crashed-bundle-route";
import { launchStatusRoute } from "../launch-status-route";

export const statusRouteElements = [
  launchStatusRoute,
  launchCrashedBundleRoute,
  crashHistoryCountRoute,
] as const;
