import { crashHistoryCountRoute } from "../crash-history-count-route";
import { launchStatusRoute } from "../launch-status-route";
import { launchTransitionRoute } from "../launch-transition-route";

export const statusRouteElements = [
  launchStatusRoute,
  launchTransitionRoute,
  crashHistoryCountRoute,
] as const;
