import React from "react";
import { Text, TextInput, View } from "react-native";

import { Button, ScreenShell, Section } from "../components";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const InstallActionsScreen = ({ model, navigation }: ScreenProps) => (
  <ScreenShell current="InstallActions" navigation={navigation}>
    <Section title="Install Actions" titleTestID="section-install-actions">
      <View style={styles.buttonGrid}>
        <Button
          onPress={model.refreshRuntimeSnapshot}
          testID="action-refresh-runtime-snapshot"
          title="Refresh"
        />
        <Button
          onPress={model.reloadApp}
          testID="action-reload-app"
          title="Reload"
        />
        <Button
          onPress={model.clearCrashHistory}
          testID="action-clear-crash-history"
          title="Clear Crashes"
        />
        <Button
          onPress={() =>
            model.installUpdate({ actionLabel: "current-channel" })
          }
          testID="action-install-current-channel-update"
          title="Install Current"
        />
      </View>
    </Section>
  </ScreenShell>
);

export const RuntimeChannelActionsScreen = ({
  model,
  navigation,
}: ScreenProps) => (
  <ScreenShell current="RuntimeChannelActions" navigation={navigation}>
    <Section title="Runtime Channel">
      <TextInput
        accessibilityLabel="Runtime Channel Input"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={model.setRuntimeChannelInput}
        placeholder="beta"
        placeholderTextColor="#6b7280"
        style={styles.input}
        testID="runtime-channel-input"
        value={model.runtimeChannelInput}
      />
      <View style={styles.buttonGrid}>
        <Button
          onPress={model.installRuntimeChannelUpdate}
          testID="action-install-runtime-channel-update"
          title="Install Runtime"
        />
        <Button
          onPress={model.resetRuntimeChannel}
          testID="action-reset-runtime-channel"
          title="Reset Channel"
        />
        <Button
          onPress={model.reloadApp}
          testID="action-reload-app"
          title="Reload"
        />
      </View>
    </Section>
  </ScreenShell>
);

export const CohortInputActionsScreen = ({
  model,
  navigation,
}: ScreenProps) => (
  <ScreenShell current="CohortInputActions" navigation={navigation}>
    <Section title="Cohort Input">
      <TextInput
        accessibilityLabel="Cohort Override Input"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={model.updateCohortInput}
        onEndEditing={(event) =>
          model.updateCohortInput(event.nativeEvent.text)
        }
        placeholder={model.initialCohort}
        placeholderTextColor="#6b7280"
        selectTextOnFocus={true}
        style={styles.input}
        testID="cohort-input"
        value={model.cohortInput}
      />
      <Button
        onPress={model.applyCohortInput}
        testID="action-apply-cohort-input"
        title="Apply Cohort"
      />
    </Section>
  </ScreenShell>
);

export const CohortPresetActionsScreen = ({
  model,
  navigation,
}: ScreenProps) => (
  <ScreenShell current="CohortPresetActions" navigation={navigation}>
    <Section title="Cohort Presets" titleTestID="section-cohort-actions">
      <View style={styles.buttonGrid}>
        <Button
          onPress={model.setCohortToQa}
          testID="action-set-cohort-qa"
          title="Set qa"
        />
        <Button
          onPress={model.restoreInitialCohort}
          testID="action-restore-initial-cohort"
          title="Restore Cohort"
        />
      </View>
    </Section>
  </ScreenShell>
);

export const ActionResultsScreen = ({ model, navigation }: ScreenProps) => (
  <ScreenShell current="ActionResults" navigation={navigation}>
    <Section title="Action Results" titleTestID="section-action-results">
      <Text selectable style={styles.resultText} testID="channel-action-result">
        Channel Action Result: {model.channelActionResult}
      </Text>
      <Text selectable style={styles.resultText} testID="update-action-result">
        Update Action Result: {model.updateActionResult}
      </Text>
      <Text selectable style={styles.resultText} testID="cohort-action-result">
        Cohort Action Result: {model.cohortActionResult}
      </Text>
    </Section>
  </ScreenShell>
);
