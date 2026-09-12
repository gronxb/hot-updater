import { HotUpdater } from "@hot-updater/lynx";
import { root, useEffect, useRef, useState } from "@lynx-js/react";

import {
  NAV_ITEMS,
  SCREEN_PATHS,
  TEST_ID_TO_SCREEN,
  styles,
  type ScreenName,
} from "./e2eStack";
import {
  E2E_SCENARIO_MARKER,
  loadE2EDeployBundleAssets,
  maybeCrashForE2E,
} from "./patchSurface";

declare const __E2E_APP_BASE_URL__: string;
declare const __E2E_RUNTIME_CONFIG_URL__: string;
declare const __E2E_OVERLAY_MARKER__: string;
declare const __E2E_BUILD_ID__: string;

const scenarioMarker =
  typeof __E2E_OVERLAY_MARKER__ === "string" &&
  __E2E_OVERLAY_MARKER__.length > 0
    ? __E2E_OVERLAY_MARKER__
    : E2E_SCENARIO_MARKER;
void (typeof __E2E_BUILD_ID__ === "string" ? __E2E_BUILD_ID__ : "");

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
const appBaseURL =
  typeof __E2E_APP_BASE_URL__ === "string" && __E2E_APP_BASE_URL__
    ? __E2E_APP_BASE_URL__
    : "http://localhost:3007/hot-updater";
const screenStateURL = runtimeConfigURL.endsWith("/runtime-config")
  ? runtimeConfigURL.replace(/\/runtime-config$/, "/screen-state")
  : `${runtimeConfigURL.replace(/\/+$/, "")}/screen-state`;
const pendingActionURL = screenStateURL.replace(
  /\/screen-state$/,
  "/pending-action",
);

async function resolveAppBaseURL(): Promise<string> {
  try {
    const response = await fetch(runtimeConfigURL);
    const config = (await response.json()) as { baseURL?: string };
    if (typeof config.baseURL === "string" && config.baseURL.length > 0) {
      return config.baseURL;
    }
  } catch {
    // Fall back to the compile-time control-server URL.
  }
  return appBaseURL;
}

const patchScreenState = async (patch: Partial<ScreenState>) => {
  await fetch(screenStateURL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
};

function App() {
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
  const [currentScreen, setCurrentScreen] = useState<ScreenName>("Ready");
  navigateToTestId.current = (testID) => {
    const screen = TEST_ID_TO_SCREEN[testID];
    if (screen) setCurrentScreen(screen);
  };
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
        const stale =
          message.includes("Native revision changed") ||
          message.includes("STALE_STATE") ||
          message.includes("STALE_SELECTION");
        if (stale && attempt < 2) {
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
  ensurePendingActionPoller();
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

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void (async () => {
        if (!active || handledScenarioAction) return;
        try {
          const updateInfo = await HotUpdater.checkForUpdate({
            updateStrategy: "appVersion",
          });
          if (
            !active ||
            handledScenarioAction ||
            !updateInfo?.shouldForceUpdate
          ) {
            return;
          }
          const runningId = HotUpdater.getBundleId();
          if (
            updateInfo.id === runningId ||
            updateInfo.bundleId === runningId
          ) {
            return;
          }
          if (await updateInfo.updateBundle()) await HotUpdater.reload();
        } catch {
          // Overlay launch continues; metadata wait observes the native result.
        }
      })();
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
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

  const valueScreen = (testID: string, value: string) => (
    <text id={testID} style={styles.resultText}>
      {value}
    </text>
  );
  const actionScreen = (testID: string, title: string) => (
    <view
      id={testID}
      style={styles.button}
      bindtap={() => void actions[testID]?.()}
    >
      <text style={styles.buttonText}>{title}</text>
    </view>
  );

  const body =
    currentScreen === "Ready" ? (
      <view>
        <text id="e2e-ready-status" style={styles.resultText}>
          Ready
        </text>
        <text id="ready" style={styles.resultText}>
          Ready
        </text>
        {NAV_ITEMS.map((item) => (
          <view
            key={item.name}
            style={styles.button}
            bindtap={() => setCurrentScreen(item.name)}
          >
            <text style={styles.buttonText}>{item.title}</text>
          </view>
        ))}
      </view>
    ) : currentScreen === "RuntimeMarker" ? (
      valueScreen("runtime-scenario-marker", scenarioMarker)
    ) : currentScreen === "LaunchStatus" ? (
      valueScreen("launch-status-result", launchStatus)
    ) : currentScreen === "UpdateActionResult" ? (
      valueScreen("update-action-result", updateActionResult)
    ) : currentScreen === "ChannelActionResult" ? (
      valueScreen("channel-action-result", channelActionResult)
    ) : currentScreen === "CohortActionResult" ? (
      valueScreen("cohort-action-result", cohortActionResult)
    ) : currentScreen === "RuntimeBundle" ? (
      valueScreen("runtime-bundle-id", bundleId)
    ) : currentScreen === "RuntimeReleaseState" ? (
      valueScreen("runtime-release-state", releaseId)
    ) : currentScreen === "RuntimeCurrentChannel" ? (
      valueScreen("runtime-current-channel", currentChannel)
    ) : currentScreen === "RuntimeDefaultChannel" ? (
      valueScreen("runtime-default-channel", defaultChannel)
    ) : currentScreen === "RuntimeChannelSwitched" ? (
      valueScreen("runtime-channel-switched", channelSwitched)
    ) : currentScreen === "RuntimeCurrentCohort" ? (
      valueScreen("runtime-current-cohort", currentCohort)
    ) : currentScreen === "RuntimeInitialCohort" ? (
      valueScreen("runtime-initial-cohort", "1")
    ) : currentScreen === "CrashHistoryCount" ? (
      valueScreen("crash-history-count", crashHistoryCount)
    ) : currentScreen === "CohortInput" ? (
      valueScreen("cohort-input", cohortInput)
    ) : currentScreen === "RuntimeChannelInput" ? (
      valueScreen("runtime-channel-input", runtimeChannelInput)
    ) : currentScreen === "InstallCurrentChannelUpdateAction" ? (
      actionScreen("action-install-current-channel-update", "Install Current")
    ) : currentScreen === "InstallFingerprintUpdateAction" ? (
      actionScreen("action-install-fingerprint-update", "Install Fingerprint")
    ) : currentScreen === "InstallRuntimeChannelUpdateAction" ? (
      actionScreen(
        "action-install-runtime-channel-update",
        "Install Runtime Channel",
      )
    ) : currentScreen === "ResetRuntimeChannelAction" ? (
      actionScreen("action-reset-runtime-channel", "Reset Channel")
    ) : currentScreen === "SetCohortQaAction" ? (
      actionScreen("action-set-cohort-qa", "Set Cohort QA")
    ) : currentScreen === "RestoreInitialCohortAction" ? (
      actionScreen("action-restore-initial-cohort", "Restore Cohort")
    ) : currentScreen === "ApplyCohortInputAction" ? (
      actionScreen("action-apply-cohort-input", "Apply Cohort")
    ) : currentScreen === "ClearCrashHistoryAction" ? (
      actionScreen("action-clear-crash-history", "Clear Crash History")
    ) : currentScreen === "ReloadAppAction" ? (
      actionScreen("action-reload-app", "Reload")
    ) : currentScreen === "RefreshRuntimeSnapshotAction" ? (
      actionScreen("action-refresh-runtime-snapshot", "Refresh Snapshot")
    ) : currentScreen === "CaptureCurrentChannelUpdateAction" ? (
      actionScreen("action-capture-current-channel-update", "Capture Update")
    ) : currentScreen === "ApplyCapturedUpdateAction" ? (
      actionScreen("action-apply-captured-update", "Apply Captured")
    ) : (
      valueScreen("e2e-ready-status", "Ready")
    );

  return (
    <scroll-view style={styles.root}>
      <view style={styles.content}>
        {currentScreen !== "Ready" ? (
          <view bindtap={() => setCurrentScreen("Ready")}>
            <text style={styles.back}>Back</text>
          </view>
        ) : null}
        <text style={styles.resultText}>{SCREEN_PATHS[currentScreen]}</text>
        {body}
      </view>
    </scroll-view>
  );
}

const actionHandlers: {
  current: Record<string, (text?: string) => Promise<void>>;
} = { current: {} };
const navigateToTestId: { current: (testID: string) => void } = {
  current: () => undefined,
};

let pollerStarted = false;
let handledScenarioAction = false;
const pollPendingActionOnce = async () => {
  if (Object.keys(actionHandlers.current).length === 0) {
    return;
  }
  const response = await fetch(pendingActionURL);
  const payload = (await response.json()) as {
    action?: { testID?: string; text?: string } | null;
  };
  const testID = payload.action?.testID;
  if (!testID) return;
  const handler = actionHandlers.current[testID];
  if (!handler) return;
  handledScenarioAction = true;
  navigateToTestId.current(testID);
  await handler(payload.action?.text);
};

const ensurePendingActionPoller = () => {
  if (pollerStarted) {
    return;
  }
  pollerStarted = true;
  const tick = () => {
    void pollPendingActionOnce()
      .catch(() => undefined)
      .then(() => {
        setTimeout(tick, 200);
      });
  };
  tick();
};

try {
  loadE2EDeployBundleAssets();
} catch {
  // Overlay must keep polling even if Metro asset requires throw.
}
maybeCrashForE2E();

let started = false;
const startE2eApp = (baseURL: string) => {
  HotUpdater.init({
    insights: true,
    baseURL,
    requestTimeout: 15000,
  });
  if (!started) {
    started = true;
  }
  try {
    root.render(<App />);
  } catch {
    // Poller must keep running even if the Lynx tree fails to mount.
  }
};

void resolveAppBaseURL()
  .then((baseURL) => {
    startE2eApp(baseURL);
  })
  .catch(() => {
    startE2eApp(appBaseURL);
  });
