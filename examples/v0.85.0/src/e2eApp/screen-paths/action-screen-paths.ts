export const actionScreenPaths = {
  ApplyCohortInputAction: "e2e/action/apply-cohort-input",
  ClearCrashHistoryAction: "e2e/action/clear-crash-history",
  InstallCurrentChannelUpdateAction:
    "e2e/action/install-current-channel-update",
  InstallRuntimeChannelUpdateAction:
    "e2e/action/install-runtime-channel-update",
  RefreshRuntimeSnapshotAction: "e2e/action/refresh-runtime-snapshot",
  ReloadAppAction: "e2e/action/reload-app",
  ResetRuntimeChannelAction: "e2e/action/reset-runtime-channel",
  RestoreInitialCohortAction: "e2e/action/restore-initial-cohort",
  SetCohortQaAction: "e2e/action/set-cohort-qa",
} as const;
