import { applyCohortInputActionRouteScreen } from "./apply-cohort-input-action-route-screen";
import { channelActionResultRouteScreen } from "./channel-action-result-route-screen";
import { clearCrashHistoryActionRouteScreen } from "./clear-crash-history-action-route-screen";
import { cohortActionResultRouteScreen } from "./cohort-action-result-route-screen";
import { cohortInputRouteScreen } from "./cohort-input-route-screen";
import { crashHistoryCountRouteScreen } from "./crash-history-count-route-screen";
import { installCurrentChannelUpdateActionRouteScreen } from "./install-current-channel-update-action-route-screen";
import { installRuntimeChannelUpdateActionRouteScreen } from "./install-runtime-channel-update-action-route-screen";
import { launchCrashedBundleRouteScreen } from "./launch-crashed-bundle-route-screen";
import { launchStatusRouteScreen } from "./launch-status-route-screen";
import { refreshRuntimeSnapshotActionRouteScreen } from "./refresh-runtime-snapshot-action-route-screen";
import { reloadAppActionRouteScreen } from "./reload-app-action-route-screen";
import { resetRuntimeChannelActionRouteScreen } from "./reset-runtime-channel-action-route-screen";
import { restoreInitialCohortActionRouteScreen } from "./restore-initial-cohort-action-route-screen";
import { runtimeBundleRouteScreen } from "./runtime-bundle-route-screen";
import { runtimeChannelInputRouteScreen } from "./runtime-channel-input-route-screen";
import { runtimeChannelSwitchedRouteScreen } from "./runtime-channel-switched-route-screen";
import { runtimeCurrentChannelRouteScreen } from "./runtime-current-channel-route-screen";
import { runtimeCurrentCohortRouteScreen } from "./runtime-current-cohort-route-screen";
import { runtimeDefaultChannelRouteScreen } from "./runtime-default-channel-route-screen";
import { runtimeInitialCohortRouteScreen } from "./runtime-initial-cohort-route-screen";
import { runtimeLargeAssetRouteScreen } from "./runtime-large-asset-route-screen";
import { runtimeMarkerRouteScreen } from "./runtime-marker-route-screen";
import { setCohortQaActionRouteScreen } from "./set-cohort-qa-action-route-screen";
import { updateActionResultRouteScreen } from "./update-action-result-route-screen";
import { updateStoreDownloadPathsRouteScreen } from "./update-store-download-paths-route-screen";
import { updateStoreDownloadedRouteScreen } from "./update-store-downloaded-route-screen";

export const routeScreens = [
  runtimeBundleRouteScreen,
  runtimeMarkerRouteScreen,
  runtimeLargeAssetRouteScreen,
  runtimeCurrentChannelRouteScreen,
  runtimeDefaultChannelRouteScreen,
  runtimeChannelSwitchedRouteScreen,
  runtimeCurrentCohortRouteScreen,
  runtimeInitialCohortRouteScreen,
  launchStatusRouteScreen,
  launchCrashedBundleRouteScreen,
  crashHistoryCountRouteScreen,
  updateStoreDownloadedRouteScreen,
  updateStoreDownloadPathsRouteScreen,
  channelActionResultRouteScreen,
  updateActionResultRouteScreen,
  cohortActionResultRouteScreen,
  installCurrentChannelUpdateActionRouteScreen,
  refreshRuntimeSnapshotActionRouteScreen,
  reloadAppActionRouteScreen,
  clearCrashHistoryActionRouteScreen,
  runtimeChannelInputRouteScreen,
  installRuntimeChannelUpdateActionRouteScreen,
  resetRuntimeChannelActionRouteScreen,
  cohortInputRouteScreen,
  applyCohortInputActionRouteScreen,
  setCohortQaActionRouteScreen,
  restoreInitialCohortActionRouteScreen,
] as const;
