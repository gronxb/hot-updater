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
import {
  applyForcedUpdate,
  confirmRuntimeReady,
  installCheckedUpdate,
  readRuntimeSnapshot,
  type RuntimeSnapshot,
} from "./runtimeObservation";

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
  currentBundleId: string | null;
  currentReleaseId: string | null;
  currentCohort: string | null;
  crashHistoryCount: string | null;
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
    const response = await Promise.race([
      fetch(runtimeConfigURL).catch(() => null),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 2000);
      }),
    ]);
    if (!response) {
      return appBaseURL;
    }
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
  const response = await fetch(screenStateURL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`Screen state HTTP ${response.status}`);
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
  const [runtimeSnapshot, setRuntimeSnapshot] =
    useState<RuntimeSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const initialCohort = useRef<string | null>(null);
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
    try {
      const result = await installCheckedUpdate(
        HotUpdater,
        {
          updateStrategy: strategy,
          requestTimeout: 5000,
          ...(channel ? { channel } : {}),
        },
        actionLabel,
      );
      await publishRuntimeSnapshot();
      await setUpdateActionResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setUpdateActionResult(`${actionLabel} -> error ${message}`);
    }
  };

  const applyCohortValue = async (nextCohort: string) => {
    await HotUpdater.setCohort(nextCohort);
    const applied = HotUpdater.getCohort();
    setCohortInputState(applied);
    await publishRuntimeSnapshot();
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
      await publishRuntimeSnapshot();
      await setChannelActionResult(`reset -> ${String(didReset)}`);
    },
    "action-apply-cohort-input": () => applyCohortValue(cohortInput),
    "action-set-cohort-qa": () => applyCohortValue("qa"),
    "action-restore-initial-cohort": async () => {
      if (initialCohort.current === null)
        throw new Error("Initial cohort is unavailable");
      await applyCohortValue(initialCohort.current);
      await setCohortActionResult(`restore -> ${HotUpdater.getCohort()}`);
    },
    "action-clear-crash-history": async () => {
      await HotUpdater.clearCrashHistory();
      await publishRuntimeSnapshot();
    },
    "action-reload-app": async () => {
      await HotUpdater.reload();
    },
    "action-refresh-runtime-snapshot": async () => {
      await publishRuntimeSnapshot();
    },
    "action-capture-current-channel-update": async () => {
      const updateInfo = await HotUpdater.checkForUpdate({
        updateStrategy: "appVersion",
      });
      capturedUpdate.current = updateInfo;
      await publishRuntimeSnapshot();
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
      await publishRuntimeSnapshot();
      await setUpdateActionResult(
        installed
          ? `captured-update -> installed Release ${updateInfo.releaseId ?? "legacy"}`
          : "captured-update -> skipped",
      );
    },
    "cohort-input": async (text) => {
      if (text === undefined) return;
      setCohortInputState(text);
      await patchScreenState({ cohortInput: text });
    },
    "runtime-channel-input": async (text) => {
      if (text === undefined) return;
      setRuntimeChannelInput(text);
      await patchScreenState({ runtimeChannelInput: text });
    },
  };
  const reportActionError = async (testID: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (testID.includes("cohort")) {
      await setCohortActionResult(`error ${message}`);
    } else if (testID === "action-reset-runtime-channel") {
      await setChannelActionResult(`reset -> error ${message}`);
    } else {
      await setUpdateActionResult(`error ${message}`);
    }
  };
  const runAction = async (testID: string, text?: string) => {
    try {
      await actions[testID]?.(text);
    } catch (error) {
      await reportActionError(testID, error);
    }
  };
  actionHandlers.current = Object.fromEntries(
    Object.keys(actions).map((testID) => [
      testID,
      (text?: string) => runAction(testID, text),
    ]),
  );

  const publishRuntimeSnapshot = async (launchStatusValue?: string) => {
    try {
      const snapshot = await readRuntimeSnapshot(HotUpdater);
      setRuntimeSnapshot(snapshot);
      setSnapshotError(null);
      if (initialCohort.current === null)
        initialCohort.current = snapshot.currentCohort;
      await patchScreenState({
        ...snapshot,
        runtimeScenarioMarker: scenarioMarker,
        ...(launchStatusValue ? { launchStatus: launchStatusValue } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeSnapshot(null);
      setSnapshotError(message);
      const status = `Current Launch Status: ERROR ${message}`;
      setLaunchStatus(status);
      await patchScreenState({
        currentBundleId: null,
        currentReleaseId: null,
        currentCohort: null,
        crashHistoryCount: null,
        currentChannel: null,
        defaultChannel: null,
        channelSwitched: null,
        stagingBundleId: null,
        stagingReleaseId: null,
        stableBundleId: null,
        stableReleaseId: null,
        verificationPending: null,
        launchStatus: status,
      });
      throw error;
    }
  };

  useEffect(() => {
    ensurePendingActionPoller();
    void (async () => {
      try {
        await confirmRuntimeReady(HotUpdater, async (status) => {
          setLaunchStatus(status);
          await publishRuntimeSnapshot(status);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = `Current Launch Status: ERROR ${message}`;
        setLaunchStatus(status);
        await patchScreenState({ launchStatus: status });
      }
    })();
  }, []);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void applyForcedUpdate(HotUpdater, () => !active || handledScenarioAction)
        .then(() => (active ? publishRuntimeSnapshot() : undefined))
        .catch((error) => reportActionError("force-update", error));
    }, 2500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  const unavailable = snapshotError ? `ERROR ${snapshotError}` : "unavailable";
  const bundleId = runtimeSnapshot?.currentBundleId ?? unavailable;
  const releaseId = runtimeSnapshot
    ? (runtimeSnapshot.currentReleaseId ?? "")
    : unavailable;
  const currentChannel = runtimeSnapshot?.currentChannel ?? unavailable;
  const defaultChannel = runtimeSnapshot?.defaultChannel ?? unavailable;
  const channelSwitched = runtimeSnapshot?.channelSwitched ?? unavailable;
  const currentCohort = runtimeSnapshot?.currentCohort ?? unavailable;
  const crashHistoryCount = runtimeSnapshot?.crashHistoryCount ?? unavailable;

  const valueScreen = (testID: string, value: string) => (
    <text id={testID} style={styles.resultText}>
      {value}
    </text>
  );
  const actionScreen = (testID: string, title: string) => (
    <view
      id={testID}
      style={styles.button}
      bindtap={() => void runAction(testID)}
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
      valueScreen(
        "runtime-initial-cohort",
        initialCohort.current ?? unavailable,
      )
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
let takingPendingAction = false;
let handledScenarioAction = false;

const fetchJsonWithTimeout = async (
  url: string,
  init?: RequestInit,
): Promise<unknown> => {
  const response = await Promise.race([
    fetch(url, init).catch(() => null),
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), 5000);
    }),
  ]);
  if (!response) return null;
  return response.json();
};

const pollPendingActionOnce = async () => {
  if (takingPendingAction || Object.keys(actionHandlers.current).length === 0) {
    return;
  }
  const peeked = (await fetchJsonWithTimeout(pendingActionURL)) as {
    action?: { testID?: string; text?: string } | null;
  } | null;
  const queued = peeked?.action;
  if (!queued?.testID) return;
  takingPendingAction = true;
  try {
    const taken = (await fetch(`${pendingActionURL}?take=1`).then(
      (response) => response.json(),
      () => null,
    )) as { action?: { testID?: string; text?: string } | null } | null;
    const testID = taken?.action?.testID;
    if (!testID) return;
    const handler = actionHandlers.current[testID];
    if (!handler) return;
    handledScenarioAction = true;
    navigateToTestId.current(testID);
    const timedOut = await Promise.race([
      handler(taken.action?.text).then(() => false),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(true), 20_000);
      }),
    ]);
    if (timedOut) {
      await patchScreenState({
        updateActionResult: "current-channel -> error timeout",
      });
    }
  } finally {
    takingPendingAction = false;
  }
};

const ensurePendingActionPoller = () => {
  if (pollerStarted) {
    return;
  }
  pollerStarted = true;
  const tick = () => {
    void pollPendingActionOnce().catch(() => undefined);
    setTimeout(tick, 200);
  };
  tick();
};

loadE2EDeployBundleAssets();
maybeCrashForE2E();

const startE2eApp = (baseURL: string) => {
  HotUpdater.init({
    baseURL,
    requestTimeout: 15000,
  });
  root.render(<App />);
};

startE2eApp(appBaseURL);
void resolveAppBaseURL().then((baseURL) => {
  if (baseURL === appBaseURL) return;
  HotUpdater.init({
    baseURL,
    requestTimeout: 15000,
  });
});
