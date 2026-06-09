import React, { type ReactNode } from "react";
import { Pressable, SafeAreaView, Text, View } from "react-native";

import { styles } from "./styles";
import type { ScreenName } from "./types";

const screenContentTestIDs = {
  ActionResults: "e2e-screen-action-results",
  CohortInputActions: "e2e-screen-cohort-input-actions",
  CohortPresetActions: "e2e-screen-cohort-preset-actions",
  CrashHistory: "e2e-screen-crash-history",
  InstallActions: "e2e-screen-install-actions",
  LaunchStatus: "e2e-screen-launch-status",
  RuntimeChannelActions: "e2e-screen-runtime-channel-actions",
  RuntimeIdentity: "e2e-screen-runtime-identity",
  RuntimeState: "e2e-screen-runtime-state",
  UpdateStore: "e2e-screen-update-store",
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
