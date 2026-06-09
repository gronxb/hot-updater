import {
  ChannelActionResultScreen,
  CohortActionResultScreen,
  CrashHistoryScreen,
  LaunchCrashedBundleScreen,
  LaunchStatusScreen,
  RuntimeBundleScreen,
  RuntimeChannelSummaryScreen,
  RuntimeCohortSummaryScreen,
  RuntimeLargeAssetScreen,
  RuntimeMarkerScreen,
  UpdateActionResultScreen,
  UpdateStoreDownloadedScreen,
  UpdateStoreDownloadPathsScreen,
} from "../screens";
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
