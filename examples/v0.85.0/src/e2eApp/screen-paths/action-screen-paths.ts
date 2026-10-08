export const actionScreenPaths = {
  ActivateRemoteConfigAction: "e2e/action/activate-remote-config",
  ApplyCapturedUpdateAction: "e2e/action/apply-captured-update",
  ApplyCohortInputAction: "e2e/action/apply-cohort-input",
  CaptureCurrentChannelUpdateAction:
    "e2e/action/capture-current-channel-update",
  ClearCrashHistoryAction: "e2e/action/clear-crash-history",
  FetchAndActivateRemoteConfigAction:
    "e2e/action/fetch-and-activate-remote-config",
  FetchRemoteConfigAction: "e2e/action/fetch-remote-config",
  InstallCurrentChannelUpdateAction:
    "e2e/action/install-current-channel-update",
  InstallFingerprintUpdateAction: "e2e/action/install-fingerprint-update",
  InstallRuntimeChannelUpdateAction:
    "e2e/action/install-runtime-channel-update",
  RefreshRuntimeSnapshotAction: "e2e/action/refresh-runtime-snapshot",
  ReinitializeHotUpdaterAction: "e2e/action/reinitialize-hot-updater",
  ReloadAppAction: "e2e/action/reload-app",
  ResetRuntimeChannelAction: "e2e/action/reset-runtime-channel",
  RestoreInitialCohortAction: "e2e/action/restore-initial-cohort",
  SetCohortQaAction: "e2e/action/set-cohort-qa",
} as const;
