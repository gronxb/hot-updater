import type { ScreenName } from "./types";

export const screenContentTestIDs = {
  ApplyCohortInputAction: "e2e-screen-action-apply-cohort-input",
  ChannelActionResult: "e2e-screen-channel-action-result",
  CohortActionResult: "e2e-screen-cohort-action-result",
  CohortInput: "e2e-screen-input-cohort",
  CrashHistory: "e2e-screen-crash-history",
  ClearCrashHistoryAction: "e2e-screen-action-clear-crash-history",
  InstallCurrentChannelUpdateAction:
    "e2e-screen-action-install-current-channel-update",
  InstallRuntimeChannelUpdateAction:
    "e2e-screen-action-install-runtime-channel-update",
  LaunchCrashedBundle: "e2e-screen-launch-crashed-bundle",
  LaunchStatus: "e2e-screen-launch-status",
  Ready: "e2e-screen-ready",
  RuntimeBundle: "e2e-screen-runtime-bundle",
  RuntimeChannelInput: "e2e-screen-input-runtime-channel",
  RuntimeChannelSummary: "e2e-screen-runtime-channel-summary",
  RuntimeCohortSummary: "e2e-screen-runtime-cohort-summary",
  RuntimeLargeAsset: "e2e-screen-runtime-large-asset",
  RuntimeMarker: "e2e-screen-runtime-marker",
  RefreshRuntimeSnapshotAction: "e2e-screen-action-refresh-runtime-snapshot",
  ReloadAppAction: "e2e-screen-action-reload-app",
  ResetRuntimeChannelAction: "e2e-screen-action-reset-runtime-channel",
  RestoreInitialCohortAction: "e2e-screen-action-restore-initial-cohort",
  SetCohortQaAction: "e2e-screen-action-set-cohort-qa",
  UpdateActionResult: "e2e-screen-update-action-result",
  UpdateStoreDownloaded: "e2e-screen-update-store-downloaded",
  UpdateStoreDownloadPaths: "e2e-screen-update-store-download-paths",
} satisfies Record<ScreenName, string>;
