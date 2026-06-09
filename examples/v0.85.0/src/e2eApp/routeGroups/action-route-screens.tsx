import { applyCohortInputActionRouteScreen } from "./apply-cohort-input-action-route-screen";
import { clearCrashHistoryActionRouteScreen } from "./clear-crash-history-action-route-screen";
import { installCurrentChannelUpdateActionRouteScreen } from "./install-current-channel-update-action-route-screen";
import { installRuntimeChannelUpdateActionRouteScreen } from "./install-runtime-channel-update-action-route-screen";
import { refreshRuntimeSnapshotActionRouteScreen } from "./refresh-runtime-snapshot-action-route-screen";
import { reloadAppActionRouteScreen } from "./reload-app-action-route-screen";
import { resetRuntimeChannelActionRouteScreen } from "./reset-runtime-channel-action-route-screen";
import { restoreInitialCohortActionRouteScreen } from "./restore-initial-cohort-action-route-screen";
import { setCohortQaActionRouteScreen } from "./set-cohort-qa-action-route-screen";

export const actionRouteScreens = [
  installCurrentChannelUpdateActionRouteScreen,
  refreshRuntimeSnapshotActionRouteScreen,
  reloadAppActionRouteScreen,
  clearCrashHistoryActionRouteScreen,
  installRuntimeChannelUpdateActionRouteScreen,
  resetRuntimeChannelActionRouteScreen,
  applyCohortInputActionRouteScreen,
  setCohortQaActionRouteScreen,
  restoreInitialCohortActionRouteScreen,
] as const;
