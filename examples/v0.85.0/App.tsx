/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import { HotUpdater, useHotUpdaterStore } from "@hot-updater/react-native";
import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  Image,
  Keyboard,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import BootSplash from "react-native-bootsplash";
import { proxy, useSnapshot } from "valtio";

import {
  fallbackHotUpdaterBaseURL,
  resolveHotUpdaterBaseURL,
} from "./src/e2eRuntimeConfig";

const notify = proxy<{
  status?: string;
  crashedBundleId?: string;
}>({});

const E2E_SCENARIO_MARKER = "targeted-qa-detox";
const E2E_LARGE_ARCHIVE_ASSET_MANIFEST_PATH =
  "assets/src/test/_fixture-archive-300mb-random.bmp";

function maybeCrashForE2E() {
  /* E2E_CRASH_GUARD_START */
  /* E2E_CRASH_GUARD_END */
}

maybeCrashForE2E();

function loadE2EDeployBundleAssets() {
  /* E2E_DEPLOY_ASSET_GUARD_START */
  /* E2E_DEPLOY_ASSET_GUARD_END */
}

loadE2EDeployBundleAssets();

type RuntimeSnapshot = {
  appVersion: string | null;
  baseURL: string;
  bundleId: string;
  channel: string;
  cohort: string;
  crashHistory: string[];
  defaultChannel: string;
  fingerprintHash: string | null;
  isChannelSwitched: boolean;
  manifest: ReturnType<typeof HotUpdater.getManifest>;
  minBundleId: string;
};

type UpdateProgressDetails = {
  files: {
    downloadPath?: string;
    path: string;
    progress: number;
    status: string;
  }[];
};

type ScrollTarget = "actions" | "cohortActions" | "crashHistory" | "results";

HotUpdater.init({
  baseURL: resolveHotUpdaterBaseURL,
  requestTimeout: 15000,
  onNotifyAppReady: (result) => {
    notify.status = result.status;
    notify.crashedBundleId = result.crashedBundleId;
  },
  onError: (error) => {
    console.error(error);
  },
});

const readRuntimeSnapshot = (): RuntimeSnapshot => ({
  appVersion: HotUpdater.getAppVersion(),
  baseURL: fallbackHotUpdaterBaseURL,
  bundleId: HotUpdater.getBundleId(),
  channel: HotUpdater.getChannel(),
  cohort: HotUpdater.getCohort(),
  crashHistory: HotUpdater.getCrashHistory(),
  defaultChannel: HotUpdater.getDefaultChannel(),
  fingerprintHash: HotUpdater.getFingerprintHash(),
  isChannelSwitched: HotUpdater.isChannelSwitched(),
  manifest: HotUpdater.getManifest(),
  minBundleId: HotUpdater.getMinBundleId(),
});

export const extractFormatDateFromUUIDv7 = (uuid: string) => {
  if (!/^[0-9a-fA-F-]{36}$/.test(uuid)) {
    return "N/A";
  }

  const timestampHex = uuid.split("-").join("").slice(0, 12);
  const timestamp = Number.parseInt(timestampHex, 16);
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return "N/A";
  }

  const year = date.getFullYear().toString().slice(2);
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");

  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
};

const formatFallbackPercent = (value: number | null | undefined) => {
  if (typeof value !== "number") {
    return "pending";
  }

  return `${Math.round(value * 100)}%`;
};

const formatUpdateStoreDownloadPaths = (
  details: UpdateProgressDetails | null,
) => {
  if (!details || details.files.length === 0) {
    return "none";
  }

  return details.files
    .map(
      (file) =>
        `${file.path}:${file.status}:${file.downloadPath}:${formatFallbackPercent(
          file.progress,
        )}`,
    )
    .join("\n");
};

const InfoRow = ({
  label,
  value,
  valueTestID,
}: {
  label: string;
  value: string;
  valueTestID?: string;
}) => (
  <View style={styles.infoRow}>
    <Text style={styles.infoLabel}>{label}</Text>
    <Text selectable style={styles.infoValue} testID={valueTestID}>
      {value}
    </Text>
  </View>
);

const Section = ({
  children,
  onLayout,
  title,
  titleTestID,
}: {
  children: React.ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
  title: string;
  titleTestID?: string;
}) => (
  <View onLayout={onLayout} style={styles.section}>
    <Text style={styles.sectionTitle} testID={titleTestID}>
      {title}
    </Text>
    {children}
  </View>
);

const Button = ({
  onPress,
  testID,
  title,
}: {
  onPress: () => void | Promise<void>;
  testID: string;
  title: string;
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

function App(): React.JSX.Element {
  const notifyState = useSnapshot(notify);
  const progressState = useHotUpdaterStore((state) => state);
  const scrollViewRef = useRef<ScrollView>(null);
  const sectionOffsets = useRef<Record<ScrollTarget, number | null>>({
    actions: null,
    cohortActions: null,
    crashHistory: null,
    results: null,
  });
  const [initialCohort] = useState(() => HotUpdater.getCohort());
  const [runtimeChannelInput, setRuntimeChannelInput] = useState("beta");
  const [cohortInput, setCohortInput] = useState(() => initialCohort);
  const cohortInputRef = useRef(initialCohort);
  const [channelActionResult, setChannelActionResult] = useState("idle");
  const [cohortActionResult, setCohortActionResult] = useState("idle");
  const [updateActionResult, setUpdateActionResult] = useState("idle");
  const [runtimeSnapshot, setRuntimeSnapshot] = useState(readRuntimeSnapshot);

  useEffect(() => {
    const timeout = setTimeout(() => {
      BootSplash.hide({ fade: false }).catch(() => undefined);
    }, 1000);

    return () => clearTimeout(timeout);
  }, []);

  const manifestAssetEntries = Object.entries(runtimeSnapshot.manifest.assets);
  const hasLargeE2EAsset = manifestAssetEntries.some(
    ([fileName]) => fileName === E2E_LARGE_ARCHIVE_ASSET_MANIFEST_PATH,
  );
  const launchStatusText = `Current Launch Status: ${
    notifyState.status ?? "null"
  }`;
  const crashedBundleText = `Current Crashed Bundle ID: ${
    notifyState.crashedBundleId ?? "null"
  }`;
  const channelSummary = `current=${runtimeSnapshot.channel} default=${
    runtimeSnapshot.defaultChannel
  } switched=${String(runtimeSnapshot.isChannelSwitched)}`;
  const cohortSummary = `current=${runtimeSnapshot.cohort} initial=${initialCohort}`;

  const refreshRuntimeSnapshot = async () => {
    const baseURL = await resolveHotUpdaterBaseURL();
    setRuntimeSnapshot({ ...readRuntimeSnapshot(), baseURL });
  };

  const recordSectionOffset =
    (target: ScrollTarget) => (event: LayoutChangeEvent) => {
      sectionOffsets.current[target] = event.nativeEvent.layout.y;
    };

  const scrollToTop = () => {
    Keyboard.dismiss();
    scrollViewRef.current?.scrollTo({ animated: false, y: 0 });
  };

  const scrollToSection = (target: ScrollTarget) => {
    Keyboard.dismiss();
    scrollViewRef.current?.scrollTo({
      animated: false,
      y: Math.max((sectionOffsets.current[target] ?? 0) - 12, 0),
    });
  };

  const clearCrashHistory = async () => {
    HotUpdater.clearCrashHistory();
    await refreshRuntimeSnapshot();
  };

  const reloadApp = async () => {
    try {
      await HotUpdater.reload();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to reload app";
      Alert.alert("Reload Error", message);
    }
  };

  const installUpdate = async ({
    actionLabel,
    channel,
  }: {
    actionLabel: string;
    channel?: string;
  }) => {
    try {
      setUpdateActionResult(`${actionLabel} -> checking`);
      const updateInfo = await HotUpdater.checkForUpdate({
        updateStrategy: "appVersion",
        ...(channel ? { channel } : {}),
      });

      if (!updateInfo) {
        setUpdateActionResult(`${actionLabel} -> no-update`);
        await refreshRuntimeSnapshot();
        return;
      }

      const installed = await updateInfo.updateBundle();
      setUpdateActionResult(
        installed
          ? `${actionLabel} -> installed ${updateInfo.id} (${updateInfo.status})`
          : `${actionLabel} -> skipped`,
      );
      await refreshRuntimeSnapshot();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to install update";
      setUpdateActionResult(`${actionLabel} -> error ${message}`);
    }
  };

  const installRuntimeChannelUpdate = async () => {
    const normalizedChannel = runtimeChannelInput.trim().toLowerCase();
    if (!normalizedChannel) {
      setChannelActionResult("runtime-channel -> invalid");
      return;
    }

    setChannelActionResult(`runtime-channel -> ${normalizedChannel}`);
    await installUpdate({
      actionLabel: `runtime-channel:${normalizedChannel}`,
      channel: normalizedChannel,
    });
  };

  const resetRuntimeChannel = async () => {
    try {
      const didReset = await HotUpdater.resetChannel();
      await refreshRuntimeSnapshot();
      setChannelActionResult(`reset -> ${String(didReset)}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to reset channel";
      setChannelActionResult(`reset -> error ${message}`);
    }
  };

  const applyCohortValue = async (nextCohort: string) => {
    HotUpdater.setCohort(nextCohort);
    const appliedCohort = HotUpdater.getCohort();
    cohortInputRef.current = appliedCohort;
    setCohortInput(appliedCohort);
    await refreshRuntimeSnapshot();
    setCohortActionResult(`set -> ${appliedCohort}`);
  };

  const applyCohortInput = async () => {
    try {
      await applyCohortValue(cohortInputRef.current);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to set cohort";
      setCohortActionResult(`set -> error ${message}`);
    }
  };

  const updateCohortInput = (nextCohort: string) => {
    cohortInputRef.current = nextCohort;
    setCohortInput(nextCohort);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.navBar}>
        <Button onPress={scrollToTop} testID="e2e-nav-top" title="Top" />
        <Button
          onPress={() => scrollToSection("crashHistory")}
          testID="e2e-nav-crash-history"
          title="Crashes"
        />
        <Button
          onPress={() => scrollToSection("actions")}
          testID="e2e-nav-actions"
          title="Actions"
        />
        <Button
          onPress={() => scrollToSection("cohortActions")}
          testID="e2e-nav-cohort-actions"
          title="Cohorts"
        />
        <Button
          onPress={() => scrollToSection("results")}
          testID="e2e-nav-action-results"
          title="Results"
        />
      </View>
      <ScrollView
        ref={scrollViewRef}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="always"
        testID="e2e-scroll-content"
      >
        <Text style={styles.title}>HotUpdaterExample</Text>
        <Text style={styles.description}>
          React Native 0.85 sample with Hot Updater.
        </Text>

        <Section title="Runtime Snapshot">
          <InfoRow
            label="Bundle ID"
            value={runtimeSnapshot.bundleId}
            valueTestID="runtime-bundle-id"
          />
          <InfoRow
            label="Marker"
            value={E2E_SCENARIO_MARKER}
            valueTestID="runtime-scenario-marker"
          />
          <InfoRow
            label="Large Asset"
            value={hasLargeE2EAsset ? "present" : "missing"}
            valueTestID="runtime-large-e2e-asset"
          />
          <InfoRow label="Base URL" value={runtimeSnapshot.baseURL} />
          <InfoRow
            label="Bundle Timestamp"
            value={extractFormatDateFromUUIDv7(runtimeSnapshot.bundleId)}
          />
          <InfoRow label="Min Bundle ID" value={runtimeSnapshot.minBundleId} />
        </Section>

        <Section title="Launch Status">
          <Text
            selectable
            style={styles.resultText}
            testID="launch-status-result"
          >
            {launchStatusText}
          </Text>
          <Text
            selectable
            style={styles.resultText}
            testID="launch-crashed-bundle-result"
          >
            {crashedBundleText}
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
            value={String(progressState.isUpdateDownloaded)}
            valueTestID="update-store-downloaded"
          />
          <InfoRow
            label="Download Paths"
            value={formatUpdateStoreDownloadPaths(progressState.details)}
            valueTestID="update-store-download-paths"
          />
        </Section>

        <Section
          onLayout={recordSectionOffset("crashHistory")}
          title={`Crash History (${runtimeSnapshot.crashHistory.length})`}
          titleTestID="section-crash-history"
        >
          <Text
            selectable
            style={styles.resultText}
            testID="crash-history-summary"
          >
            {runtimeSnapshot.crashHistory.length === 0
              ? "No crashed bundles recorded."
              : `Crash History Count: ${runtimeSnapshot.crashHistory.length}`}
          </Text>
          {runtimeSnapshot.crashHistory.map((crash) => (
            <Text key={crash} selectable style={styles.crashItem}>
              {crash}
            </Text>
          ))}
        </Section>

        <Section title="OTA Asset Preview">
          <View style={styles.imageFrame}>
            <Image
              source={require("./src/test/_image.png")}
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

        <Section
          onLayout={recordSectionOffset("actions")}
          title="Actions"
          titleTestID="section-actions"
        >
          <TextInput
            accessibilityLabel="Runtime Channel Input"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setRuntimeChannelInput}
            placeholder="beta"
            placeholderTextColor="#6b7280"
            style={styles.input}
            testID="runtime-channel-input"
            value={runtimeChannelInput}
          />
          <TextInput
            accessibilityLabel="Cohort Override Input"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={updateCohortInput}
            onEndEditing={(event) => updateCohortInput(event.nativeEvent.text)}
            placeholder={initialCohort}
            placeholderTextColor="#6b7280"
            selectTextOnFocus={true}
            style={styles.input}
            testID="cohort-input"
            value={cohortInput}
          />
          <View style={styles.buttonGrid}>
            <Button
              onPress={refreshRuntimeSnapshot}
              testID="action-refresh-runtime-snapshot"
              title="Refresh"
            />
            <Button
              onPress={reloadApp}
              testID="action-reload-app"
              title="Reload"
            />
            <Button
              onPress={clearCrashHistory}
              testID="action-clear-crash-history"
              title="Clear Crashes"
            />
            <Button
              onPress={() => installUpdate({ actionLabel: "current-channel" })}
              testID="action-install-current-channel-update"
              title="Install Current"
            />
            <Button
              onPress={installRuntimeChannelUpdate}
              testID="action-install-runtime-channel-update"
              title="Install Runtime"
            />
            <Button
              onPress={resetRuntimeChannel}
              testID="action-reset-runtime-channel"
              title="Reset Channel"
            />
            <Button
              onPress={applyCohortInput}
              testID="action-apply-cohort-input"
              title="Apply Cohort"
            />
          </View>
        </Section>

        <Section
          onLayout={recordSectionOffset("cohortActions")}
          title="Cohort Actions"
          titleTestID="section-cohort-actions"
        >
          <View style={styles.buttonGrid}>
            <Button
              onPress={() => applyCohortValue("qa")}
              testID="action-set-cohort-qa"
              title="Set qa"
            />
            <Button
              onPress={async () => {
                await applyCohortValue(initialCohort);
                setCohortActionResult(`restore -> ${HotUpdater.getCohort()}`);
              }}
              testID="action-restore-initial-cohort"
              title="Restore Cohort"
            />
          </View>
        </Section>

        <Section
          onLayout={recordSectionOffset("results")}
          title="Action Results"
          titleTestID="section-action-results"
        >
          <Text
            selectable
            style={styles.resultText}
            testID="channel-action-result"
          >
            Channel Action Result: {channelActionResult}
          </Text>
          <Text
            selectable
            style={styles.resultText}
            testID="update-action-result"
          >
            Update Action Result: {updateActionResult}
          </Text>
          <Text
            selectable
            style={styles.resultText}
            testID="cohort-action-result"
          >
            Cohort Action Result: {cohortActionResult}
          </Text>
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  assetCard: {
    backgroundColor: "#f3f4f6",
    borderRadius: 8,
    marginTop: 10,
    padding: 12,
  },
  assetHash: {
    color: "#111827",
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontSize: 12,
    lineHeight: 18,
  },
  assetName: {
    color: "#111827",
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 6,
  },
  button: {
    alignItems: "center",
    backgroundColor: "#155e75",
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  buttonGrid: {
    gap: 8,
    marginTop: 12,
  },
  buttonPressed: {
    backgroundColor: "#0e7490",
  },
  buttonText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center",
  },
  content: {
    padding: 18,
    paddingBottom: 40,
  },
  crashItem: {
    backgroundColor: "#fff7ed",
    borderRadius: 8,
    color: "#9a3412",
    fontSize: 13,
    marginTop: 8,
    padding: 10,
  },
  description: {
    color: "#475569",
    fontSize: 15,
    lineHeight: 21,
    marginTop: 6,
  },
  imageFrame: {
    alignItems: "center",
    backgroundColor: "#ecfeff",
    borderRadius: 8,
    marginTop: 8,
    padding: 18,
  },
  infoLabel: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 4,
    textTransform: "uppercase",
  },
  infoRow: {
    borderBottomColor: "#e5e7eb",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 9,
  },
  infoValue: {
    color: "#111827",
    fontSize: 14,
    lineHeight: 20,
  },
  input: {
    backgroundColor: "#f8fafc",
    borderColor: "#cbd5e1",
    borderRadius: 8,
    borderWidth: 1,
    color: "#0f172a",
    fontSize: 15,
    marginTop: 10,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  navBar: {
    backgroundColor: "#f8fafc",
    borderBottomColor: "#e2e8f0",
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 6,
    paddingBottom: 8,
    paddingHorizontal: 10,
    paddingTop: Platform.OS === "android" ? 40 : 8,
  },
  previewImage: {
    height: 120,
    width: 120,
  },
  resultText: {
    color: "#1f2937",
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 19,
    marginTop: 8,
  },
  safeArea: {
    backgroundColor: "#f8fafc",
    flex: 1,
  },
  section: {
    backgroundColor: "#ffffff",
    borderRadius: 8,
    marginTop: 14,
    padding: 16,
  },
  sectionTitle: {
    color: "#111827",
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 6,
  },
  title: {
    color: "#111827",
    fontSize: 30,
    fontWeight: "800",
  },
});

export default App;
