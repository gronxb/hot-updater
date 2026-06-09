import React from "react";

import { Stack } from "../route-stack";
import { CrashHistoryCountScreen } from "../screens/crash-history-count-screen";
import { LaunchCrashedBundleScreen } from "../screens/launch-crashed-bundle-screen";
import { LaunchStatusScreen } from "../screens/launch-status-screen";

export const launchStateAssertionRouteScreens = [
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
    key="CrashHistoryCount"
    name="CrashHistoryCount"
    component={CrashHistoryCountScreen}
  />,
] as const;
