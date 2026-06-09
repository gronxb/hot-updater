import { ChannelActionResultScreen } from "../screens/channel-action-result-screen";
import { CohortActionResultScreen } from "../screens/cohort-action-result-screen";
import { CrashHistoryScreen } from "../screens/crash-history-screen";
import { LaunchCrashedBundleScreen } from "../screens/launch-crashed-bundle-screen";
import { LaunchStatusScreen } from "../screens/launch-status-screen";
import { RuntimeBundleScreen } from "../screens/runtime-bundle-screen";
import { RuntimeChannelSummaryScreen } from "../screens/runtime-channel-summary-screen";
import { RuntimeCohortSummaryScreen } from "../screens/runtime-cohort-summary-screen";
import { RuntimeLargeAssetScreen } from "../screens/runtime-large-asset-screen";
import { RuntimeMarkerScreen } from "../screens/runtime-marker-screen";
import { UpdateActionResultScreen } from "../screens/update-action-result-screen";
import { UpdateStoreDownloadPathsScreen } from "../screens/update-store-download-paths-screen";
import { UpdateStoreDownloadedScreen } from "../screens/update-store-downloaded-screen";
import { defineModelScreens } from "./types";

export const assertionModelScreens = defineModelScreens([
  ["RuntimeBundle", RuntimeBundleScreen],
  ["RuntimeMarker", RuntimeMarkerScreen],
  ["RuntimeLargeAsset", RuntimeLargeAssetScreen],
  ["LaunchStatus", LaunchStatusScreen],
  ["LaunchCrashedBundle", LaunchCrashedBundleScreen],
  ["RuntimeChannelSummary", RuntimeChannelSummaryScreen],
  ["RuntimeCohortSummary", RuntimeCohortSummaryScreen],
  ["UpdateStoreDownloaded", UpdateStoreDownloadedScreen],
  ["UpdateStoreDownloadPaths", UpdateStoreDownloadPathsScreen],
  ["CrashHistory", CrashHistoryScreen],
  ["ChannelActionResult", ChannelActionResultScreen],
  ["UpdateActionResult", UpdateActionResultScreen],
  ["CohortActionResult", CohortActionResultScreen],
]);
