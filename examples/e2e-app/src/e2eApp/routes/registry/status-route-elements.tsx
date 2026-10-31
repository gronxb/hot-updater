import { crashHistoryCountRoute } from "../crash-history-count-route";
import { launchStatusRoute } from "../launch-status-route";
import { launchTransitionRoute } from "../launch-transition-route";
import { updateDiagnosticsRouteElements } from "./update-diagnostics-route-elements";

export const statusRouteElements = [
  launchStatusRoute,
  launchTransitionRoute,
  crashHistoryCountRoute,
  ...updateDiagnosticsRouteElements,
] as const;
