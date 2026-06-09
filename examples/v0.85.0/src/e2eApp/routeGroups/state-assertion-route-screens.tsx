import React from "react";

import { Stack } from "../route-stack";
import { CrashHistoryScreen } from "../screens/crash-history-screen";
import { LaunchCrashedBundleScreen } from "../screens/launch-crashed-bundle-screen";
import { LaunchStatusScreen } from "../screens/launch-status-screen";
import { UpdateStoreDownloadPathsScreen } from "../screens/update-store-download-paths-screen";
import { UpdateStoreDownloadedScreen } from "../screens/update-store-downloaded-screen";

export const stateAssertionRouteScreens = [
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
] as const;
