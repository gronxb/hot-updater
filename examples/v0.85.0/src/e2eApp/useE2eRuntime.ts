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

type E2eRuntimeMemory = {
  channelActionResult: string;
  cohortActionResult: string;
  cohortInput: string | null;
  runtimeChannelInput: string;
  updateActionResult: string;
};

const e2eRuntimeMemory: E2eRuntimeMemory = {
  channelActionResult: "idle",
  cohortActionResult: "idle",
  cohortInput: null,
  runtimeChannelInput: "beta",
  updateActionResult: "idle",
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
  readonly updateActionResult: string;
  readonly updateCohortInput: (nextCohort: string) => void;
  readonly updateStoreDownloadPathsText: string;
};

export const useE2eRuntimeModel = (scenarioMarker: string): E2eRuntimeModel => {
  const notifyState = useSnapshot(notify);
  const progressState = useHotUpdaterStore((state) => state);
  const [initialCohort] = useState(() => HotUpdater.getCohort());
  const [runtimeChannelInput, setRuntimeChannelInputState] = useState(
    () => e2eRuntimeMemory.runtimeChannelInput,
  );
  const [cohortInput, setCohortInputState] = useState(
    () => e2eRuntimeMemory.cohortInput ?? initialCohort,
  );
  const cohortInputRef = useRef(cohortInput);
  const [channelActionResult, setChannelActionResultState] = useState(
    () => e2eRuntimeMemory.channelActionResult,
  );
  const [cohortActionResult, setCohortActionResultState] = useState(
    () => e2eRuntimeMemory.cohortActionResult,
  );
  const [updateActionResult, setUpdateActionResultState] = useState(
    () => e2eRuntimeMemory.updateActionResult,
  );
  const [runtimeSnapshot, setRuntimeSnapshot] = useState(readRuntimeSnapshot);

  const setRuntimeChannelInput = (input: string) => {
    e2eRuntimeMemory.runtimeChannelInput = input;
    setRuntimeChannelInputState(input);
  };

  const setCohortInput = (input: string) => {
    e2eRuntimeMemory.cohortInput = input;
    cohortInputRef.current = input;
    setCohortInputState(input);
  };

  const setChannelActionResult = (result: string) => {
    e2eRuntimeMemory.channelActionResult = result;
    setChannelActionResultState(result);
  };

  const setCohortActionResult = (result: string) => {
    e2eRuntimeMemory.cohortActionResult = result;
    setCohortActionResultState(result);
  };

  const setUpdateActionResult = (result: string) => {
    e2eRuntimeMemory.updateActionResult = result;
    setUpdateActionResultState(result);
  };

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
          ? `${actionLabel} -> installed ${updateInfo.id}`
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
    setCohortInput(appliedCohort);
    setCohortActionResult(`set -> ${appliedCohort}`);
    await refresh();
  };

  const updateCohortInput = (nextCohort: string) => {
    HotUpdater.setCohort(nextCohort);
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
    updateActionResult,
    updateCohortInput,
    updateStoreDownloadPathsText: formatUpdateStoreDownloadPaths(
      progressState.details,
    ),
  };
};
