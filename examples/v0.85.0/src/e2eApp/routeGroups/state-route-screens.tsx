import { crashHistoryCountRouteScreen } from "./crash-history-count-route-screen";
import { launchCrashedBundleRouteScreen } from "./launch-crashed-bundle-route-screen";
import { launchStatusRouteScreen } from "./launch-status-route-screen";
import { runtimeBundleRouteScreen } from "./runtime-bundle-route-screen";
import { runtimeChannelSwitchedRouteScreen } from "./runtime-channel-switched-route-screen";
import { runtimeCurrentChannelRouteScreen } from "./runtime-current-channel-route-screen";
import { runtimeCurrentCohortRouteScreen } from "./runtime-current-cohort-route-screen";
import { runtimeDefaultChannelRouteScreen } from "./runtime-default-channel-route-screen";
import { runtimeInitialCohortRouteScreen } from "./runtime-initial-cohort-route-screen";
import { runtimeLargeAssetRouteScreen } from "./runtime-large-asset-route-screen";
import { runtimeMarkerRouteScreen } from "./runtime-marker-route-screen";
import { updateStoreDownloadPathsRouteScreen } from "./update-store-download-paths-route-screen";
import { updateStoreDownloadedRouteScreen } from "./update-store-downloaded-route-screen";

export const stateRouteScreens = [
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
] as const;
