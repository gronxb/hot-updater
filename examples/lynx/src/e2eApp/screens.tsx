import { useNavigate } from "@tanstack/react-router";

import { NAV_ITEMS, SCREEN_PATHS, styles } from "./e2eStack";
import { useE2eRuntime } from "./runtime-model";

export function ValueScreen({
  testID,
  value,
}: {
  testID: string;
  value: string;
}) {
  return (
    <text id={testID} style={styles.resultText}>
      {value}
    </text>
  );
}

export function ActionScreen({
  testID,
  title,
}: {
  testID: string;
  title: string;
}) {
  const { actions } = useE2eRuntime();
  return (
    <view
      id={testID}
      style={styles.button}
      bindtap={() => void actions[testID]?.()}
    >
      <text style={styles.buttonText}>{title}</text>
    </view>
  );
}

export function ReadyScreen() {
  const navigate = useNavigate();
  return (
    <view>
      <text id="e2e-ready-status" style={styles.resultText}>
        Ready
      </text>
      <text id="ready" style={styles.resultText}>
        Ready
      </text>
      {NAV_ITEMS.map((item) => (
        <view
          key={item.name}
          style={styles.button}
          bindtap={() =>
            void navigate({ to: `/${SCREEN_PATHS[item.name]}` as never })
          }
        >
          <text style={styles.buttonText}>{item.title}</text>
        </view>
      ))}
    </view>
  );
}

export function RuntimeMarkerScreen() {
  const { scenarioMarker } = useE2eRuntime();
  return (
    <ValueScreen testID="runtime-scenario-marker" value={scenarioMarker} />
  );
}

export function LaunchStatusScreen() {
  const { launchStatus } = useE2eRuntime();
  return <ValueScreen testID="launch-status-result" value={launchStatus} />;
}

export function UpdateActionResultScreen() {
  const { updateActionResult } = useE2eRuntime();
  return (
    <ValueScreen testID="update-action-result" value={updateActionResult} />
  );
}

export function ChannelActionResultScreen() {
  const { channelActionResult } = useE2eRuntime();
  return (
    <ValueScreen testID="channel-action-result" value={channelActionResult} />
  );
}

export function CohortActionResultScreen() {
  const { cohortActionResult } = useE2eRuntime();
  return (
    <ValueScreen testID="cohort-action-result" value={cohortActionResult} />
  );
}

export function RuntimeBundleScreen() {
  const { bundleId } = useE2eRuntime();
  return <ValueScreen testID="runtime-bundle-id" value={bundleId} />;
}

export function RuntimeReleaseStateScreen() {
  const { releaseId } = useE2eRuntime();
  return <ValueScreen testID="runtime-release-state" value={releaseId} />;
}

export function RuntimeCurrentChannelScreen() {
  const { currentChannel } = useE2eRuntime();
  return (
    <ValueScreen testID="runtime-current-channel" value={currentChannel} />
  );
}

export function RuntimeDefaultChannelScreen() {
  const { defaultChannel } = useE2eRuntime();
  return (
    <ValueScreen testID="runtime-default-channel" value={defaultChannel} />
  );
}

export function RuntimeChannelSwitchedScreen() {
  const { channelSwitched } = useE2eRuntime();
  return (
    <ValueScreen testID="runtime-channel-switched" value={channelSwitched} />
  );
}

export function RuntimeCurrentCohortScreen() {
  const { currentCohort } = useE2eRuntime();
  return <ValueScreen testID="runtime-current-cohort" value={currentCohort} />;
}

export function RuntimeInitialCohortScreen() {
  return <ValueScreen testID="runtime-initial-cohort" value="1" />;
}

export function CrashHistoryCountScreen() {
  const { crashHistoryCount } = useE2eRuntime();
  return <ValueScreen testID="crash-history-count" value={crashHistoryCount} />;
}

export function CohortInputScreen() {
  const { cohortInput } = useE2eRuntime();
  return <ValueScreen testID="cohort-input" value={cohortInput} />;
}

export function RuntimeChannelInputScreen() {
  const { runtimeChannelInput } = useE2eRuntime();
  return (
    <ValueScreen testID="runtime-channel-input" value={runtimeChannelInput} />
  );
}

export function InstallCurrentChannelUpdateActionScreen() {
  return (
    <ActionScreen
      testID="action-install-current-channel-update"
      title="Install Current"
    />
  );
}

export function InstallFingerprintUpdateActionScreen() {
  return (
    <ActionScreen
      testID="action-install-fingerprint-update"
      title="Install Fingerprint"
    />
  );
}

export function InstallRuntimeChannelUpdateActionScreen() {
  return (
    <ActionScreen
      testID="action-install-runtime-channel-update"
      title="Install Runtime Channel"
    />
  );
}

export function ResetRuntimeChannelActionScreen() {
  return (
    <ActionScreen testID="action-reset-runtime-channel" title="Reset Channel" />
  );
}

export function SetCohortQaActionScreen() {
  return <ActionScreen testID="action-set-cohort-qa" title="Set Cohort QA" />;
}

export function RestoreInitialCohortActionScreen() {
  return (
    <ActionScreen
      testID="action-restore-initial-cohort"
      title="Restore Cohort"
    />
  );
}

export function ApplyCohortInputActionScreen() {
  return (
    <ActionScreen testID="action-apply-cohort-input" title="Apply Cohort" />
  );
}

export function ClearCrashHistoryActionScreen() {
  return (
    <ActionScreen
      testID="action-clear-crash-history"
      title="Clear Crash History"
    />
  );
}

export function ReloadAppActionScreen() {
  return <ActionScreen testID="action-reload-app" title="Reload" />;
}

export function RefreshRuntimeSnapshotActionScreen() {
  return (
    <ActionScreen
      testID="action-refresh-runtime-snapshot"
      title="Refresh Snapshot"
    />
  );
}

export function CaptureCurrentChannelUpdateActionScreen() {
  return (
    <ActionScreen
      testID="action-capture-current-channel-update"
      title="Capture Update"
    />
  );
}

export function ApplyCapturedUpdateActionScreen() {
  return (
    <ActionScreen
      testID="action-apply-captured-update"
      title="Apply Captured"
    />
  );
}
