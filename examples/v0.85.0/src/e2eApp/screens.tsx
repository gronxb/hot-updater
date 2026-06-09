import React from "react";
import { Image, Text, TextInput, View } from "react-native";

import { Button, InfoRow, ScreenShell, Section } from "./components";
import {
  E2E_LARGE_ARCHIVE_ASSET_MANIFEST_PATH,
  extractFormatDateFromUUIDv7,
} from "./runtime";
import { styles } from "./styles";
import type { ScreenNavigation } from "./types";
import type { E2eRuntimeModel } from "./useE2eRuntime";

type ScreenProps = {
  readonly model: E2eRuntimeModel;
  readonly navigation: ScreenNavigation;
};

export const RuntimeScreen = ({ model, navigation }: ScreenProps) => {
  const manifestAssetEntries = Object.entries(
    model.runtimeSnapshot.manifest.assets,
  );
  const hasLargeE2EAsset = manifestAssetEntries.some(
    ([fileName]) => fileName === E2E_LARGE_ARCHIVE_ASSET_MANIFEST_PATH,
  );
  const channelSummary = `current=${model.runtimeSnapshot.channel} default=${
    model.runtimeSnapshot.defaultChannel
  } switched=${String(model.runtimeSnapshot.isChannelSwitched)}`;
  const cohortSummary = `current=${model.runtimeSnapshot.cohort} initial=${model.initialCohort}`;

  return (
    <ScreenShell current="Runtime" navigation={navigation}>
      <Text style={styles.title}>HotUpdaterExample</Text>
      <Text style={styles.description}>
        React Native 0.85 sample with Hot Updater.
      </Text>

      <Section title="Runtime Snapshot">
        <InfoRow
          label="Bundle ID"
          value={model.runtimeSnapshot.bundleId}
          valueTestID="runtime-bundle-id"
        />
        <InfoRow
          label="Marker"
          value={model.scenarioMarker}
          valueTestID="runtime-scenario-marker"
        />
        <InfoRow
          label="Large Asset"
          value={hasLargeE2EAsset ? "present" : "missing"}
          valueTestID="runtime-large-e2e-asset"
        />
        <InfoRow label="Base URL" value={model.runtimeSnapshot.baseURL} />
        <InfoRow
          label="Bundle Timestamp"
          value={extractFormatDateFromUUIDv7(model.runtimeSnapshot.bundleId)}
        />
        <InfoRow
          label="Min Bundle ID"
          value={model.runtimeSnapshot.minBundleId}
        />
      </Section>

      <Section title="Launch Status">
        <Text
          selectable
          style={styles.resultText}
          testID="launch-status-result"
        >
          {model.launchStatusText}
        </Text>
        <Text
          selectable
          style={styles.resultText}
          testID="launch-crashed-bundle-result"
        >
          {model.crashedBundleText}
        </Text>
        <Text
          selectable
          style={styles.resultText}
          testID="current-channel-summary"
        >
          Current Channel Summary: {channelSummary}
        </Text>
        <Text
          selectable
          style={styles.resultText}
          testID="current-cohort-summary"
        >
          Current Cohort Summary: {cohortSummary}
        </Text>
        <InfoRow
          label="Downloaded"
          value={String(model.isUpdateDownloaded)}
          valueTestID="update-store-downloaded"
        />
        <InfoRow
          label="Download Paths"
          value={model.updateStoreDownloadPathsText}
          valueTestID="update-store-download-paths"
        />
      </Section>

      <Section
        title={`Crash History (${model.runtimeSnapshot.crashHistory.length})`}
        titleTestID="section-crash-history"
      >
        <Text
          selectable
          style={styles.resultText}
          testID="crash-history-summary"
        >
          {model.runtimeSnapshot.crashHistory.length === 0
            ? "No crashed bundles recorded."
            : `Crash History Count: ${model.runtimeSnapshot.crashHistory.length}`}
        </Text>
        {model.runtimeSnapshot.crashHistory.map((crash) => (
          <Text key={crash} selectable style={styles.crashItem}>
            {crash}
          </Text>
        ))}
      </Section>

      <Section title="OTA Asset Preview">
        <View style={styles.imageFrame}>
          <Image
            source={require("../test/_image.png")}
            style={styles.previewImage}
          />
        </View>
      </Section>

      <Section title={`Manifest Assets (${manifestAssetEntries.length})`}>
        {manifestAssetEntries.map(([fileName, asset]) => (
          <View key={fileName} style={styles.assetCard}>
            <Text selectable style={styles.assetName}>
              {fileName}
            </Text>
            <Text selectable style={styles.assetHash}>
              {asset.fileHash}
            </Text>
          </View>
        ))}
      </Section>
    </ScreenShell>
  );
};

export const ActionsScreen = ({ model, navigation }: ScreenProps) => (
  <ScreenShell current="Actions" navigation={navigation}>
    <Section title="Actions" titleTestID="section-actions">
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
          onPress={model.applyCohortInput}
          testID="action-apply-cohort-input"
          title="Apply Cohort"
        />
      </View>
    </Section>
  </ScreenShell>
);

export const CohortActionsScreen = ({ model, navigation }: ScreenProps) => (
  <ScreenShell current="CohortActions" navigation={navigation}>
    <Section title="Cohort Actions" titleTestID="section-cohort-actions">
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

export const ResultsScreen = ({ model, navigation }: ScreenProps) => (
  <ScreenShell current="Results" navigation={navigation}>
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
