import { HotUpdater, useHotUpdaterStore } from "@hot-updater/react-native";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import BootSplash from "react-native-bootsplash";
import { useSnapshot } from "valtio";

import type { E2eScreenState } from "../e2eRuntimeConfig";
import {
  formatUpdateStoreDownloadPaths,
  notify,
  readRuntimeSnapshot,
  refreshRuntimeSnapshot,
} from "./runtime";
import type { E2eRuntimeModel, InstallUpdateInput } from "./runtime-model";
import {
  persistScreenState,
  readPersistedScreenState,
} from "./screen-state-persistence";

const DEFAULT_ACTION_RESULT = "idle";
const DEFAULT_RUNTIME_CHANNEL_INPUT = "beta";

export const useE2eRuntimeModel = (scenarioMarker: string): E2eRuntimeModel => {
  const notifyState = useSnapshot(notify);
  const progressState = useHotUpdaterStore((state) => state);
  const [initialCohort] = useState(() => HotUpdater.getCohort());
  const [runtimeChannelInput, setRuntimeChannelInputState] = useState(
    DEFAULT_RUNTIME_CHANNEL_INPUT,
  );
  const [cohortInput, setCohortInputState] = useState(initialCohort);
  const cohortInputRef = useRef(cohortInput);
  const [channelActionResult, setChannelActionResultState] = useState(
    DEFAULT_ACTION_RESULT,
  );
  const [cohortActionResult, setCohortActionResultState] = useState(
    DEFAULT_ACTION_RESULT,
  );
  const [updateActionResult, setUpdateActionResultState] = useState(
    DEFAULT_ACTION_RESULT,
  );
  const [runtimeSnapshot, setRuntimeSnapshot] = useState(readRuntimeSnapshot);

  const applyScreenState = (screenState: E2eScreenState) => {
    setRuntimeChannelInputState(screenState.runtimeChannelInput);
    const nextCohortInput = screenState.cohortInput ?? initialCohort;
    cohortInputRef.current = nextCohortInput;
    setCohortInputState(nextCohortInput);
    setChannelActionResultState(screenState.channelActionResult);
    setCohortActionResultState(screenState.cohortActionResult);
    setUpdateActionResultState(screenState.updateActionResult);
  };

  const setRuntimeChannelInput = (input: string) => {
    setRuntimeChannelInputState(input);
    void persistScreenState({ runtimeChannelInput: input });
  };

  const setCohortInputStateAndRef = (input: string) => {
    cohortInputRef.current = input;
    setCohortInputState(input);
  };

  const setCohortInput = async (input: string) => {
    setCohortInputStateAndRef(input);
    await persistScreenState({ cohortInput: input });
  };

  const setChannelActionResult = async (result: string) => {
    setChannelActionResultState(result);
    await persistScreenState({ channelActionResult: result });
  };

  const setCohortActionResult = async (result: string) => {
    setCohortActionResultState(result);
    await persistScreenState({ cohortActionResult: result });
  };

  const setUpdateActionResult = async (result: string) => {
    setUpdateActionResultState(result);
    await persistScreenState({ updateActionResult: result });
  };

  useEffect(() => {
    let isMounted = true;
    readPersistedScreenState().then((screenState) => {
      if (!isMounted || !screenState) return;
      applyScreenState(screenState);
    });
    return () => {
      isMounted = false;
    };
  }, [initialCohort]);

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
      await setUpdateActionResult(`${actionLabel} -> checking`);
      const updateInfo = await HotUpdater.checkForUpdate({
        updateStrategy: "appVersion",
        ...(channel ? { channel } : {}),
      });

      if (!updateInfo) {
        await setUpdateActionResult(`${actionLabel} -> no-update`);
        await refresh();
        return;
      }

      const installed = await updateInfo.updateBundle();
      await setUpdateActionResult(
        installed
          ? `${actionLabel} -> installed ${updateInfo.id}`
          : `${actionLabel} -> skipped`,
      );
      await refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to install update";
      await setUpdateActionResult(`${actionLabel} -> error ${message}`);
    }
  };

  const installRuntimeChannelUpdate = async () => {
    const persistedScreenState = await readPersistedScreenState();
    const normalizedChannel = (
      persistedScreenState?.runtimeChannelInput ?? runtimeChannelInput
    )
      .trim()
      .toLowerCase();
    if (!normalizedChannel) {
      await setChannelActionResult("runtime-channel -> invalid");
      return;
    }

    await setChannelActionResult(`runtime-channel -> ${normalizedChannel}`);
    await installUpdate({
      actionLabel: `runtime-channel:${normalizedChannel}`,
      channel: normalizedChannel,
    });
  };

  const resetRuntimeChannel = async () => {
    try {
      const didReset = await HotUpdater.resetChannel();
      await refresh();
      await setChannelActionResult(`reset -> ${String(didReset)}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to reset channel";
      await setChannelActionResult(`reset -> error ${message}`);
    }
  };

  const applyCohortValue = async (nextCohort: string) => {
    HotUpdater.setCohort(nextCohort);
    const appliedCohort = HotUpdater.getCohort();
    await setCohortInput(appliedCohort);
    await setCohortActionResult(`set -> ${appliedCohort}`);
    await refresh();
  };

  const updateCohortInput = (nextCohort: string) => {
    HotUpdater.setCohort(nextCohort);
    setCohortInputStateAndRef(nextCohort);
    void persistScreenState({ cohortInput: nextCohort });
  };

  const applyCohortInput = async () => {
    try {
      const persistedScreenState = await readPersistedScreenState();
      await applyCohortValue(
        persistedScreenState?.cohortInput ?? cohortInputRef.current,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to set cohort";
      await setCohortActionResult(`set -> error ${message}`);
    }
  };

  const restoreInitialCohort = async () => {
    await applyCohortValue(initialCohort);
    await setCohortActionResult(`restore -> ${HotUpdater.getCohort()}`);
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
