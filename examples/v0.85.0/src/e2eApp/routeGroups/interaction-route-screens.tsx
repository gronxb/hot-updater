import React from "react";

import { Stack } from "../route-stack";
import { ApplyCohortInputActionScreen } from "../screens/apply-cohort-input-action-screen";
import { ClearCrashHistoryActionScreen } from "../screens/clear-crash-history-action-screen";
import { CohortInputScreen } from "../screens/cohort-input-screen";
import { InstallCurrentChannelUpdateActionScreen } from "../screens/install-current-channel-update-action-screen";
import { InstallRuntimeChannelUpdateActionScreen } from "../screens/install-runtime-channel-update-action-screen";
import { RefreshRuntimeSnapshotActionScreen } from "../screens/refresh-runtime-snapshot-action-screen";
import { ReloadAppActionScreen } from "../screens/reload-app-action-screen";
import { ResetRuntimeChannelActionScreen } from "../screens/reset-runtime-channel-action-screen";
import { RestoreInitialCohortActionScreen } from "../screens/restore-initial-cohort-action-screen";
import { RuntimeChannelInputScreen } from "../screens/runtime-channel-input-screen";
import { SetCohortQaActionScreen } from "../screens/set-cohort-qa-action-screen";

export const interactionRouteScreens = [
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
  <Stack.Screen
    key="InstallCurrentChannelUpdateAction"
    name="InstallCurrentChannelUpdateAction"
    component={InstallCurrentChannelUpdateActionScreen}
  />,
  <Stack.Screen
    key="RuntimeChannelInput"
    name="RuntimeChannelInput"
    component={RuntimeChannelInputScreen}
  />,
  <Stack.Screen
    key="InstallRuntimeChannelUpdateAction"
    name="InstallRuntimeChannelUpdateAction"
    component={InstallRuntimeChannelUpdateActionScreen}
  />,
  <Stack.Screen
    key="ResetRuntimeChannelAction"
    name="ResetRuntimeChannelAction"
    component={ResetRuntimeChannelActionScreen}
  />,
  <Stack.Screen
    key="CohortInput"
    name="CohortInput"
    component={CohortInputScreen}
  />,
  <Stack.Screen
    key="ApplyCohortInputAction"
    name="ApplyCohortInputAction"
    component={ApplyCohortInputActionScreen}
  />,
  <Stack.Screen
    key="SetCohortQaAction"
    name="SetCohortQaAction"
    component={SetCohortQaActionScreen}
  />,
  <Stack.Screen
    key="RestoreInitialCohortAction"
    name="RestoreInitialCohortAction"
    component={RestoreInitialCohortActionScreen}
  />,
] as const;
