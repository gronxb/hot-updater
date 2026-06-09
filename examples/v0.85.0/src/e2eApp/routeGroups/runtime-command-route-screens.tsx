import React from "react";

import { Stack } from "../route-stack";
import { ClearCrashHistoryActionScreen } from "../screens/clear-crash-history-action-screen";
import { RefreshRuntimeSnapshotActionScreen } from "../screens/refresh-runtime-snapshot-action-screen";
import { ReloadAppActionScreen } from "../screens/reload-app-action-screen";

export const runtimeCommandRouteScreens = [
  <Stack.Screen
    key="RefreshRuntimeSnapshotAction"
    name="RefreshRuntimeSnapshotAction"
    component={RefreshRuntimeSnapshotActionScreen}
  />,
  <Stack.Screen
    key="ReloadAppAction"
    name="ReloadAppAction"
    component={ReloadAppActionScreen}
  />,
  <Stack.Screen
    key="ClearCrashHistoryAction"
    name="ClearCrashHistoryAction"
    component={ClearCrashHistoryActionScreen}
  />,
] as const;
