/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import { HOT_UPDATER_APP_BASE_URL } from "@env";
import {
  HotUpdater,
  type HotUpdaterFallbackComponentProps,
  useHotUpdaterStore,
} from "@hot-updater/react-native";
import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  Image,
  Keyboard,
  type LayoutChangeEvent,
  Modal,
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

const notify = proxy<{
  status?: string;
  crashedBundleId?: string;
}>({});

const DEFAULT_APP_BASE_URL = "http://localhost:3007/hot-updater";
const HOT_UPDATER_BASE_URL = HOT_UPDATER_APP_BASE_URL || DEFAULT_APP_BASE_URL;
const E2E_SCENARIO_MARKER = "targeted-qa-maestro";
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

type ScrollTarget =
  | "actionResults"
  | "actions"
  | "cohortActions"
  | "crashHistory";

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

const ActionButton = ({
  onPress,
  testID,
  title,
}: {
  onPress: () => void | Promise<void>;
  testID?: string;
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
    testID={testID ?? title}
  >
    <Text style={styles.actionButtonText}>{title}</Text>
  </Pressable>
);

const E2ENavButton = ({
  onPress,
  testID,
  title,
}: {
  onPress: () => void;
  testID: string;
  title: string;
}) => (
  <Pressable
    accessibilityLabel={title}
    accessibilityRole="button"
    onPress={onPress}
    style={({ pressed }) => [
      styles.e2eNavButton,
      pressed ? styles.e2eNavButtonPressed : null,
    ]}
    testID={testID}
  >
    <Text style={styles.e2eNavButtonText}>{title}</Text>
  </Pressable>
);

const formatFallbackPercent = (value: number | null | undefined) => {
  if (typeof value !== "number") {
    return "pending";
  }

  return `${Math.round(value * 100)}%`;
};

const MAX_VISIBLE_COMPLETED_FILES = 5;

const UpdateFallbackModal = ({
  artifactType,
  details,
  message,
  progress,
  status,
}: HotUpdaterFallbackComponentProps) => {
  const isDiffUpdate = artifactType === "diff" && details !== null;
  const statusTitle =
    status === "UPDATING" ? "Updating..." : "Checking for Update...";
  const stageText =
    status === "CHECK_FOR_UPDATE"
      ? "Looking for the latest bundle"
      : artifactType === "diff"
        ? "Applying diff update"
        : "Preparing archive update";
  const currentFiles = isDiffUpdate
    ? details.files.filter((file) => file.status === "downloading")
    : [];
  const completedFiles = isDiffUpdate
    ? details.files
        .filter((file) => file.status === "downloaded")
        .slice(-MAX_VISIBLE_COMPLETED_FILES)
    : [];
  const failedFiles = isDiffUpdate
    ? details.files.filter((file) => file.status === "failed")
    : [];
  const pendingFilesCount = isDiffUpdate
    ? details.files.filter((file) => file.status === "pending").length
    : 0;

  return (
    <Modal transparent visible={true}>
      <View style={styles.fallbackOverlay}>
        <View style={styles.fallbackCard}>
          <Text style={styles.fallbackTitle} testID="fallback-status-title">
            {statusTitle}
          </Text>
          <Text
            style={styles.fallbackProgressValue}
            testID="fallback-total-progress"
          >
            {formatFallbackPercent(progress)}
          </Text>
          <Text style={styles.fallbackMetaText} testID="fallback-artifact-type">
            {stageText}
          </Text>
          {isDiffUpdate ? (
            <>
              <Text
                style={styles.fallbackMetaText}
                testID="fallback-total-files"
              >
                totalFilesCount: {details.totalFilesCount}
              </Text>
              <Text
                style={styles.fallbackMetaText}
                testID="fallback-completed-files"
              >
                completedFilesCount: {details.completedFilesCount}
              </Text>
              <Text
                style={styles.fallbackMetaText}
                testID="fallback-file-summary"
              >
                fileSummary: pending {pendingFilesCount} / active{" "}
                {currentFiles.length} / failed {failedFiles.length}
              </Text>
              {currentFiles.length > 0 ? (
                <>
                  <Text
                    style={styles.fallbackMetaText}
                    testID="fallback-current-files-title"
                  >
                    currentFiles:
                  </Text>
                  {currentFiles.map((file) => (
                    <Text
                      key={`current-${file.path}`}
                      style={styles.fallbackMetaText}
                      testID={`fallback-current-file-${file.order}`}
                    >
                      - {file.path} ({formatFallbackPercent(file.progress)})
                    </Text>
                  ))}
                </>
              ) : (
                <Text
                  style={styles.fallbackMetaText}
                  testID="fallback-current-files-empty"
                >
                  currentFiles: none
                </Text>
              )}
              {completedFiles.length > 0 ? (
                <>
                  <Text
                    style={styles.fallbackMetaText}
                    testID="fallback-completed-files-title"
                  >
                    completedFiles (latest {completedFiles.length}/
                    {details.completedFilesCount}):
                  </Text>
                  {completedFiles.map((file) => (
                    <Text
                      key={`completed-${file.path}`}
                      style={styles.fallbackMetaText}
                      testID={`fallback-completed-file-${file.order}`}
                    >
                      - {file.path}
                    </Text>
                  ))}
                </>
              ) : (
                <Text
                  style={styles.fallbackMetaText}
                  testID="fallback-completed-files-empty"
                >
                  completedFiles: none yet
                </Text>
              )}
            </>
          ) : null}
          {message ? (
            <Text style={styles.fallbackMetaText} testID="fallback-message">
              message: {message}
            </Text>
          ) : null}
        </View>
      </View>
    </Modal>
  );
};

function App(): React.JSX.Element {
  const notifyState = useSnapshot(notify);
  const progress = useHotUpdaterStore((state) => state.progress);
  const scrollViewRef = useRef<ScrollView>(null);
  const sectionOffsets = useRef<Record<ScrollTarget, number>>({
    actionResults: 0,
    actions: 0,
    cohortActions: 0,
    crashHistory: 0,
  });
  const [initialCohort] = useState(() => HotUpdater.getCohort());
  const [runtimeChannelInput, setRuntimeChannelInput] = useState("beta");
  const [cohortInput, setCohortInput] = useState(() => initialCohort);
  const cohortInputRef = useRef(initialCohort);
  const [channelActionResult, setChannelActionResult] = useState("idle");
  const [cohortActionResult, setCohortActionResult] = useState("idle");
  const [updateActionResult, setUpdateActionResult] = useState("idle");
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
  const hasLargeE2EAsset = manifestAssetEntries.some(
    ([fileName]) => fileName === E2E_LARGE_ARCHIVE_ASSET_MANIFEST_PATH,
  );
  const statusPayload = JSON.stringify(notifyState, null, 2);
  const launchStatusText = `Current Launch Status: ${notifyState.status ?? "null"}`;
  const crashedBundleText = `Current Crashed Bundle ID: ${notifyState.crashedBundleId ?? "null"}`;
  const channelSummary = `current=${runtimeSnapshot.channel} default=${runtimeSnapshot.defaultChannel} switched=${String(runtimeSnapshot.isChannelSwitched)}`;
  const cohortSummary = `current=${runtimeSnapshot.cohort} initial=${initialCohort}`;

  const refreshRuntimeSnapshot = () => {
    setRuntimeSnapshot(readRuntimeSnapshot());
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
      y: Math.max(sectionOffsets.current[target] - 12, 0),
    });
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
        refreshRuntimeSnapshot();
        return;
      }

      const installed = await updateInfo.updateBundle();
      setUpdateActionResult(
        installed
          ? `${actionLabel} -> installed ${updateInfo.id} (${updateInfo.status})`
          : `${actionLabel} -> skipped`,
      );
      refreshRuntimeSnapshot();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to install update";
      setUpdateActionResult(`${actionLabel} -> error ${message}`);
    }
  };

  const installCurrentChannelUpdate = async () => {
    await installUpdate({
      actionLabel: "current-channel",
    });
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
      refreshRuntimeSnapshot();
      setChannelActionResult(`reset -> ${String(didReset)}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to reset channel";
      setChannelActionResult(`reset -> error ${message}`);
    }
  };

  const applyCohortValue = (nextCohort: string) => {
    HotUpdater.setCohort(nextCohort);
    const appliedCohort = HotUpdater.getCohort();
    cohortInputRef.current = appliedCohort;
    setCohortInput(appliedCohort);
    refreshRuntimeSnapshot();
    setCohortActionResult(`set -> ${appliedCohort}`);
  };

  const applyCohortInput = () => {
    try {
      applyCohortValue(cohortInputRef.current);
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

  const submitCohortInput = (nextCohort: string) => {
    updateCohortInput(nextCohort);

    try {
      applyCohortValue(nextCohort);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to set cohort";
      setCohortActionResult(`set -> error ${message}`);
    }
  };

  const setQaCohort = () => {
    applyCohortValue("qa");
  };

  const restoreInitialCohort = () => {
    applyCohortValue(initialCohort);
    setCohortActionResult(`restore -> ${HotUpdater.getCohort()}`);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.e2eNavBar}>
        <E2ENavButton
          onPress={scrollToTop}
          testID="e2e-nav-top"
          title="Jump to Top"
        />
        <E2ENavButton
          onPress={() => scrollToSection("crashHistory")}
          testID="e2e-nav-crash-history"
          title="Jump to Crash History"
        />
        <E2ENavButton
          onPress={() => scrollToSection("actions")}
          testID="e2e-nav-actions"
          title="Jump to Actions"
        />
        <E2ENavButton
          onPress={() => scrollToSection("cohortActions")}
          testID="e2e-nav-cohort-actions"
          title="Jump to Cohorts"
        />
        <E2ENavButton
          onPress={() => scrollToSection("actionResults")}
          testID="e2e-nav-action-results"
          title="Jump to Results"
        />
      </View>
      <ScrollView
        ref={scrollViewRef}
        contentContainerStyle={styles.contentContainer}
        keyboardShouldPersistTaps="always"
        showsVerticalScrollIndicator={false}
      >
        <Section
          title="Runtime Snapshot"
          titleTestID="section-runtime-snapshot"
        >
          <InfoRow
            label="Bundle ID"
            value={runtimeSnapshot.bundleId}
            valueTestID="runtime-bundle-id"
          />
          <InfoRow
            label="Manifest Bundle ID"
            value={runtimeSnapshot.manifest.bundleId}
          />
          <InfoRow
            label="Bundle Timestamp"
            value={extractFormatDateFromUUIDv7(runtimeSnapshot.bundleId)}
          />
          <InfoRow label="Min Bundle ID" value={runtimeSnapshot.minBundleId} />
          <InfoRow
            label="Large E2E Asset"
            value={hasLargeE2EAsset ? "present" : "missing"}
            valueTestID="runtime-large-e2e-asset"
          />
          <InfoRow
            label="E2E Scenario Marker"
            value={E2E_SCENARIO_MARKER}
            valueTestID="runtime-scenario-marker"
          />
        </Section>

        <Section title="Launch Status" titleTestID="section-launch-status">
          <InfoRow
            label="Download Progress"
            value={`${Math.round(progress * 100)}%`}
          />
          <Text
            selectable
            style={styles.actionResult}
            testID="launch-status-result"
          >
            {launchStatusText}
          </Text>
          <Text
            selectable
            style={styles.actionResult}
            testID="launch-crashed-bundle-result"
          >
            {crashedBundleText}
          </Text>
          <Text selectable style={styles.codeBlock}>
            {statusPayload}
          </Text>
        </Section>

        <Section
          onLayout={recordSectionOffset("crashHistory")}
          titleTestID="section-crash-history"
          title={`Crash History (${runtimeSnapshot.crashHistory.length})`}
        >
          {runtimeSnapshot.crashHistory.length === 0 ? (
            <Text
              style={styles.emptyState}
              testID="crash-history-empty-state"
            >
              No crashed bundles recorded.
            </Text>
          ) : (
            runtimeSnapshot.crashHistory.map((crash) => (
              <Text key={crash} selectable style={styles.crashItem}>
                {crash}
              </Text>
            ))
          )}
        </Section>

        <Section
          title="OTA Asset Preview"
          titleTestID="section-ota-asset-preview"
        >
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

        <Section
          title={`Manifest Assets (${manifestAssetEntries.length})`}
          titleTestID="section-manifest-assets"
        >
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

        <Section title="Runtime Details" titleTestID="section-runtime-details">
          <InfoRow label="Base URL" value={HOT_UPDATER_BASE_URL} />
          <InfoRow label="Channel" value={runtimeSnapshot.channel} />
          <InfoRow label="Cohort" value={runtimeSnapshot.cohort} />
          <InfoRow label="Channel Summary" value={channelSummary} />
          <InfoRow label="Cohort Summary" value={cohortSummary} />
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

        <Section
          onLayout={recordSectionOffset("actions")}
          title="Actions"
          titleTestID="section-actions"
        >
          <Text
            selectable
            style={styles.actionResult}
            testID="current-channel-summary"
          >
            Current Channel Summary: {channelSummary}
          </Text>
          <Text
            selectable
            style={styles.actionResult}
            testID="current-cohort-summary"
          >
            Current Cohort Summary: {cohortSummary}
          </Text>
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Runtime Channel Input</Text>
            <TextInput
              accessibilityLabel="Runtime Channel Input"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setRuntimeChannelInput}
              onEndEditing={(event) =>
                setRuntimeChannelInput(event.nativeEvent.text)
              }
              onSubmitEditing={(event) =>
                setRuntimeChannelInput(event.nativeEvent.text)
              }
              placeholder="beta"
              placeholderTextColor="#94a3b8"
              style={styles.inputField}
              testID="runtime-channel-input"
              value={runtimeChannelInput}
            />
          </View>
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Cohort Override Input</Text>
            <TextInput
              accessibilityLabel="Cohort Override Input"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="default"
              onChangeText={updateCohortInput}
              onEndEditing={(event) =>
                updateCohortInput(event.nativeEvent.text)
              }
              onSubmitEditing={(event) =>
                submitCohortInput(event.nativeEvent.text)
              }
              placeholder={initialCohort}
              placeholderTextColor="#94a3b8"
              style={styles.inputField}
              testID="cohort-input"
              value={cohortInput}
            />
          </View>
          <View style={styles.buttonBlock}>
            <ActionButton
              title="Refresh Runtime Snapshot"
              onPress={refreshRuntimeSnapshot}
              testID="action-refresh-runtime-snapshot"
            />
          </View>
          <View style={styles.buttonBlock}>
            <ActionButton
              title="Reload App"
              onPress={reloadApp}
              testID="action-reload-app"
            />
          </View>
          <View style={styles.buttonBlock}>
            <ActionButton
              title="Clear Crash History"
              onPress={clearCrashHistory}
              testID="action-clear-crash-history"
            />
          </View>
          <View style={styles.buttonBlock}>
            <ActionButton
              title="Install Current Channel Update"
              onPress={installCurrentChannelUpdate}
              testID="action-install-current-channel-update"
            />
          </View>
          <View style={styles.buttonBlock}>
            <ActionButton
              title="Install Runtime Channel Update"
              onPress={installRuntimeChannelUpdate}
              testID="action-install-runtime-channel-update"
            />
          </View>
          <View style={styles.buttonBlock}>
            <ActionButton
              title="Reset Runtime Channel"
              onPress={resetRuntimeChannel}
              testID="action-reset-runtime-channel"
            />
          </View>
          <View style={styles.buttonBlock}>
            <ActionButton
              title="Apply Cohort Input"
              onPress={applyCohortInput}
              testID="action-apply-cohort-input"
            />
          </View>
        </Section>

        <Section
          onLayout={recordSectionOffset("cohortActions")}
          title="Cohort Actions"
          titleTestID="section-cohort-actions"
        >
          <View style={styles.buttonBlock}>
            <ActionButton
              title="Set Cohort qa"
              onPress={setQaCohort}
              testID="action-set-cohort-qa"
            />
          </View>
          <View style={styles.buttonBlock}>
            <ActionButton
              title="Restore Initial Cohort"
              onPress={restoreInitialCohort}
              testID="action-restore-initial-cohort"
            />
          </View>
        </Section>

        <Section
          onLayout={recordSectionOffset("actionResults")}
          title="Action Results"
          titleTestID="section-action-results"
        >
          <Text
            selectable
            style={styles.actionResult}
            testID="channel-action-result"
          >
            Channel Action Result: {channelActionResult}
          </Text>
          <Text
            selectable
            style={styles.actionResult}
            testID="update-action-result"
          >
            Update Action Result: {updateActionResult}
          </Text>
          <Text
            selectable
            style={styles.actionResult}
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
  e2eNavBar: {
    backgroundColor: "#e2e8f0",
    borderBottomColor: "#cbd5e1",
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  e2eNavButton: {
    alignItems: "center",
    backgroundColor: "#dbeafe",
    borderRadius: 999,
    flex: 1,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  e2eNavButtonPressed: {
    backgroundColor: "#bfdbfe",
  },
  e2eNavButtonText: {
    color: "#1e3a8a",
    fontSize: 12,
    fontWeight: "700",
    textAlign: "center",
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
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  fallbackCard: {
    backgroundColor: "rgba(15, 23, 42, 0.9)",
    borderRadius: 20,
    gap: 8,
    maxWidth: 360,
    paddingHorizontal: 20,
    paddingVertical: 18,
    width: "100%",
  },
  fallbackMetaText: {
    color: "#e2e8f0",
    fontSize: 13,
    lineHeight: 18,
  },
  fallbackProgressValue: {
    color: "#ffffff",
    fontSize: 26,
    fontWeight: "800",
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
  inputField: {
    backgroundColor: "#eff6ff",
    borderColor: "#bfdbfe",
    borderRadius: 14,
    borderWidth: 1,
    color: "#0f172a",
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  inputGroup: {
    marginTop: 12,
  },
  inputLabel: {
    color: "#1e293b",
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 8,
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
  fallbackComponent: UpdateFallbackModal,
  onError: (error) => {
    console.error(error);
  },
})(App);
