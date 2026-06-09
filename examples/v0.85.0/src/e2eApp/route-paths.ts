import { type LinkingOptions } from "@react-navigation/native";

import type { RootStackParamList, ScreenName } from "./types";

export const e2eScreenPaths = {
  ApplyCohortInputAction: "e2e/action/apply-cohort-input",
  ChannelActionResult: "e2e/channel-action-result",
  CohortActionResult: "e2e/cohort-action-result",
  CohortInput: "e2e/input/cohort",
  CrashHistoryCount: "e2e/crash-history-count",
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
  RuntimeChannelSwitched: "e2e/runtime-channel-switched",
  RuntimeCurrentChannel: "e2e/runtime-current-channel",
  RuntimeCurrentCohort: "e2e/runtime-current-cohort",
  RuntimeDefaultChannel: "e2e/runtime-default-channel",
  RuntimeInitialCohort: "e2e/runtime-initial-cohort",
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

const e2eScreenNames = Object.keys(e2eScreenPaths) as ScreenName[];

export const screenNameFromE2eUrl = (url: string): ScreenName | undefined => {
  const path = url
    .replace(/^hotupdaterexample:\/\//, "")
    .replace(/^\/+/, "")
    .split(/[?#]/, 1)[0];

  return e2eScreenNames.find(
    (screenName) => e2eScreenPaths[screenName] === path,
  );
};
