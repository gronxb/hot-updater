import React, { type ReactNode } from "react";
import { Pressable, SafeAreaView, Text, View } from "react-native";

import { styles } from "./styles";
import type { ScreenName } from "./types";

const screenContentTestIDs = {
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

export const InfoRow = ({
  label,
  value,
  valueTestID,
}: {
  readonly label: string;
  readonly value: string;
  readonly valueTestID?: string;
}) => (
  <View style={styles.infoRow}>
    <Text style={styles.infoLabel}>{label}</Text>
    <Text selectable style={styles.infoValue} testID={valueTestID}>
      {value}
    </Text>
  </View>
);

export const Section = ({
  children,
  title,
  titleTestID,
}: {
  readonly children: ReactNode;
  readonly title: string;
  readonly titleTestID?: string;
}) => (
  <View style={styles.section}>
    <Text style={styles.sectionTitle} testID={titleTestID}>
      {title}
    </Text>
    {children}
  </View>
);

export const Button = ({
  onPress,
  testID,
  title,
}: {
  readonly onPress: () => Promise<void> | void;
  readonly testID: string;
  readonly title: string;
}) => (
  <Pressable
    accessibilityLabel={title}
    accessibilityRole="button"
    onPress={() => {
      Promise.resolve(onPress()).catch(() => undefined);
    }}
    style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
    testID={testID}
  >
    <Text style={styles.buttonText}>{title}</Text>
  </Pressable>
);

export const ScreenShell = ({
  children,
  current,
}: {
  readonly children: ReactNode;
  readonly current: ScreenName;
}) => (
  <SafeAreaView style={styles.safeArea}>
    <View style={styles.content} testID="e2e-screen-content">
      <View testID={screenContentTestIDs[current]}>{children}</View>
    </View>
  </SafeAreaView>
);
