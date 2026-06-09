import { HotUpdater, useHotUpdaterStore } from "@hot-updater/react-native";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import BootSplash from "react-native-bootsplash";
import { useSnapshot } from "valtio";

import {
  formatUpdateStoreDownloadPaths,
  notify,
  readRuntimeSnapshot,
  refreshRuntimeSnapshot,
  type RuntimeSnapshot,
} from "./runtime";

type InstallUpdateInput = {
  readonly actionLabel: string;
  readonly channel?: string;
};

export type E2eRuntimeModel = {
  readonly applyCohortInput: () => Promise<void>;
  readonly channelActionResult: string;
  readonly clearCrashHistory: () => Promise<void>;
  readonly cohortActionResult: string;
  readonly cohortInput: string;
  readonly crashedBundleText: string;
  readonly initialCohort: string;
  readonly installRuntimeChannelUpdate: () => Promise<void>;
  readonly installUpdate: (input: InstallUpdateInput) => Promise<void>;
  readonly isUpdateDownloaded: boolean;
  readonly launchStatusText: string;
  readonly reloadApp: () => Promise<void>;
  readonly resetRuntimeChannel: () => Promise<void>;
  readonly restoreInitialCohort: () => Promise<void>;
  readonly runtimeChannelInput: string;
  readonly runtimeSnapshot: RuntimeSnapshot;
  readonly refreshRuntimeSnapshot: () => Promise<void>;
  readonly scenarioMarker: string;
  readonly setCohortToQa: () => Promise<void>;
  readonly setRuntimeChannelInput: (nextChannel: string) => void;
  readonly updateActionStart: string;
  readonly updateActionResult: string;
  readonly updateCohortInput: (nextCohort: string) => void;
  readonly updateStoreDownloadPathsText: string;
};

export const useE2eRuntimeModel = (scenarioMarker: string): E2eRuntimeModel => {
  const notifyState = useSnapshot(notify);
  const progressState = useHotUpdaterStore((state) => state);
  const [initialCohort] = useState(() => HotUpdater.getCohort());
  const [runtimeChannelInput, setRuntimeChannelInput] = useState("beta");
  const [cohortInput, setCohortInput] = useState(() => initialCohort);
  const cohortInputRef = useRef(initialCohort);
  const [channelActionResult, setChannelActionResult] = useState("idle");
  const [cohortActionResult, setCohortActionResult] = useState("idle");
  const [updateActionStart, setUpdateActionStart] = useState("idle");
  const [updateActionResult, setUpdateActionResult] = useState("idle");
  const [runtimeSnapshot, setRuntimeSnapshot] = useState(readRuntimeSnapshot);

  useEffect(() => {
    const timeout = setTimeout(() => {
      BootSplash.hide({ fade: false }).catch(() => undefined);
    }, 1000);

    return () => clearTimeout(timeout);
  }, []);

  const refresh = async () => {
    setRuntimeSnapshot(await refreshRuntimeSnapshot());
  };

  const clearCrashHistory = async () => {
    HotUpdater.clearCrashHistory();
    await refresh();
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
  }: InstallUpdateInput) => {
    try {
      setUpdateActionStart(`${actionLabel} -> started`);
      setUpdateActionResult(`${actionLabel} -> checking`);
      const updateInfo = await HotUpdater.checkForUpdate({
        updateStrategy: "appVersion",
        ...(channel ? { channel } : {}),
      });

      if (!updateInfo) {
        setUpdateActionResult(`${actionLabel} -> no-update`);
        await refresh();
        return;
      }

      const installed = await updateInfo.updateBundle();
      setUpdateActionResult(
        installed
          ? `${actionLabel} -> installed ${updateInfo.id} (${updateInfo.status})`
          : `${actionLabel} -> skipped`,
      );
      await refresh();
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
      await refresh();
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
    setCohortActionResult(`set -> ${appliedCohort}`);
    await refresh();
  };

  const updateCohortInput = (nextCohort: string) => {
    cohortInputRef.current = nextCohort;
    setCohortInput(nextCohort);
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

  const restoreInitialCohort = async () => {
    await applyCohortValue(initialCohort);
    setCohortActionResult(`restore -> ${HotUpdater.getCohort()}`);
  };

  return {
    applyCohortInput,
    channelActionResult,
    clearCrashHistory,
    cohortActionResult,
    cohortInput,
    crashedBundleText: `Current Crashed Bundle ID: ${
      notifyState.crashedBundleId ?? "null"
    }`,
    initialCohort,
    installRuntimeChannelUpdate,
    installUpdate,
    isUpdateDownloaded: progressState.isUpdateDownloaded,
    launchStatusText: `Current Launch Status: ${notifyState.status ?? "null"}`,
    reloadApp,
    resetRuntimeChannel,
    restoreInitialCohort,
    runtimeChannelInput,
    runtimeSnapshot,
    refreshRuntimeSnapshot: refresh,
    scenarioMarker,
    setCohortToQa: () => applyCohortValue("qa"),
    setRuntimeChannelInput,
    updateActionStart,
    updateActionResult,
    updateCohortInput,
    updateStoreDownloadPathsText: formatUpdateStoreDownloadPaths(
      progressState.details,
    ),
  };
};
