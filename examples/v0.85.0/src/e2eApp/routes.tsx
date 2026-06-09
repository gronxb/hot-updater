import { type LinkingOptions } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import React from "react";

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
import type { RootStackParamList, ScreenName } from "./types";
import type { E2eRuntimeModel } from "./useE2eRuntime";

const Stack = createNativeStackNavigator<RootStackParamList>();

export const e2eScreenPaths = {
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
} satisfies Record<ScreenName, string>;

export const e2eLinking: LinkingOptions<RootStackParamList> = {
  config: {
    screens: e2eScreenPaths,
  },
  prefixes: ["hotupdaterexample://"],
};

type ModelScreenName = Exclude<ScreenName, "Ready">;

type ModelScreen = {
  readonly name: ModelScreenName;
  readonly render: (model: E2eRuntimeModel) => React.JSX.Element;
};

const modelScreens = [
  {
    name: "RuntimeBundle",
    render: (model) => <RuntimeBundleScreen model={model} />,
  },
  {
    name: "RuntimeMarker",
    render: (model) => <RuntimeMarkerScreen model={model} />,
  },
  {
    name: "RuntimeLargeAsset",
    render: (model) => <RuntimeLargeAssetScreen model={model} />,
  },
  {
    name: "LaunchStatus",
    render: (model) => <LaunchStatusScreen model={model} />,
  },
  {
    name: "LaunchCrashedBundle",
    render: (model) => <LaunchCrashedBundleScreen model={model} />,
  },
  {
    name: "RuntimeChannelSummary",
    render: (model) => <RuntimeChannelSummaryScreen model={model} />,
  },
  {
    name: "RuntimeCohortSummary",
    render: (model) => <RuntimeCohortSummaryScreen model={model} />,
  },
  {
    name: "UpdateStoreDownloaded",
    render: (model) => <UpdateStoreDownloadedScreen model={model} />,
  },
  {
    name: "UpdateStoreDownloadPaths",
    render: (model) => <UpdateStoreDownloadPathsScreen model={model} />,
  },
  {
    name: "CrashHistory",
    render: (model) => <CrashHistoryScreen model={model} />,
  },
  {
    name: "RefreshRuntimeSnapshotAction",
    render: (model) => <RefreshRuntimeSnapshotActionScreen model={model} />,
  },
  {
    name: "ReloadAppAction",
    render: (model) => <ReloadAppActionScreen model={model} />,
  },
  {
    name: "ClearCrashHistoryAction",
    render: (model) => <ClearCrashHistoryActionScreen model={model} />,
  },
  {
    name: "InstallCurrentChannelUpdateAction",
    render: (model) => (
      <InstallCurrentChannelUpdateActionScreen model={model} />
    ),
  },
  {
    name: "RuntimeChannelInput",
    render: (model) => <RuntimeChannelInputScreen model={model} />,
  },
  {
    name: "InstallRuntimeChannelUpdateAction",
    render: (model) => (
      <InstallRuntimeChannelUpdateActionScreen model={model} />
    ),
  },
  {
    name: "ResetRuntimeChannelAction",
    render: (model) => <ResetRuntimeChannelActionScreen model={model} />,
  },
  {
    name: "CohortInput",
    render: (model) => <CohortInputScreen model={model} />,
  },
  {
    name: "ApplyCohortInputAction",
    render: (model) => <ApplyCohortInputActionScreen model={model} />,
  },
  {
    name: "SetCohortQaAction",
    render: (model) => <SetCohortQaActionScreen model={model} />,
  },
  {
    name: "RestoreInitialCohortAction",
    render: (model) => <RestoreInitialCohortActionScreen model={model} />,
  },
  {
    name: "ChannelActionResult",
    render: (model) => <ChannelActionResultScreen model={model} />,
  },
  {
    name: "UpdateActionResult",
    render: (model) => <UpdateActionResultScreen model={model} />,
  },
  {
    name: "CohortActionResult",
    render: (model) => <CohortActionResultScreen model={model} />,
  },
] satisfies readonly ModelScreen[];

export const E2eStack = ({
  model,
}: {
  readonly model: E2eRuntimeModel;
}): React.JSX.Element => (
  <Stack.Navigator
    initialRouteName="Ready"
    screenOptions={{ headerShown: false }}
  >
    <Stack.Screen name="Ready" component={ReadyScreen} />
    {modelScreens.map((screen) => (
      <Stack.Screen key={screen.name} name={screen.name}>
        {() => screen.render(model)}
      </Stack.Screen>
    ))}
  </Stack.Navigator>
);
