import React from "react";
import { Text, View } from "react-native";

import { InfoRow, ScreenShell, Section } from "../components";
import { E2E_LARGE_ARCHIVE_ASSET_MANIFEST_PATH } from "../runtime";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const RuntimeIdentityScreen = ({ model, navigation }: ScreenProps) => {
  const hasLargeE2EAsset = Object.keys(
    model.runtimeSnapshot.manifest.assets,
  ).includes(E2E_LARGE_ARCHIVE_ASSET_MANIFEST_PATH);

  return (
    <ScreenShell current="RuntimeIdentity" navigation={navigation}>
      <Section title="Runtime Identity">
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
      </Section>
    </ScreenShell>
  );
};

export const LaunchStatusScreen = ({ model, navigation }: ScreenProps) => (
  <ScreenShell current="LaunchStatus" navigation={navigation}>
    <Section title="Launch Status">
      <Text selectable style={styles.resultText} testID="launch-status-result">
        {model.launchStatusText}
      </Text>
      <Text
        selectable
        style={styles.resultText}
        testID="launch-crashed-bundle-result"
      >
        {model.crashedBundleText}
      </Text>
    </Section>
  </ScreenShell>
);

export const RuntimeStateScreen = ({ model, navigation }: ScreenProps) => {
  const channelSummary = `current=${model.runtimeSnapshot.channel} default=${
    model.runtimeSnapshot.defaultChannel
  } switched=${String(model.runtimeSnapshot.isChannelSwitched)}`;
  const cohortSummary = `current=${model.runtimeSnapshot.cohort} initial=${model.initialCohort}`;

  return (
    <ScreenShell current="RuntimeState" navigation={navigation}>
      <Section title="Runtime State">
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
      </Section>
    </ScreenShell>
  );
};

export const UpdateStoreScreen = ({ model, navigation }: ScreenProps) => (
  <ScreenShell current="UpdateStore" navigation={navigation}>
    <Section title="Update Store">
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
  </ScreenShell>
);

export const CrashHistoryScreen = ({ model, navigation }: ScreenProps) => (
  <ScreenShell current="CrashHistory" navigation={navigation}>
    <Section
      title={`Crash History (${model.runtimeSnapshot.crashHistory.length})`}
      titleTestID="section-crash-history"
    >
      <Text selectable style={styles.resultText} testID="crash-history-summary">
        {model.runtimeSnapshot.crashHistory.length === 0
          ? "No crashed bundles recorded."
          : `Crash History Count: ${model.runtimeSnapshot.crashHistory.length}`}
      </Text>
      <View style={styles.crashList}>
        {model.runtimeSnapshot.crashHistory.slice(0, 3).map((crash) => (
          <Text key={crash} selectable style={styles.crashItem}>
            {crash}
          </Text>
        ))}
      </View>
    </Section>
  </ScreenShell>
);
