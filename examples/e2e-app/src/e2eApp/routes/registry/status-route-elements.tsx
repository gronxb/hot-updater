import { crashHistoryCountRoute } from "../crash-history-count-route";
import { launchStatusRoute } from "../launch-status-route";
import { launchTransitionRoute } from "../launch-transition-route";
import { updateDiagnosticsRoute } from "../update-diagnostics-route";

export const statusRouteElements = [
  launchStatusRoute,
  launchTransitionRoute,
  crashHistoryCountRoute,
  updateDiagnosticsRoute,
] as const;
