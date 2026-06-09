import {
  NavigationContainer,
  type LinkingOptions,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import React from "react";
import { SafeAreaView, Text } from "react-native";
import { enableScreens } from "react-native-screens";

import {
  ApplyCohortInputActionScreen,
  ChannelActionResultScreen,
  CohortActionResultScreen,
  CohortInputScreen,
  CrashHistoryScreen,
  ClearCrashHistoryActionScreen,
  InstallCurrentChannelUpdateActionScreen,
  InstallRuntimeChannelUpdateActionScreen,
  LaunchCrashedBundleScreen,
  LaunchStatusScreen,
  ReadyScreen,
  RuntimeBundleScreen,
  RuntimeChannelInputScreen,
  RuntimeChannelSummaryScreen,
  RuntimeCohortSummaryScreen,
  RuntimeLargeAssetScreen,
  RuntimeMarkerScreen,
  RefreshRuntimeSnapshotActionScreen,
  ReloadAppActionScreen,
  ResetRuntimeChannelActionScreen,
  RestoreInitialCohortActionScreen,
  SetCohortQaActionScreen,
  UpdateActionResultScreen,
  UpdateStoreDownloadedScreen,
  UpdateStoreDownloadPathsScreen,
} from "./screens";
import { styles } from "./styles";
import type { RootStackParamList } from "./types";
import { useE2eRuntimeModel } from "./useE2eRuntime";

enableScreens();

const Stack = createNativeStackNavigator<RootStackParamList>();

const e2eLinking: LinkingOptions<RootStackParamList> = {
  config: {
    screens: {
      ApplyCohortInputAction: "e2e/action/apply-cohort-input",
      ChannelActionResult: "e2e/channel-action-result",
      CohortActionResult: "e2e/cohort-action-result",
      CohortInput: "e2e/input/cohort",
      CrashHistory: "e2e/crash-history",
      ClearCrashHistoryAction: "e2e/action/clear-crash-history",
      InstallCurrentChannelUpdateAction:
        "e2e/action/install-current-channel-update",
      InstallRuntimeChannelUpdateAction:
        "e2e/action/install-runtime-channel-update",
      LaunchCrashedBundle: "e2e/launch-crashed-bundle",
      LaunchStatus: "e2e/launch-status",
      Ready: "e2e/ready",
      RuntimeBundle: "e2e/runtime-bundle",
      RuntimeChannelInput: "e2e/input/runtime-channel",
      RuntimeChannelSummary: "e2e/runtime-channel-summary",
      RuntimeCohortSummary: "e2e/runtime-cohort-summary",
      RuntimeLargeAsset: "e2e/runtime-large-asset",
      RuntimeMarker: "e2e/runtime-marker",
      RefreshRuntimeSnapshotAction: "e2e/action/refresh-runtime-snapshot",
      ReloadAppAction: "e2e/action/reload-app",
      ResetRuntimeChannelAction: "e2e/action/reset-runtime-channel",
      RestoreInitialCohortAction: "e2e/action/restore-initial-cohort",
      SetCohortQaAction: "e2e/action/set-cohort-qa",
      UpdateActionResult: "e2e/update-action-result",
      UpdateStoreDownloaded: "e2e/update-store-downloaded",
      UpdateStoreDownloadPaths: "e2e/update-store-download-paths",
    },
  },
  prefixes: ["hotupdaterexample://"],
};

export const E2eHotUpdaterApp = ({
  scenarioMarker,
}: {
  readonly scenarioMarker: string;
}): React.JSX.Element => {
  const model = useE2eRuntimeModel(scenarioMarker);

  return (
    <NavigationContainer
      fallback={
        <SafeAreaView style={styles.safeArea}>
          <Text style={styles.description} testID="e2e-navigation-loading">
            Loading
          </Text>
        </SafeAreaView>
      }
      linking={e2eLinking}
    >
      <Stack.Navigator
        initialRouteName="Ready"
        screenOptions={{ headerShown: false }}
      >
        <Stack.Screen name="Ready" component={ReadyScreen} />
        <Stack.Screen name="RuntimeBundle">
          {() => <RuntimeBundleScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="RuntimeMarker">
          {() => <RuntimeMarkerScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="RuntimeLargeAsset">
          {() => <RuntimeLargeAssetScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="LaunchStatus">
          {() => <LaunchStatusScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="LaunchCrashedBundle">
          {() => <LaunchCrashedBundleScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="RuntimeChannelSummary">
          {() => <RuntimeChannelSummaryScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="RuntimeCohortSummary">
          {() => <RuntimeCohortSummaryScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="UpdateStoreDownloaded">
          {() => <UpdateStoreDownloadedScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="UpdateStoreDownloadPaths">
          {() => <UpdateStoreDownloadPathsScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="CrashHistory">
          {() => <CrashHistoryScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="RefreshRuntimeSnapshotAction">
          {() => <RefreshRuntimeSnapshotActionScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="ReloadAppAction">
          {() => <ReloadAppActionScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="ClearCrashHistoryAction">
          {() => <ClearCrashHistoryActionScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="InstallCurrentChannelUpdateAction">
          {() => <InstallCurrentChannelUpdateActionScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="RuntimeChannelInput">
          {() => <RuntimeChannelInputScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="InstallRuntimeChannelUpdateAction">
          {() => <InstallRuntimeChannelUpdateActionScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="ResetRuntimeChannelAction">
          {() => <ResetRuntimeChannelActionScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="CohortInput">
          {() => <CohortInputScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="ApplyCohortInputAction">
          {() => <ApplyCohortInputActionScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="SetCohortQaAction">
          {() => <SetCohortQaActionScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="RestoreInitialCohortAction">
          {() => <RestoreInitialCohortActionScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="ChannelActionResult">
          {() => <ChannelActionResultScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="UpdateActionResult">
          {() => <UpdateActionResultScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="CohortActionResult">
          {() => <CohortActionResultScreen model={model} />}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
};
