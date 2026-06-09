import React from "react";

import { Stack } from "../route-stack";
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

export const assertionRouteScreens = [
  <Stack.Screen
    key="RuntimeBundle"
    name="RuntimeBundle"
    component={RuntimeBundleScreen}
  />,
  <Stack.Screen
    key="RuntimeMarker"
    name="RuntimeMarker"
    component={RuntimeMarkerScreen}
  />,
  <Stack.Screen
    key="RuntimeLargeAsset"
    name="RuntimeLargeAsset"
    component={RuntimeLargeAssetScreen}
  />,
  <Stack.Screen
    key="LaunchStatus"
    name="LaunchStatus"
    component={LaunchStatusScreen}
  />,
  <Stack.Screen
    key="LaunchCrashedBundle"
    name="LaunchCrashedBundle"
    component={LaunchCrashedBundleScreen}
  />,
  <Stack.Screen
    key="RuntimeChannelSummary"
    name="RuntimeChannelSummary"
    component={RuntimeChannelSummaryScreen}
  />,
  <Stack.Screen
    key="RuntimeCohortSummary"
    name="RuntimeCohortSummary"
    component={RuntimeCohortSummaryScreen}
  />,
  <Stack.Screen
    key="UpdateStoreDownloaded"
    name="UpdateStoreDownloaded"
    component={UpdateStoreDownloadedScreen}
  />,
  <Stack.Screen
    key="UpdateStoreDownloadPaths"
    name="UpdateStoreDownloadPaths"
    component={UpdateStoreDownloadPathsScreen}
  />,
  <Stack.Screen
    key="CrashHistory"
    name="CrashHistory"
    component={CrashHistoryScreen}
  />,
  <Stack.Screen
    key="ChannelActionResult"
    name="ChannelActionResult"
    component={ChannelActionResultScreen}
  />,
  <Stack.Screen
    key="UpdateActionResult"
    name="UpdateActionResult"
    component={UpdateActionResultScreen}
  />,
  <Stack.Screen
    key="CohortActionResult"
    name="CohortActionResult"
    component={CohortActionResultScreen}
  />,
] as const;
