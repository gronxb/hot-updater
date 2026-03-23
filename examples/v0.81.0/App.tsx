/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import { HOT_UPDATER_APP_BASE_URL } from "@env";
import { HotUpdater, useHotUpdaterStore } from "@hot-updater/react-native";
import React, { useEffect, useState } from "react";
import {
  Alert,
  Image,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import BootSplash from "react-native-bootsplash";
import { proxy, useSnapshot } from "valtio";

const notify = proxy<{
  status?: string;
  crashedBundleId?: string;
}>({});

const DEFAULT_APP_BASE_URL = "http://localhost:3007/hot-updater";
const HOT_UPDATER_BASE_URL =
  HOT_UPDATER_APP_BASE_URL || DEFAULT_APP_BASE_URL;
const E2E_SCENARIO_MARKER = "__BUILTIN__";

function maybeCrashForE2E() {
  /* E2E_CRASH_GUARD_START */
  /* E2E_CRASH_GUARD_END */
}

maybeCrashForE2E();

const getGlobalBaseUrl = (): string | null => {
  const maybeFn = Reflect.get(globalThis, "HotUpdaterGetBaseURL");
  if (typeof maybeFn !== "function") {
    return null;
  }
  const value = maybeFn();
  return typeof value === "string" ? value : null;
};
type RuntimeSnapshot = {
  appVersion: string | null;
  baseURL: string | null;
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

const readRuntimeSnapshot = (): RuntimeSnapshot => ({
  appVersion: HotUpdater.getAppVersion(),
  baseURL: getGlobalBaseUrl(),
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

const Section = ({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) => (
  <View style={styles.section}>
    <Text style={styles.sectionTitle}>{title}</Text>
    {children}
  </View>
);

const InfoRow = ({ label, value }: { label: string; value: string }) => (
  <View style={styles.infoRow}>
    <Text style={styles.infoLabel}>{label}</Text>
    <Text selectable style={styles.infoValue}>
      {value}
    </Text>
  </View>
);

const ActionButton = ({
  onPress,
  title,
}: {
  onPress: () => void | Promise<void>;
  title: string;
}) => (
  <Pressable
    accessibilityLabel={title}
    accessibilityRole="button"
    onPress={() => void onPress()}
    style={({ pressed }) => [
      styles.actionButton,
      pressed ? styles.actionButtonPressed : null,
    ]}
    testID={title}
  >
    <Text style={styles.actionButtonText}>{title}</Text>
  </Pressable>
);

function App(): React.JSX.Element {
  const notifyState = useSnapshot(notify);
  const progress = useHotUpdaterStore((state) => state.progress);
  const [initialCohort] = useState(() => HotUpdater.getCohort());
  const [cohortActionResult, setCohortActionResult] = useState("idle");
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<RuntimeSnapshot>(() =>
    readRuntimeSnapshot(),
  );

  useEffect(() => {
    setRuntimeSnapshot(readRuntimeSnapshot());
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => {
      BootSplash.hide({ fade: false }).catch(() => undefined);
    }, 1000);

    return () => clearTimeout(timeout);
  }, []);

  const manifestAssetEntries = Object.entries(runtimeSnapshot.manifest.assets);
  const statusPayload = JSON.stringify(notifyState, null, 2);

  const refreshRuntimeSnapshot = () => {
    setRuntimeSnapshot(readRuntimeSnapshot());
  };

  const clearCrashHistory = () => {
    HotUpdater.clearCrashHistory();
    refreshRuntimeSnapshot();
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

  const setCustomCohort = () => {
    HotUpdater.setCohort("qa-group");
    refreshRuntimeSnapshot();
    setCohortActionResult(`set -> ${HotUpdater.getCohort()}`);
  };

  const restoreInitialCohort = () => {
    HotUpdater.setCohort(initialCohort);
    refreshRuntimeSnapshot();
    setCohortActionResult(`restore -> ${HotUpdater.getCohort()}`);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
        <Section title="Runtime Snapshot">
          <InfoRow label="Bundle ID" value={runtimeSnapshot.bundleId} />
          <InfoRow
            label="Manifest Bundle ID"
            value={runtimeSnapshot.manifest.bundleId}
          />
          <InfoRow
            label="Bundle Timestamp"
            value={extractFormatDateFromUUIDv7(runtimeSnapshot.bundleId)}
          />
          <InfoRow label="Min Bundle ID" value={runtimeSnapshot.minBundleId} />
          <InfoRow label="E2E Scenario Marker" value={E2E_SCENARIO_MARKER} />
        </Section>

        <Section title="Launch Status">
          <InfoRow
            label="Download Progress"
            value={`${Math.round(progress * 100)}%`}
          />
          <Text selectable style={styles.codeBlock}>
            {statusPayload}
          </Text>
        </Section>

        <Section
          title={`Crash History (${runtimeSnapshot.crashHistory.length})`}
        >
          {runtimeSnapshot.crashHistory.length === 0 ? (
            <Text style={styles.emptyState}>No crashed bundles recorded.</Text>
          ) : (
            runtimeSnapshot.crashHistory.map((crash) => (
              <Text key={crash} selectable style={styles.crashItem}>
                {crash}
              </Text>
            ))
          )}
        </Section>

        <Section title="OTA Asset Preview">
          <Text style={styles.bodyText}>
            The preview image stays in the scroll flow so snapshot-based checks
            can compare the visual asset and the file hashes below.
          </Text>
          <View style={styles.imageFrame}>
            <Image
              source={require("./src/test/_image.png")}
              style={styles.previewImage}
            />
          </View>
        </Section>

        <Section title={`Manifest Assets (${manifestAssetEntries.length})`}>
          {manifestAssetEntries.length === 0 ? (
            <Text style={styles.emptyState}>
              No manifest assets were found for the active bundle.
            </Text>
          ) : (
            manifestAssetEntries.map(([fileName, asset]) => (
              <View key={fileName} style={styles.assetCard}>
                <Text selectable style={styles.assetName}>
                  {fileName}
                </Text>
                <Text style={styles.assetLabel}>fileHash</Text>
                <Text selectable style={styles.assetHash}>
                  {asset.fileHash}
                </Text>
              </View>
            ))
          )}
        </Section>

        <Section title="Runtime Details">
          <InfoRow label="Channel" value={runtimeSnapshot.channel} />
          <InfoRow label="Cohort" value={runtimeSnapshot.cohort} />
          <InfoRow
            label="Default Channel"
            value={runtimeSnapshot.defaultChannel}
          />
          <InfoRow
            label="Channel Switched"
            value={String(runtimeSnapshot.isChannelSwitched)}
          />
          <InfoRow
            label="App Version"
            value={runtimeSnapshot.appVersion ?? "null"}
          />
          <InfoRow
            label="Fingerprint"
            value={runtimeSnapshot.fingerprintHash ?? "null"}
          />
          <InfoRow label="Base URL" value={runtimeSnapshot.baseURL ?? "null"} />
        </Section>

        <Section title="Actions">
          <View style={styles.buttonBlock}>
            <ActionButton
              title="Refresh Runtime Snapshot"
              onPress={refreshRuntimeSnapshot}
            />
          </View>
          <View style={styles.buttonBlock}>
            <ActionButton title="Reload App" onPress={reloadApp} />
          </View>
          <View style={styles.buttonBlock}>
            <ActionButton
              title="Clear Crash History"
              onPress={clearCrashHistory}
            />
          </View>
          <View style={styles.buttonBlock}>
            <ActionButton
              title="Set Cohort qa-group"
              onPress={setCustomCohort}
            />
          </View>
          <View style={styles.buttonBlock}>
            <ActionButton
              title="Restore Initial Cohort"
              onPress={restoreInitialCohort}
            />
          </View>
          <Text selectable style={styles.actionResult}>
            Cohort Action Result: {cohortActionResult}
          </Text>
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    alignItems: "center",
    backgroundColor: "#1d4ed8",
    borderRadius: 14,
    minHeight: 48,
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  actionButtonPressed: {
    backgroundColor: "#1e40af",
  },
  actionButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "700",
  },
  actionResult: {
    color: "#1f2937",
    fontSize: 13,
    fontWeight: "600",
    marginTop: 12,
  },
  assetCard: {
    backgroundColor: "#f3f4f6",
    borderRadius: 16,
    marginTop: 12,
    padding: 16,
  },
  assetHash: {
    color: "#111827",
    fontFamily: "Courier",
    fontSize: 12,
    lineHeight: 18,
  },
  assetLabel: {
    color: "#4b5563",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 6,
    textTransform: "uppercase",
  },
  assetName: {
    color: "#111827",
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 10,
  },
  bodyText: {
    color: "#374151",
    fontSize: 14,
    lineHeight: 20,
  },
  buttonBlock: {
    marginTop: 12,
  },
  codeBlock: {
    backgroundColor: "#111827",
    borderRadius: 16,
    color: "#f9fafb",
    fontFamily: "Courier",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
    padding: 16,
  },
  contentContainer: {
    padding: 20,
    paddingBottom: 40,
  },
  crashItem: {
    backgroundColor: "#fff7ed",
    borderRadius: 12,
    color: "#9a3412",
    fontSize: 13,
    marginTop: 8,
    padding: 12,
  },
  description: {
    color: "#4b5563",
    fontSize: 15,
    lineHeight: 22,
    marginTop: 8,
  },
  emptyState: {
    color: "#6b7280",
    fontSize: 14,
    marginTop: 12,
  },
  eyebrow: {
    color: "#b45309",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  fallbackOverlay: {
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    borderRadius: 10,
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  fallbackTitle: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "700",
  },
  imageFrame: {
    alignItems: "center",
    backgroundColor: "#fffbeb",
    borderRadius: 20,
    marginTop: 12,
    padding: 24,
  },
  infoLabel: {
    color: "#6b7280",
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 4,
    textTransform: "uppercase",
  },
  infoRow: {
    borderBottomColor: "#e5e7eb",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
  },
  infoValue: {
    color: "#111827",
    fontSize: 14,
    lineHeight: 20,
  },
  previewImage: {
    height: 120,
    width: 120,
  },
  safeArea: {
    backgroundColor: "#f8fafc",
    flex: 1,
  },
  section: {
    backgroundColor: "#ffffff",
    borderRadius: 20,
    marginTop: 16,
    padding: 18,
  },
  sectionTitle: {
    color: "#111827",
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 8,
  },
  title: {
    color: "#111827",
    fontSize: 30,
    fontWeight: "800",
    marginTop: 6,
  },
});

export default HotUpdater.wrap({
  baseURL: HOT_UPDATER_BASE_URL,
  updateStrategy: "appVersion",
  updateMode: "auto",
  onNotifyAppReady: (result) => {
    notify.status = result.status;
    notify.crashedBundleId = result.crashedBundleId;
  },
  fallbackComponent: ({ progress, status }) => (
    <Modal transparent visible={true}>
      <View style={styles.fallbackOverlay}>
        <Text style={styles.fallbackTitle}>
          {status === "UPDATING" ? "Updating..." : "Checking for Update..."}
        </Text>
        {progress > 0 ? (
          <Text style={styles.fallbackTitle}>
            {Math.round(progress * 100)}%
          </Text>
        ) : null}
      </View>
    </Modal>
  ),
  onError: (error) => {
    console.error(error);
  },
})(App);
