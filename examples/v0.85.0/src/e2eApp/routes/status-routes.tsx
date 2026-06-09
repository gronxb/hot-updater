import React from "react";

import { Stack } from "../route-stack";
import { ChannelActionResultScreen } from "../screens/channel-action-result-screen";
import { CohortActionResultScreen } from "../screens/cohort-action-result-screen";
import { CrashHistoryCountScreen } from "../screens/crash-history-count-screen";
import { LaunchCrashedBundleScreen } from "../screens/launch-crashed-bundle-screen";
import { LaunchStatusScreen } from "../screens/launch-status-screen";
import { UpdateActionResultScreen } from "../screens/update-action-result-screen";
import { UpdateStoreDownloadPathsScreen } from "../screens/update-store-download-paths-screen";
import { UpdateStoreDownloadedScreen } from "../screens/update-store-downloaded-screen";

export const statusRoutes = (
  <>
    <Stack.Screen
      name="ChannelActionResult"
      component={ChannelActionResultScreen}
    />
    <Stack.Screen
      name="CohortActionResult"
      component={CohortActionResultScreen}
    />
    <Stack.Screen
      name="CrashHistoryCount"
      component={CrashHistoryCountScreen}
    />
    <Stack.Screen
      name="LaunchCrashedBundle"
      component={LaunchCrashedBundleScreen}
    />
    <Stack.Screen name="LaunchStatus" component={LaunchStatusScreen} />
    <Stack.Screen
      name="UpdateActionResult"
      component={UpdateActionResultScreen}
    />
    <Stack.Screen
      name="UpdateStoreDownloaded"
      component={UpdateStoreDownloadedScreen}
    />
    <Stack.Screen
      name="UpdateStoreDownloadPaths"
      component={UpdateStoreDownloadPathsScreen}
    />
  </>
);
