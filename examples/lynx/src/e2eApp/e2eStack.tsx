/** Mirrors examples/v0.85.0/src/e2eApp screen paths with a Lynx stack. */

export const styles = {
  root: {
    width: "100%",
    height: "100%",
    backgroundColor: "#ffffff",
  },
  content: {
    padding: "18px",
    width: "100%",
  },
  button: {
    alignItems: "center",
    backgroundColor: "#155e75",
    borderRadius: "8px",
    justifyContent: "center",
    marginTop: "10px",
    minHeight: "40px",
    paddingLeft: "12px",
    paddingRight: "12px",
    paddingTop: "10px",
    paddingBottom: "10px",
  },
  buttonText: {
    color: "#ffffff",
    fontSize: "13px",
    fontWeight: "700" as const,
    textAlign: "center" as const,
  },
  resultText: {
    color: "#1f2937",
    fontSize: "13px",
    fontWeight: "600" as const,
    lineHeight: "19px",
    marginTop: "8px",
  },
  back: {
    color: "#155e75",
    fontSize: "13px",
    fontWeight: "700" as const,
    marginBottom: "12px",
  },
};

export type ScreenName =
  | "Ready"
  | "RuntimeBundle"
  | "RuntimeChannelSwitched"
  | "RuntimeCurrentChannel"
  | "RuntimeCurrentCohort"
  | "RuntimeDefaultChannel"
  | "RuntimeInitialCohort"
  | "RuntimeMarker"
  | "RuntimeReleaseState"
  | "CrashHistoryCount"
  | "LaunchStatus"
  | "ChannelActionResult"
  | "CohortActionResult"
  | "UpdateActionResult"
  | "CohortInput"
  | "RuntimeChannelInput"
  | "ApplyCapturedUpdateAction"
  | "ApplyCohortInputAction"
  | "CaptureCurrentChannelUpdateAction"
  | "ClearCrashHistoryAction"
  | "InstallCurrentChannelUpdateAction"
  | "InstallFingerprintUpdateAction"
  | "InstallRuntimeChannelUpdateAction"
  | "RefreshRuntimeSnapshotAction"
  | "ReloadAppAction"
  | "ResetRuntimeChannelAction"
  | "RestoreInitialCohortAction"
  | "SetCohortQaAction";

export const SCREEN_PATHS: Record<ScreenName, string> = {
  Ready: "e2e/ready",
  RuntimeBundle: "e2e/runtime-bundle",
  RuntimeChannelSwitched: "e2e/runtime-channel-switched",
  RuntimeCurrentChannel: "e2e/runtime-current-channel",
  RuntimeCurrentCohort: "e2e/runtime-current-cohort",
  RuntimeDefaultChannel: "e2e/runtime-default-channel",
  RuntimeInitialCohort: "e2e/runtime-initial-cohort",
  RuntimeMarker: "e2e/runtime-marker",
  RuntimeReleaseState: "e2e/runtime-release-state",
  CrashHistoryCount: "e2e/crash-history-count",
  LaunchStatus: "e2e/launch-status",
  ChannelActionResult: "e2e/channel-action-result",
  CohortActionResult: "e2e/cohort-action-result",
  UpdateActionResult: "e2e/update-action-result",
  CohortInput: "e2e/input/cohort",
  RuntimeChannelInput: "e2e/input/runtime-channel",
  ApplyCapturedUpdateAction: "e2e/action/apply-captured-update",
  ApplyCohortInputAction: "e2e/action/apply-cohort-input",
  CaptureCurrentChannelUpdateAction:
    "e2e/action/capture-current-channel-update",
  ClearCrashHistoryAction: "e2e/action/clear-crash-history",
  InstallCurrentChannelUpdateAction:
    "e2e/action/install-current-channel-update",
  InstallFingerprintUpdateAction: "e2e/action/install-fingerprint-update",
  InstallRuntimeChannelUpdateAction:
    "e2e/action/install-runtime-channel-update",
  RefreshRuntimeSnapshotAction: "e2e/action/refresh-runtime-snapshot",
  ReloadAppAction: "e2e/action/reload-app",
  ResetRuntimeChannelAction: "e2e/action/reset-runtime-channel",
  RestoreInitialCohortAction: "e2e/action/restore-initial-cohort",
  SetCohortQaAction: "e2e/action/set-cohort-qa",
};

export const TEST_ID_TO_SCREEN: Record<string, ScreenName> = {
  ready: "Ready",
  "e2e-ready-status": "Ready",
  "runtime-bundle-id": "RuntimeBundle",
  "runtime-channel-switched": "RuntimeChannelSwitched",
  "runtime-current-channel": "RuntimeCurrentChannel",
  "runtime-current-cohort": "RuntimeCurrentCohort",
  "runtime-default-channel": "RuntimeDefaultChannel",
  "runtime-initial-cohort": "RuntimeInitialCohort",
  "runtime-scenario-marker": "RuntimeMarker",
  "runtime-release-state": "RuntimeReleaseState",
  "crash-history-count": "CrashHistoryCount",
  "launch-status-result": "LaunchStatus",
  "channel-action-result": "ChannelActionResult",
  "cohort-action-result": "CohortActionResult",
  "update-action-result": "UpdateActionResult",
  "cohort-input": "CohortInput",
  "runtime-channel-input": "RuntimeChannelInput",
  "action-apply-captured-update": "ApplyCapturedUpdateAction",
  "action-apply-cohort-input": "ApplyCohortInputAction",
  "action-capture-current-channel-update": "CaptureCurrentChannelUpdateAction",
  "action-clear-crash-history": "ClearCrashHistoryAction",
  "action-install-current-channel-update": "InstallCurrentChannelUpdateAction",
  "action-install-fingerprint-update": "InstallFingerprintUpdateAction",
  "action-install-runtime-channel-update": "InstallRuntimeChannelUpdateAction",
  "action-refresh-runtime-snapshot": "RefreshRuntimeSnapshotAction",
  "action-reload-app": "ReloadAppAction",
  "action-reset-runtime-channel": "ResetRuntimeChannelAction",
  "action-restore-initial-cohort": "RestoreInitialCohortAction",
  "action-set-cohort-qa": "SetCohortQaAction",
};

export const NAV_ITEMS: { name: ScreenName; title: string }[] = [
  { name: "RuntimeMarker", title: "Runtime marker" },
  { name: "LaunchStatus", title: "Launch status" },
  { name: "UpdateActionResult", title: "Update result" },
  { name: "ChannelActionResult", title: "Channel result" },
  { name: "CohortActionResult", title: "Cohort result" },
  { name: "RuntimeCurrentChannel", title: "Current channel" },
  { name: "RuntimeDefaultChannel", title: "Default channel" },
  { name: "InstallCurrentChannelUpdateAction", title: "Install current" },
  { name: "InstallFingerprintUpdateAction", title: "Install fingerprint" },
  {
    name: "InstallRuntimeChannelUpdateAction",
    title: "Install runtime channel",
  },
  { name: "ResetRuntimeChannelAction", title: "Reset channel" },
  { name: "SetCohortQaAction", title: "Set cohort qa" },
  { name: "ReloadAppAction", title: "Reload" },
];
