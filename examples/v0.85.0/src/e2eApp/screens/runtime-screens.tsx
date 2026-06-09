import React from "react";
import { Text, View } from "react-native";

import { InfoRow, ScreenShell, Section } from "../components";
import { E2E_LARGE_ARCHIVE_ASSET_MANIFEST_PATH } from "../runtime";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const ReadyScreen = () => (
  <ScreenShell current="Ready">
    <Section title="E2E Ready">
      <Text selectable style={styles.resultText} testID="e2e-ready-status">
        Ready
      </Text>
    </Section>
  </ScreenShell>
);

export const RuntimeBundleScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="RuntimeBundle">
    <Section title="Runtime Bundle">
      <InfoRow
        label="Bundle ID"
        value={model.runtimeSnapshot.bundleId}
        valueTestID="runtime-bundle-id"
      />
    </Section>
  </ScreenShell>
);

export const RuntimeMarkerScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="RuntimeMarker">
    <Section title="Runtime Marker">
      <InfoRow
        label="Marker"
        value={model.scenarioMarker}
        valueTestID="runtime-scenario-marker"
      />
    </Section>
  </ScreenShell>
);

export const RuntimeLargeAssetScreen = ({ model }: ScreenProps) => {
  const hasLargeE2EAsset = Object.keys(
    model.runtimeSnapshot.manifest.assets,
  ).includes(E2E_LARGE_ARCHIVE_ASSET_MANIFEST_PATH);

  return (
    <ScreenShell current="RuntimeLargeAsset">
      <Section title="Runtime Large Asset">
        <InfoRow
          label="Large Asset"
          value={hasLargeE2EAsset ? "present" : "missing"}
          valueTestID="runtime-large-e2e-asset"
        />
      </Section>
    </ScreenShell>
  );
};

export const LaunchStatusScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="LaunchStatus">
    <Section title="Launch Status">
      <Text selectable style={styles.resultText} testID="launch-status-result">
        {model.launchStatusText}
      </Text>
    </Section>
  </ScreenShell>
);

export const LaunchCrashedBundleScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="LaunchCrashedBundle">
    <Section title="Launch Crashed Bundle">
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

export const RuntimeChannelSummaryScreen = ({ model }: ScreenProps) => {
  const channelSummary = `current=${model.runtimeSnapshot.channel} default=${
    model.runtimeSnapshot.defaultChannel
  } switched=${String(model.runtimeSnapshot.isChannelSwitched)}`;

  return (
    <ScreenShell current="RuntimeChannelSummary">
      <Section title="Runtime Channel Summary">
        <Text
          selectable
          style={styles.resultText}
          testID="current-channel-summary"
        >
          Current Channel Summary: {channelSummary}
        </Text>
      </Section>
    </ScreenShell>
  );
};

export const RuntimeCohortSummaryScreen = ({ model }: ScreenProps) => {
  const cohortSummary = `current=${model.runtimeSnapshot.cohort} initial=${model.initialCohort}`;

  return (
    <ScreenShell current="RuntimeCohortSummary">
      <Section title="Runtime Cohort Summary">
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

export const UpdateStoreDownloadedScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="UpdateStoreDownloaded">
    <Section title="Update Downloaded">
      <InfoRow
        label="Downloaded"
        value={String(model.isUpdateDownloaded)}
        valueTestID="update-store-downloaded"
      />
    </Section>
  </ScreenShell>
);

export const UpdateStoreDownloadPathsScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="UpdateStoreDownloadPaths">
    <Section title="Update Download Paths">
      <InfoRow
        label="Download Paths"
        value={model.updateStoreDownloadPathsText}
        valueTestID="update-store-download-paths"
      />
    </Section>
  </ScreenShell>
);

export const CrashHistoryScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="CrashHistory">
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
