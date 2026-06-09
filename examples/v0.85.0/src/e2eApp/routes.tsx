import React from "react";

import { Stack } from "./route-stack";
import { ApplyCohortInputActionScreen } from "./screens/apply-cohort-input-action-screen";
import { ChannelActionResultScreen } from "./screens/channel-action-result-screen";
import { ClearCrashHistoryActionScreen } from "./screens/clear-crash-history-action-screen";
import { CohortActionResultScreen } from "./screens/cohort-action-result-screen";
import { CohortInputScreen } from "./screens/cohort-input-screen";
import { CrashHistoryCountScreen } from "./screens/crash-history-count-screen";
import { InstallCurrentChannelUpdateActionScreen } from "./screens/install-current-channel-update-action-screen";
import { InstallRuntimeChannelUpdateActionScreen } from "./screens/install-runtime-channel-update-action-screen";
import { LaunchCrashedBundleScreen } from "./screens/launch-crashed-bundle-screen";
import { LaunchStatusScreen } from "./screens/launch-status-screen";
import { ReadyScreen } from "./screens/ready-screen";
import { RefreshRuntimeSnapshotActionScreen } from "./screens/refresh-runtime-snapshot-action-screen";
import { ReloadAppActionScreen } from "./screens/reload-app-action-screen";
import { ResetRuntimeChannelActionScreen } from "./screens/reset-runtime-channel-action-screen";
import { RestoreInitialCohortActionScreen } from "./screens/restore-initial-cohort-action-screen";
import { RuntimeBundleScreen } from "./screens/runtime-bundle-screen";
import { RuntimeChannelInputScreen } from "./screens/runtime-channel-input-screen";
import { RuntimeChannelSwitchedScreen } from "./screens/runtime-channel-switched-screen";
import { RuntimeCurrentChannelScreen } from "./screens/runtime-current-channel-screen";
import { RuntimeCurrentCohortScreen } from "./screens/runtime-current-cohort-screen";
import { RuntimeDefaultChannelScreen } from "./screens/runtime-default-channel-screen";
import { RuntimeInitialCohortScreen } from "./screens/runtime-initial-cohort-screen";
import { RuntimeLargeAssetScreen } from "./screens/runtime-large-asset-screen";
import { RuntimeMarkerScreen } from "./screens/runtime-marker-screen";
import { SetCohortQaActionScreen } from "./screens/set-cohort-qa-action-screen";
import { UpdateActionResultScreen } from "./screens/update-action-result-screen";
import { UpdateStoreDownloadPathsScreen } from "./screens/update-store-download-paths-screen";
import { UpdateStoreDownloadedScreen } from "./screens/update-store-downloaded-screen";

export const E2eStack = (): React.JSX.Element => (
  <Stack.Navigator
    initialRouteName="Ready"
    screenOptions={{ headerShown: false }}
  >
    <Stack.Screen name="Ready" component={ReadyScreen} />
    <Stack.Screen
      name="ApplyCohortInputAction"
      component={ApplyCohortInputActionScreen}
    />
    <Stack.Screen
      name="ChannelActionResult"
      component={ChannelActionResultScreen}
    />
    <Stack.Screen
      name="ClearCrashHistoryAction"
      component={ClearCrashHistoryActionScreen}
    />
    <Stack.Screen
      name="CohortActionResult"
      component={CohortActionResultScreen}
    />
    <Stack.Screen name="CohortInput" component={CohortInputScreen} />
    <Stack.Screen
      name="CrashHistoryCount"
      component={CrashHistoryCountScreen}
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
      name="LaunchCrashedBundle"
      component={LaunchCrashedBundleScreen}
    />
    <Stack.Screen name="LaunchStatus" component={LaunchStatusScreen} />
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
    <Stack.Screen name="RuntimeBundle" component={RuntimeBundleScreen} />
    <Stack.Screen
      name="RuntimeChannelInput"
      component={RuntimeChannelInputScreen}
    />
    <Stack.Screen
      name="RuntimeChannelSwitched"
      component={RuntimeChannelSwitchedScreen}
    />
    <Stack.Screen
      name="RuntimeCurrentChannel"
      component={RuntimeCurrentChannelScreen}
    />
    <Stack.Screen
      name="RuntimeCurrentCohort"
      component={RuntimeCurrentCohortScreen}
    />
    <Stack.Screen
      name="RuntimeDefaultChannel"
      component={RuntimeDefaultChannelScreen}
    />
    <Stack.Screen
      name="RuntimeInitialCohort"
      component={RuntimeInitialCohortScreen}
    />
    <Stack.Screen
      name="RuntimeLargeAsset"
      component={RuntimeLargeAssetScreen}
    />
    <Stack.Screen name="RuntimeMarker" component={RuntimeMarkerScreen} />
    <Stack.Screen
      name="SetCohortQaAction"
      component={SetCohortQaActionScreen}
    />
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
  </Stack.Navigator>
);
