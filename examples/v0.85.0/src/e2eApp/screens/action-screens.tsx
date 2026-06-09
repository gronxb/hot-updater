import React from "react";

import { Button, ScreenShell, Section } from "../components";
import type { ScreenProps } from "./types";

type ActionButtonScreenProps = {
  readonly current:
    | "ApplyCohortInputAction"
    | "ClearCrashHistoryAction"
    | "InstallCurrentChannelUpdateAction"
    | "InstallRuntimeChannelUpdateAction"
    | "RefreshRuntimeSnapshotAction"
    | "ReloadAppAction"
    | "ResetRuntimeChannelAction"
    | "RestoreInitialCohortAction"
    | "SetCohortQaAction";
  readonly onPress: () => Promise<void> | void;
  readonly testID: string;
  readonly title: string;
};

const ActionButtonScreen = ({
  current,
  onPress,
  testID,
  title,
}: ActionButtonScreenProps) => (
  <ScreenShell current={current}>
    <Section title={title}>
      <Button onPress={onPress} testID={testID} title={title} />
    </Section>
  </ScreenShell>
);

export const RefreshRuntimeSnapshotActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="RefreshRuntimeSnapshotAction"
    onPress={model.refreshRuntimeSnapshot}
    testID="action-refresh-runtime-snapshot"
    title="Refresh"
  />
);

export const ReloadAppActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="ReloadAppAction"
    onPress={model.reloadApp}
    testID="action-reload-app"
    title="Reload"
  />
);

export const ClearCrashHistoryActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="ClearCrashHistoryAction"
    onPress={model.clearCrashHistory}
    testID="action-clear-crash-history"
    title="Clear Crashes"
  />
);

export const InstallCurrentChannelUpdateActionScreen = ({
  model,
}: ScreenProps) => (
  <ActionButtonScreen
    current="InstallCurrentChannelUpdateAction"
    onPress={() => model.installUpdate({ actionLabel: "current-channel" })}
    testID="action-install-current-channel-update"
    title="Install Current"
  />
);

export const InstallRuntimeChannelUpdateActionScreen = ({
  model,
}: ScreenProps) => (
  <ActionButtonScreen
    current="InstallRuntimeChannelUpdateAction"
    onPress={model.installRuntimeChannelUpdate}
    testID="action-install-runtime-channel-update"
    title="Install Runtime"
  />
);

export const ResetRuntimeChannelActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="ResetRuntimeChannelAction"
    onPress={model.resetRuntimeChannel}
    testID="action-reset-runtime-channel"
    title="Reset Channel"
  />
);

export const ApplyCohortInputActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="ApplyCohortInputAction"
    onPress={model.applyCohortInput}
    testID="action-apply-cohort-input"
    title="Apply Cohort"
  />
);

export const SetCohortQaActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="SetCohortQaAction"
    onPress={model.setCohortToQa}
    testID="action-set-cohort-qa"
    title="Set qa"
  />
);

export const RestoreInitialCohortActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="RestoreInitialCohortAction"
    onPress={model.restoreInitialCohort}
    testID="action-restore-initial-cohort"
    title="Restore Cohort"
  />
);
