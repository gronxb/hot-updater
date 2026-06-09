import React, { type ReactNode } from "react";
import { Pressable, SafeAreaView, Text, View } from "react-native";

import { styles } from "./styles";
import type { ScreenName, ScreenNavigation } from "./types";

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
  compact = false,
  onPress,
  testID,
  title,
}: {
  readonly compact?: boolean;
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
    style={({ pressed }) => [
      styles.button,
      compact && styles.navButton,
      pressed && styles.buttonPressed,
    ]}
    testID={testID}
  >
    <Text style={[styles.buttonText, compact && styles.navButtonText]}>
      {title}
    </Text>
  </Pressable>
);

export const ScreenTabs = ({
  current,
  navigation,
}: {
  readonly current: ScreenName;
  readonly navigation: ScreenNavigation;
}) => {
  const goTo = (screen: ScreenName) => () => navigation.navigate(screen);

  return (
    <View style={styles.navBar}>
      <Button
        compact
        onPress={goTo("RuntimeIdentity")}
        testID="e2e-nav-runtime-identity"
        title="ID"
      />
      <Button
        compact
        onPress={goTo("LaunchStatus")}
        testID="e2e-nav-launch-status"
        title="Launch"
      />
      <Button
        compact
        onPress={goTo("RuntimeState")}
        testID="e2e-nav-runtime-state"
        title="State"
      />
      <Button
        compact
        onPress={goTo("UpdateStore")}
        testID="e2e-nav-update-store"
        title="Store"
      />
      <Button
        compact
        onPress={goTo("CrashHistory")}
        testID="e2e-nav-crash-history"
        title="Crashes"
      />
      <Button
        compact
        onPress={goTo("InstallActions")}
        testID="e2e-nav-install-actions"
        title="Install"
      />
      <Button
        compact
        onPress={goTo("RuntimeChannelActions")}
        testID="e2e-nav-runtime-channel-actions"
        title="Channel"
      />
      <Button
        compact
        onPress={goTo("CohortInputActions")}
        testID="e2e-nav-cohort-input-actions"
        title="Cohort"
      />
      <Button
        compact
        onPress={goTo("CohortPresetActions")}
        testID="e2e-nav-cohort-preset-actions"
        title="Preset"
      />
      <Button
        compact
        onPress={goTo("ActionResults")}
        testID="e2e-nav-action-results"
        title="Results"
      />
      <Text style={styles.activeScreenLabel} testID="e2e-active-screen">
        {current}
      </Text>
    </View>
  );
};

export const ScreenShell = ({
  children,
  current,
  navigation,
}: {
  readonly children: ReactNode;
  readonly current: ScreenName;
  readonly navigation: ScreenNavigation;
}) => (
  <SafeAreaView style={styles.safeArea}>
    <ScreenTabs current={current} navigation={navigation} />
    <View style={styles.content} testID="e2e-screen-content">
      {children}
    </View>
  </SafeAreaView>
);
