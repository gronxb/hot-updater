import React, { type ReactNode } from "react";
import { Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";

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
      <Button onPress={goTo("Runtime")} testID="e2e-nav-top" title="Runtime" />
      <Button
        onPress={goTo("Runtime")}
        testID="e2e-nav-crash-history"
        title="Crashes"
      />
      <Button
        onPress={goTo("Actions")}
        testID="e2e-nav-actions"
        title="Actions"
      />
      <Button
        onPress={goTo("CohortActions")}
        testID="e2e-nav-cohort-actions"
        title="Cohorts"
      />
      <Button
        onPress={goTo("Results")}
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
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="always"
      testID="e2e-scroll-content"
    >
      {children}
    </ScrollView>
  </SafeAreaView>
);
