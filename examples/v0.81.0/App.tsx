/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import { HotUpdater, useHotUpdaterStore } from "@hot-updater/react-native";
import React, { useEffect, useState } from "react";
import {
  Alert,
  Image,
  Modal,
  Pressable,
  SafeAreaView,
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

type RuntimeSnapshot = {
  appVersion: string | null;
  baseURL: string | null;
  bundleId: string;
  channel: string;
  crashHistory: string[];
  defaultChannel: string;
  fingerprintHash: string | null;
  isChannelSwitched: boolean;
  manifest: ReturnType<typeof HotUpdater.getManifest>;
  minBundleId: string;
};

type PanelKey = "actions" | "assets" | "crash" | "runtime" | null;

const readRuntimeSnapshot = (): RuntimeSnapshot => ({
  appVersion: HotUpdater.getAppVersion(),
  baseURL: globalThis.HotUpdaterGetBaseURL?.() ?? null,
  bundleId: HotUpdater.getBundleId(),
  channel: HotUpdater.getChannel(),
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

const ControlButton = ({
  onPress,
  subtitle,
  title,
}: {
  onPress: () => void;
  subtitle: string;
  title: string;
}) => (
  <Pressable onPress={onPress} style={styles.controlButton}>
    <Text style={styles.controlTitle}>{title}</Text>
    <Text style={styles.controlSubtitle}>{subtitle}</Text>
  </Pressable>
);

const ActionButton = ({
  onPress,
  title,
  tone = "default",
}: {
  onPress: () => void;
  title: string;
  tone?: "default" | "danger";
}) => (
  <Pressable
    onPress={onPress}
    style={[
      styles.actionButton,
      tone === "danger" ? styles.actionButtonDanger : null,
    ]}
  >
    <Text
      style={[
        styles.actionButtonText,
        tone === "danger" ? styles.actionButtonTextDanger : null,
      ]}
    >
      {title}
    </Text>
  </Pressable>
);

const PanelModal = ({
  children,
  onClose,
  title,
  visible,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title: string;
  visible: boolean;
}) => (
  <Modal
    animationType="fade"
    onRequestClose={onClose}
    transparent
    visible={visible}
  >
    <View style={styles.panelBackdrop}>
      <View style={styles.panelCard}>
        <View style={styles.panelHeader}>
          <Text style={styles.panelTitle}>{title}</Text>
          <Pressable onPress={onClose} style={styles.panelCloseButton}>
            <Text style={styles.panelCloseText}>Close</Text>
          </Pressable>
        </View>
        {children}
      </View>
    </View>
  </Modal>
);

function App(): React.JSX.Element {
  const notifyState = useSnapshot(notify);
  const progress = useHotUpdaterStore((state) => state.progress);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<RuntimeSnapshot>(() =>
    readRuntimeSnapshot(),
  );
  const [activePanel, setActivePanel] = useState<PanelKey>(null);
  const [selectedAssetIndex, setSelectedAssetIndex] = useState(0);
  const [selectedCrashIndex, setSelectedCrashIndex] = useState(0);

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
  const latestCrash = runtimeSnapshot.crashHistory.at(-1) ?? null;
  const selectedAssetEntry = manifestAssetEntries[selectedAssetIndex] ?? null;
  const selectedCrash = runtimeSnapshot.crashHistory[selectedCrashIndex] ?? null;
  const statusPayload = JSON.stringify(notifyState, null, 2);

  useEffect(() => {
    setSelectedAssetIndex((current) => {
      if (manifestAssetEntries.length === 0) {
        return 0;
      }

      return Math.min(current, manifestAssetEntries.length - 1);
    });
  }, [manifestAssetEntries.length]);

  useEffect(() => {
    setSelectedCrashIndex((current) => {
      if (runtimeSnapshot.crashHistory.length === 0) {
        return 0;
      }

      return Math.min(current, runtimeSnapshot.crashHistory.length - 1);
    });
  }, [runtimeSnapshot.crashHistory.length]);

  const refreshRuntimeSnapshot = () => {
    setRuntimeSnapshot(readRuntimeSnapshot());
  };

  const clearCrashHistory = () => {
    HotUpdater.clearCrashHistory();
    setSelectedCrashIndex(0);
    refreshRuntimeSnapshot();
  };

  const closePanel = () => {
    setActivePanel(null);
  };

  const openPanel = (panel: Exclude<PanelKey, null>) => {
    if (panel === "assets") {
      setSelectedAssetIndex(0);
    }

    if (panel === "crash") {
      setSelectedCrashIndex(Math.max(runtimeSnapshot.crashHistory.length - 1, 0));
    }

    setActivePanel(panel);
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

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.contentContainer}>
        <View>
          <Text style={styles.eyebrow}>HotUpdater Example v0.81.0</Text>
          <Text style={styles.title}>Agent-Friendly OTA Console</Text>
          <Text style={styles.description}>
            The home screen keeps the e2e checkpoint visible without scrolling.
            Open the panels below to inspect deeper runtime state one step at a
            time.
          </Text>
        </View>

        <View>
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
            <InfoRow
              label="Download Progress"
              value={`${Math.round(progress * 100)}%`}
            />
          </Section>

          <Section title="Launch Status">
            <Text selectable style={styles.statusBlock}>
              {statusPayload}
            </Text>
          </Section>

          <Section
            title={`Crash History (${runtimeSnapshot.crashHistory.length})`}
          >
            {latestCrash ? (
              <Text selectable style={styles.crashItem}>
                {latestCrash}
              </Text>
            ) : (
              <Text style={styles.emptyState}>No crashed bundles recorded.</Text>
            )}
          </Section>

          <Section title="OTA Asset Preview">
            <View style={styles.assetPreviewRow}>
              <View style={styles.imageFrame}>
                <Image
                  source={require("./src/test/_image.png")}
                  style={styles.previewImage}
                />
              </View>
              <Text style={styles.bodyText}>
                Open Manifest Inspector to review each asset hash without
                scanning a long list.
              </Text>
            </View>
          </Section>
        </View>

        <View style={styles.controlGrid}>
          <ControlButton
            onPress={() => openPanel("runtime")}
            subtitle="Channel, app version, base URL"
            title="Runtime Details"
          />
          <ControlButton
            onPress={() => openPanel("assets")}
            subtitle="Manifest summary and asset hashes"
            title="Manifest Inspector"
          />
          <ControlButton
            onPress={() => openPanel("crash")}
            subtitle="Review each crashed bundle"
            title="Crash Timeline"
          />
          <ControlButton
            onPress={() => openPanel("actions")}
            subtitle="Refresh, reload, and clear history"
            title="Actions"
          />
        </View>
      </View>

      <PanelModal
        onClose={closePanel}
        title="Runtime Details"
        visible={activePanel === "runtime"}
      >
        <InfoRow label="Min Bundle ID" value={runtimeSnapshot.minBundleId} />
        <InfoRow label="Channel" value={runtimeSnapshot.channel} />
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
      </PanelModal>

      <PanelModal
        onClose={closePanel}
        title="Manifest Inspector"
        visible={activePanel === "assets"}
      >
        <InfoRow
          label="Manifest Bundle ID"
          value={runtimeSnapshot.manifest.bundleId}
        />
        <InfoRow
          label="Manifest Asset Count"
          value={String(manifestAssetEntries.length)}
        />
        {selectedAssetEntry ? (
          <>
            <InfoRow
              label="Visible Asset"
              value={`${selectedAssetIndex + 1} / ${manifestAssetEntries.length}`}
            />
            <View style={styles.panelImageFrame}>
              <Image
                source={require("./src/test/_image.png")}
                style={styles.panelPreviewImage}
              />
            </View>
            <View style={styles.assetCard}>
              <Text selectable style={styles.assetName}>
                {selectedAssetEntry[0]}
              </Text>
              <Text style={styles.assetLabel}>fileHash</Text>
              <Text selectable style={styles.assetHash}>
                {selectedAssetEntry[1].fileHash}
              </Text>
              <View style={styles.stepperRow}>
                <ActionButton
                  onPress={() =>
                    setSelectedAssetIndex((current) => Math.max(current - 1, 0))
                  }
                  title="Previous Asset"
                />
                <ActionButton
                  onPress={() =>
                    setSelectedAssetIndex((current) =>
                      Math.min(current + 1, manifestAssetEntries.length - 1),
                    )
                  }
                  title="Next Asset"
                />
              </View>
            </View>
          </>
        ) : (
          <Text style={styles.emptyState}>
            No manifest assets were found for the active bundle.
          </Text>
        )}
      </PanelModal>

      <PanelModal
        onClose={closePanel}
        title="Crash Timeline"
        visible={activePanel === "crash"}
      >
        <InfoRow
          label="Crash Count"
          value={String(runtimeSnapshot.crashHistory.length)}
        />
        {selectedCrash ? (
          <>
            <InfoRow
              label="Visible Crash"
              value={`${selectedCrashIndex + 1} / ${runtimeSnapshot.crashHistory.length}`}
            />
            <View style={styles.assetCard}>
              <Text style={styles.assetLabel}>Selected Crash</Text>
              <Text selectable style={styles.assetHash}>
                {selectedCrash}
              </Text>
              <View style={styles.stepperRow}>
                <ActionButton
                  onPress={() =>
                    setSelectedCrashIndex((current) => Math.max(current - 1, 0))
                  }
                  title="Previous Crash"
                />
                <ActionButton
                  onPress={() =>
                    setSelectedCrashIndex((current) =>
                      Math.min(
                        current + 1,
                        runtimeSnapshot.crashHistory.length - 1,
                      ),
                    )
                  }
                  title="Next Crash"
                />
              </View>
            </View>
          </>
        ) : (
          <Text style={styles.emptyState}>No crashed bundles recorded.</Text>
        )}
      </PanelModal>

      <PanelModal
        onClose={closePanel}
        title="Actions"
        visible={activePanel === "actions"}
      >
        <View style={styles.actionsStack}>
          <ActionButton
            onPress={refreshRuntimeSnapshot}
            title="Refresh Runtime Snapshot"
          />
          <ActionButton onPress={reloadApp} title="Reload App" />
          <ActionButton
            onPress={clearCrashHistory}
            title="Clear Crash History"
            tone="danger"
          />
        </View>
      </PanelModal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    alignItems: "center",
    backgroundColor: "#111827",
    borderRadius: 14,
    flex: 1,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  actionButtonDanger: {
    backgroundColor: "#fff1f2",
    borderColor: "#fecdd3",
    borderWidth: 1,
  },
  actionButtonText: {
    color: "#f9fafb",
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center",
  },
  actionButtonTextDanger: {
    color: "#be123c",
  },
  actionsStack: {
    gap: 10,
    marginTop: 8,
  },
  assetCard: {
    backgroundColor: "#f3f4f6",
    borderRadius: 16,
    marginTop: 14,
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
  assetPreviewRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    marginTop: 8,
  },
  bodyText: {
    color: "#374151",
    flex: 1,
    fontSize: 14,
    lineHeight: 18,
  },
  contentContainer: {
    flex: 1,
    justifyContent: "space-between",
    padding: 18,
  },
  controlButton: {
    backgroundColor: "#fff7ed",
    borderColor: "#fdba74",
    borderRadius: 18,
    borderWidth: 1,
    flexBasis: "48%",
    flexGrow: 1,
    minHeight: 92,
    padding: 16,
  },
  controlGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 16,
  },
  controlSubtitle: {
    color: "#9a3412",
    fontSize: 12,
    lineHeight: 17,
    marginTop: 8,
  },
  controlTitle: {
    color: "#7c2d12",
    fontSize: 15,
    fontWeight: "800",
  },
  crashItem: {
    backgroundColor: "#fff7ed",
    borderRadius: 12,
    color: "#9a3412",
    fontSize: 13,
    padding: 12,
  },
  description: {
    color: "#4b5563",
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
  },
  emptyState: {
    color: "#6b7280",
    fontSize: 14,
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
    borderRadius: 18,
    padding: 16,
  },
  infoLabel: {
    color: "#6b7280",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 4,
    textTransform: "uppercase",
  },
  infoRow: {
    borderBottomColor: "#e5e7eb",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
  },
  infoValue: {
    color: "#111827",
    fontSize: 13,
    lineHeight: 18,
  },
  panelBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(15, 23, 42, 0.45)",
    flex: 1,
    justifyContent: "center",
    padding: 18,
  },
  panelCard: {
    backgroundColor: "#ffffff",
    borderRadius: 24,
    padding: 18,
    width: "100%",
  },
  panelCloseButton: {
    backgroundColor: "#111827",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  panelCloseText: {
    color: "#f9fafb",
    fontSize: 12,
    fontWeight: "700",
  },
  panelHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  panelImageFrame: {
    alignItems: "center",
    backgroundColor: "#fffbeb",
    borderRadius: 16,
    marginTop: 14,
    padding: 18,
  },
  panelPreviewImage: {
    height: 96,
    width: 96,
  },
  panelTitle: {
    color: "#111827",
    fontSize: 18,
    fontWeight: "800",
  },
  previewImage: {
    height: 72,
    width: 72,
  },
  safeArea: {
    backgroundColor: "#f8fafc",
    flex: 1,
  },
  section: {
    backgroundColor: "#ffffff",
    borderRadius: 18,
    marginTop: 12,
    padding: 16,
  },
  sectionTitle: {
    color: "#111827",
    fontSize: 17,
    fontWeight: "800",
    marginBottom: 6,
  },
  statusBlock: {
    backgroundColor: "#111827",
    borderRadius: 14,
    color: "#f9fafb",
    fontFamily: "Courier",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
    padding: 12,
  },
  stepperRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 14,
  },
  title: {
    color: "#111827",
    fontSize: 28,
    fontWeight: "800",
    marginTop: 6,
  },
});

export default HotUpdater.wrap({
  baseURL: "http://localhost:3007/hot-updater",
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
