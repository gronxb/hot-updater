import React from "react";

import { Stack } from "../route-stack";
import { ApplyCohortInputActionScreen } from "../screens/apply-cohort-input-action-screen";
import { ClearCrashHistoryActionScreen } from "../screens/clear-crash-history-action-screen";
import { InstallCurrentChannelUpdateActionScreen } from "../screens/install-current-channel-update-action-screen";
import { InstallRuntimeChannelUpdateActionScreen } from "../screens/install-runtime-channel-update-action-screen";
import { RefreshRuntimeSnapshotActionScreen } from "../screens/refresh-runtime-snapshot-action-screen";
import { ReloadAppActionScreen } from "../screens/reload-app-action-screen";
import { ResetRuntimeChannelActionScreen } from "../screens/reset-runtime-channel-action-screen";
import { RestoreInitialCohortActionScreen } from "../screens/restore-initial-cohort-action-screen";
import { SetCohortQaActionScreen } from "../screens/set-cohort-qa-action-screen";

export const actionRoutes = (
  <>
    <Stack.Screen
      name="ApplyCohortInputAction"
      component={ApplyCohortInputActionScreen}
    />
    <Stack.Screen
      name="ClearCrashHistoryAction"
      component={ClearCrashHistoryActionScreen}
    />
    <Stack.Screen
      name="InstallCurrentChannelUpdateAction"
      component={InstallCurrentChannelUpdateActionScreen}
    />
    <Stack.Screen
      name="InstallRuntimeChannelUpdateAction"
      component={InstallRuntimeChannelUpdateActionScreen}
    />
    <Stack.Screen
      name="RefreshRuntimeSnapshotAction"
      component={RefreshRuntimeSnapshotActionScreen}
    />
    <Stack.Screen name="ReloadAppAction" component={ReloadAppActionScreen} />
    <Stack.Screen
      name="ResetRuntimeChannelAction"
      component={ResetRuntimeChannelActionScreen}
    />
    <Stack.Screen
      name="RestoreInitialCohortAction"
      component={RestoreInitialCohortActionScreen}
    />
    <Stack.Screen
      name="SetCohortQaAction"
      component={SetCohortQaActionScreen}
    />
  </>
);
