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
import type { ScreenName } from "./types";
import type { E2eRuntimeModel } from "./useE2eRuntime";

type ModelScreenName = Exclude<ScreenName, "Ready">;

type ModelScreen = {
  readonly name: ModelScreenName;
  readonly render: (model: E2eRuntimeModel) => React.JSX.Element;
};

export const modelScreens = [
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
