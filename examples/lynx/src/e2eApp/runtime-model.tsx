import { HotUpdater } from "@hot-updater/lynx";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "@lynx-js/react";

import { E2E_SCENARIO_MARKER } from "./patchSurface";

declare const __E2E_OVERLAY_MARKER__: string;
declare const __E2E_RUNTIME_CONFIG_URL__: string;

export const scenarioMarker =
  typeof __E2E_OVERLAY_MARKER__ === "string" &&
  __E2E_OVERLAY_MARKER__.length > 0
    ? __E2E_OVERLAY_MARKER__
    : E2E_SCENARIO_MARKER;

const DEFAULT_ACTION_RESULT = "idle";

type ScreenState = {
  channelActionResult: string;
  cohortActionResult: string;
  cohortInput: string | null;
  currentChannel: string | null;
  defaultChannel: string | null;
  channelSwitched: string | null;
  launchStatus: string;
  runtimeChannelInput: string;
  runtimeScenarioMarker: string | null;
  stagingBundleId: string | null;
  stagingReleaseId: string | null;
  stableBundleId: string | null;
  stableReleaseId: string | null;
  updateActionResult: string;
  verificationPending: boolean | null;
};

const runtimeConfigURL =
  typeof __E2E_RUNTIME_CONFIG_URL__ === "string" && __E2E_RUNTIME_CONFIG_URL__
    ? __E2E_RUNTIME_CONFIG_URL__
    : "http://localhost:3107/e2e/runtime-config";
export const screenStateURL = runtimeConfigURL.endsWith("/runtime-config")
  ? runtimeConfigURL.replace(/\/runtime-config$/, "/screen-state")
  : `${runtimeConfigURL.replace(/\/+$/, "")}/screen-state`;
export const pendingActionURL = screenStateURL.replace(
  /\/screen-state$/,
  "/pending-action",
);

export const patchScreenState = async (patch: Partial<ScreenState>) => {
  await fetch(screenStateURL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
};

export const actionHandlers: {
  current: Record<string, (text?: string) => Promise<void>>;
} = { current: {} };

export let handledScenarioAction = false;

export const markScenarioActionHandled = (): void => {
  handledScenarioAction = true;
};

export type E2eRuntime = {
  actions: Record<string, (text?: string) => Promise<void>>;
  bundleId: string;
  channelActionResult: string;
  channelSwitched: string;
  cohortActionResult: string;
  cohortInput: string;
  crashHistoryCount: string;
  currentChannel: string;
  currentCohort: string;
  defaultChannel: string;
  launchStatus: string;
  releaseId: string;
  runtimeChannelInput: string;
  scenarioMarker: string;
  updateActionResult: string;
};

const E2eRuntimeContext = createContext<E2eRuntime | null>(null);

export function useE2eRuntime(): E2eRuntime {
  const value = useContext(E2eRuntimeContext);
  if (!value) {
    throw new Error("E2eRuntimeProvider is required");
  }
  return value;
}

export function E2eRuntimeProvider({
  children,
}: {
  children: JSX.Element;
}): JSX.Element {
  const [updateActionResult, setUpdateActionResultState] = useState(
    DEFAULT_ACTION_RESULT,
  );
  const [channelActionResult, setChannelActionResultState] = useState(
    DEFAULT_ACTION_RESULT,
  );
  const [cohortActionResult, setCohortActionResultState] = useState(
    DEFAULT_ACTION_RESULT,
  );
  const [cohortInput, setCohortInputState] = useState("1");
  const [runtimeChannelInput, setRuntimeChannelInput] = useState("beta");
  const [launchStatus, setLaunchStatus] = useState(
    "Current Launch Status: null",
  );
  const capturedUpdate = useRef<Awaited<
    ReturnType<typeof HotUpdater.checkForUpdate>
  > | null>(null);

  const setUpdateActionResult = async (result: string) => {
    setUpdateActionResultState(result);
    await patchScreenState({ updateActionResult: result });
  };
  const setChannelActionResult = async (result: string) => {
    setChannelActionResultState(result);
    await patchScreenState({ channelActionResult: result });
  };
  const setCohortActionResult = async (result: string) => {
    setCohortActionResultState(result);
    await patchScreenState({ cohortActionResult: result });
  };

  const installUpdate = async ({
    actionLabel,
    channel,
    strategy = "appVersion",
  }: {
    actionLabel: string;
    channel?: string;
    strategy?: "appVersion" | "fingerprint";
  }) => {
    await setUpdateActionResult(`${actionLabel} -> checking`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const updateInfo = await HotUpdater.checkForUpdate({
          updateStrategy: strategy,
          ...(channel ? { channel } : {}),
        });
        if (!updateInfo) {
          await setUpdateActionResult(`${actionLabel} -> no-update`);
          return;
        }
        const installed = await updateInfo.updateBundle();
        const appliedResult =
          updateInfo.transitionKind === "ADOPT_RELEASE"
            ? `${actionLabel} -> adopted ID ${updateInfo.id}`
            : updateInfo.transitionKind === "USE_EMBEDDED"
              ? `${actionLabel} -> selected EMBEDDED ID ${updateInfo.id}`
              : updateInfo.transitionKind === "USE_BUILTIN"
                ? `${actionLabel} -> selected BUILTIN`
                : `${actionLabel} -> installed ID ${updateInfo.id}`;
        let stagingBundleId: string | null = updateInfo.id;
        let stagingReleaseId: string | null = updateInfo.releaseId ?? null;
        let stableBundleId: string | null = null;
        let verificationPending: boolean | null = installed;
        try {
          const active = HotUpdater.getActiveUpdateState();
          stagingBundleId = active.activeSelection?.bundleId ?? stagingBundleId;
          stagingReleaseId =
            active.activeSelection?.releaseId ?? stagingReleaseId;
          stableBundleId = active.stableSelection?.bundleId ?? null;
          verificationPending = active.verificationPending;
        } catch {
          // Native snapshot may not be readable until notifyAppReady.
        }
        await patchScreenState({
          stagingBundleId,
          stagingReleaseId,
          stableBundleId,
          verificationPending,
        });
        await setUpdateActionResult(
          installed ? appliedResult : `${actionLabel} -> skipped`,
        );
        return;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to install update";
        const retryable =
          message.includes("Native revision changed") ||
          message.includes("STALE_STATE") ||
          message.includes("STALE_SELECTION") ||
          message.includes("HTTP 499") ||
          message.includes("timed out");
        if (retryable && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        await setUpdateActionResult(`${actionLabel} -> error ${message}`);
        return;
      }
    }
  };

  const applyCohortValue = async (nextCohort: string) => {
    await Promise.resolve(HotUpdater.setCohort(nextCohort));
    const applied = HotUpdater.getCohort();
    setCohortInputState(applied);
    await patchScreenState({ cohortInput: applied });
    await setCohortActionResult(`set -> ${applied}`);
  };

  const actions: Record<string, (text?: string) => Promise<void>> = {
    "action-install-current-channel-update": () =>
      installUpdate({ actionLabel: "current-channel" }),
    "action-install-fingerprint-update": () =>
      installUpdate({ actionLabel: "fingerprint", strategy: "fingerprint" }),
    "action-install-runtime-channel-update": async () => {
      const normalizedChannel = runtimeChannelInput.trim().toLowerCase();
      if (!normalizedChannel) {
        await setChannelActionResult("runtime-channel -> invalid");
        return;
      }
      await setChannelActionResult(`runtime-channel -> ${normalizedChannel}`);
      await installUpdate({
        actionLabel: `runtime-channel:${normalizedChannel}`,
        channel: normalizedChannel,
      });
    },
    "action-reset-runtime-channel": async () => {
      const didReset = await HotUpdater.resetChannel();
      await setChannelActionResult(`reset -> ${String(didReset)}`);
    },
    "action-apply-cohort-input": () =>
      applyCohortValue(HotUpdater.getCohort() || cohortInput),
    "action-set-cohort-qa": () => applyCohortValue("qa"),
    "action-restore-initial-cohort": async () => {
      await applyCohortValue("1");
      await setCohortActionResult(`restore -> ${HotUpdater.getCohort()}`);
    },
    "action-clear-crash-history": async () => {
      HotUpdater.clearCrashHistory();
    },
    "action-reload-app": async () => {
      await HotUpdater.reload();
    },
    "action-refresh-runtime-snapshot": async () => {
      await HotUpdater.notifyAppReady();
    },
    "action-capture-current-channel-update": async () => {
      const updateInfo = await HotUpdater.checkForUpdate({
        updateStrategy: "appVersion",
      });
      capturedUpdate.current = updateInfo;
      await setUpdateActionResult(
        updateInfo
          ? `captured-update -> Release ${updateInfo.releaseId ?? "legacy"}`
          : "captured-update -> no-update",
      );
    },
    "action-apply-captured-update": async () => {
      const updateInfo = capturedUpdate.current;
      if (!updateInfo) {
        await setUpdateActionResult("captured-update -> missing");
        return;
      }
      const installed = await updateInfo.updateBundle();
      await setUpdateActionResult(
        installed
          ? `captured-update -> installed Release ${updateInfo.releaseId ?? "legacy"}`
          : "captured-update -> skipped",
      );
    },
    "cohort-input": async (text) => {
      if (text === undefined) return;
      await Promise.resolve(HotUpdater.setCohort(text));
      setCohortInputState(text);
      await patchScreenState({ cohortInput: text });
    },
    "runtime-channel-input": async (text) => {
      if (text === undefined) return;
      setRuntimeChannelInput(text);
      await patchScreenState({ runtimeChannelInput: text });
    },
  };
  actionHandlers.current = actions;
  void patchScreenState({ runtimeScenarioMarker: scenarioMarker });

  const publishRuntimeSnapshot = async (launchStatusValue?: string) => {
    const patch: Partial<ScreenState> = {
      runtimeScenarioMarker: scenarioMarker,
    };
    if (launchStatusValue) {
      patch.launchStatus = launchStatusValue;
    }
    try {
      const active = HotUpdater.getActiveUpdateState();
      patch.stagingBundleId = active.activeSelection?.bundleId ?? null;
      patch.stagingReleaseId = active.activeSelection?.releaseId ?? null;
      patch.stableBundleId = active.stableSelection?.bundleId ?? null;
      patch.stableReleaseId = active.stableSelection?.releaseId ?? null;
      patch.verificationPending = active.verificationPending;
      patch.currentChannel = HotUpdater.getChannel();
      patch.defaultChannel = HotUpdater.getDefaultChannel();
      patch.channelSwitched = String(HotUpdater.isChannelSwitched());
    } catch {
      // Native snapshot may not be readable until notifyAppReady.
    }
    await patchScreenState(patch);
  };

  useEffect(() => {
    void HotUpdater.notifyAppReady()
      .then((result) => {
        const status = `Current Launch Status: ${result.status}`;
        setLaunchStatus(status);
        void publishRuntimeSnapshot(status);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const status = `Current Launch Status: ERROR ${message}`;
        setLaunchStatus(status);
        void publishRuntimeSnapshot(status);
      });
  }, []);

  const activeSelection = (() => {
    try {
      return HotUpdater.getActiveUpdateState();
    } catch {
      return null;
    }
  })();
  const crashHistoryCount = (() => {
    try {
      return String(HotUpdater.getCrashHistory().length);
    } catch {
      return "0";
    }
  })();
  const currentChannel = (() => {
    try {
      return HotUpdater.getChannel();
    } catch {
      return "";
    }
  })();
  const defaultChannel = (() => {
    try {
      return HotUpdater.getDefaultChannel();
    } catch {
      return "";
    }
  })();
  const channelSwitched = (() => {
    try {
      return String(HotUpdater.isChannelSwitched());
    } catch {
      return "false";
    }
  })();
  const currentCohort = (() => {
    try {
      return HotUpdater.getCohort();
    } catch {
      return cohortInput;
    }
  })();
  const bundleId =
    activeSelection?.activeSelection?.bundleId ??
    (() => {
      try {
        return HotUpdater.getBundleId();
      } catch {
        return "";
      }
    })();
  const releaseId = activeSelection?.activeSelection?.releaseId ?? "";

  const value = useMemo<E2eRuntime>(
    () => ({
      actions,
      bundleId,
      channelActionResult,
      channelSwitched,
      cohortActionResult,
      cohortInput,
      crashHistoryCount,
      currentChannel,
      currentCohort,
      defaultChannel,
      launchStatus,
      releaseId,
      runtimeChannelInput,
      scenarioMarker,
      updateActionResult,
    }),
    [
      actions,
      bundleId,
      channelActionResult,
      channelSwitched,
      cohortActionResult,
      cohortInput,
      crashHistoryCount,
      currentChannel,
      currentCohort,
      defaultChannel,
      launchStatus,
      releaseId,
      runtimeChannelInput,
      updateActionResult,
    ],
  );

  return (
    <E2eRuntimeContext.Provider value={value}>
      {children}
    </E2eRuntimeContext.Provider>
  );
}
