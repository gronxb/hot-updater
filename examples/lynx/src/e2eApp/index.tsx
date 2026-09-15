import { HotUpdater } from "@hot-updater/lynx";
import { navigate } from "@hot-updater/lynx/navigation";
import { root, useEffect, useRef, useState } from "@lynx-js/react";

import {
  loadDynamicProbe,
  loadExternalBootstrap,
  loadProbeFont,
} from "../../spike/native";
import { verifyNavigationBoundary } from "../../spike/navigation-boundary";
import {
  callE2eDiagnostic,
  callE2eDiagnosticWithOptions,
  type NavigationStackBoundaryReceipt,
  type RuntimeEventFieldBoundaryReceipt,
  type RuntimeJournalFixtureMode,
  type RuntimeJournalFixtureReceipt,
} from "./diagnostics";
import {
  NAV_ITEMS,
  SCREEN_PATHS,
  TEST_ID_TO_SCREEN,
  styles,
  type ScreenName,
} from "./e2eStack";
import { readGenerationEvents } from "./generationEvents";
import { readE2eLaunchConfiguration } from "./launchConfiguration";
import {
  E2E_SCENARIO_MARKER,
  E2E_STARTUP_IMAGE_URL,
  loadE2EDeployBundleAssets,
  loadE2EStartupResources,
  markE2EStartupImageLoaded,
  maybeCrashForE2E,
} from "./patchSurface";
import { createPendingActionPoller } from "./pendingActionPoller";
import {
  applyForcedUpdate,
  bootstrapRuntimeReady,
  confirmRuntimeReady,
  installCheckedUpdate,
  readRuntimeSnapshot,
  type RuntimeSnapshot,
} from "./runtimeObservation";
import { publishScreenStatePatch } from "./screenStatePublication";

declare const __E2E_OVERLAY_MARKER__: string;
declare const NativeModules: unknown;

const scenarioMarker =
  typeof __E2E_OVERLAY_MARKER__ === "string" &&
  __E2E_OVERLAY_MARKER__.length > 0
    ? __E2E_OVERLAY_MARKER__
    : E2E_SCENARIO_MARKER;

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
  detailPageMarker: string | null;
  detailPageTitle: string | null;
  diagnosticReceipt: string | null;
  generationEvents: string | null;
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

let runtimeConfigURL = "http://localhost:3107/e2e/runtime-config";
let appBaseURL = "http://localhost:3007/hot-updater";
let launchGeneration: string | null = null;
let screenStateURL = runtimeConfigURL.endsWith("/runtime-config")
  ? runtimeConfigURL.replace(/\/runtime-config$/, "/screen-state")
  : `${runtimeConfigURL.replace(/\/+$/, "")}/screen-state`;
let pendingActionURL = screenStateURL.replace(
  /\/screen-state$/,
  "/pending-action",
);

const fetchState = (url: string, init?: RequestInit) => fetch(url, init);

async function resolveAppBaseURL(): Promise<string> {
  try {
    const response = await Promise.race([
      fetchState(runtimeConfigURL).catch(() => null),
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
  await publishScreenStatePatch(fetchState, screenStateURL, patch, {
    launchGeneration,
  });
};

function App() {
  const [startupFontReady, setStartupFontReady] = useState(false);
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
      await setChannelActionResult("reset -> requesting transition");
      await HotUpdater.resetChannel();
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
    "action-open-detail-page": () =>
      new Promise<void>((resolve, reject) => {
        navigate(
          {
            path: "detail.lynx.bundle",
            options: { params: { title: "Second Page" } },
          },
          (result) => {
            if (result.code === 1) resolve();
            else reject(new Error(result.msg));
          },
        );
      }),
    "action-verify-managed-navigation-boundary": async () => {
      await verifyNavigationBoundary((status) => {
        void setUpdateActionResult(status);
      });
    },
    "action-exercise-navigation-stack-boundary": async () => {
      const receipt = await callE2eDiagnostic<NavigationStackBoundaryReceipt>(
        "exerciseNavigationStackBoundary",
      );
      await patchScreenState({ diagnosticReceipt: JSON.stringify(receipt) });
      await setUpdateActionResult(
        `navigation-stack-boundary -> ${receipt.rejectionCode}`,
      );
    },
    "action-exercise-runtime-journal": async () => {
      const modes: readonly RuntimeJournalFixtureMode[] = [
        "retention-limit",
        "count-plus-one",
        "byte-plus-one",
        "corrupt-json",
        "noncanonical",
        "already-oversized",
      ];
      const receipts: Partial<
        Record<RuntimeJournalFixtureMode, RuntimeJournalFixtureReceipt>
      > = {};
      try {
        for (const mode of modes) {
          await callE2eDiagnosticWithOptions<{
            mode: RuntimeJournalFixtureMode;
          }>("installRuntimeJournalFixture", { mode });
          await callE2eDiagnostic<{ reopened: true }>(
            "reopenRuntimeJournalFixture",
          );
          receipts[mode] =
            await callE2eDiagnostic<RuntimeJournalFixtureReceipt>(
              "getRuntimeJournalFixtureReceipt",
            );
        }
        await callE2eDiagnosticWithOptions<{ mode: RuntimeJournalFixtureMode }>(
          "installRuntimeJournalFixture",
          { mode: "retention-limit" },
        );
        await callE2eDiagnostic<{ appended: true }>(
          "appendRuntimeJournalFixtureEvent",
        );
        await callE2eDiagnostic<{ reopened: true }>(
          "reopenRuntimeJournalFixture",
        );
        const appended = await callE2eDiagnostic<RuntimeJournalFixtureReceipt>(
          "getRuntimeJournalFixtureReceipt",
        );
        const eventFields =
          await callE2eDiagnostic<RuntimeEventFieldBoundaryReceipt>(
            "exerciseRuntimeEventFieldBoundaries",
          );
        await patchScreenState({
          diagnosticReceipt: JSON.stringify({
            appended,
            eventFields,
            fixtures: receipts,
          }),
        });
        await setUpdateActionResult("runtime-journal -> verified");
      } finally {
        await callE2eDiagnostic<{ restored: true }>(
          "restoreRuntimeJournalFixture",
        );
      }
    },
    "action-arm-next-detail-pending": async () => {
      await callE2eDiagnostic<{ armed: true }>("armNextPageAdmissionPending");
      await setUpdateActionResult("detail-diagnostic -> pending armed");
    },
    "action-arm-next-detail-fatal": async () => {
      await callE2eDiagnostic<{ armed: true }>("armNextPageFatalFailure");
      await setUpdateActionResult("detail-diagnostic -> fatal armed");
    },
    "action-fail-pending-detail": async () => {
      const result = await callE2eDiagnostic<{ triggered: boolean }>(
        "triggerTopPendingAdmissionFailure",
      );
      if (!result.triggered) throw new Error("No pending detail was failed");
      await setUpdateActionResult("detail-diagnostic -> pending failed");
    },
    "action-reload-with-pending-detail": async () => {
      const result = await callE2eDiagnostic<{
        status: "TRANSITION_ACCEPTED";
        transitionId: string;
      }>("triggerReload");
      await setUpdateActionResult(
        `detail-diagnostic -> ${result.status} ${result.transitionId}`,
      );
    },
    "action-capture-stale-authorities": async () => {
      await callE2eDiagnostic<{ captured: true }>("captureStaleAuthorities");
      await setUpdateActionResult("stale-authorities -> captured");
    },
    "action-verify-stale-authorities": async () => {
      const result = await callE2eDiagnostic<{
        rejectedCount: number;
        verified: true;
      }>("verifyStaleAuthorities");
      if (result.rejectedCount < 2) {
        throw new Error("Old main and detail authorities were not rejected");
      }
      await setUpdateActionResult("stale-authorities -> verified rejected");
    },
    "action-capture-generation-events": async () => {
      const snapshot = await readGenerationEvents(HotUpdater, {
        allowTruncated: true,
      });
      await patchScreenState({ generationEvents: JSON.stringify(snapshot) });
      await setUpdateActionResult(
        `generation-events -> ${snapshot.latestSequence}`,
      );
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
      try {
        const installed = await updateInfo.updateBundle();
        await publishRuntimeSnapshot();
        await setUpdateActionResult(
          installed
            ? `captured-update -> installed Release ${updateInfo.releaseId ?? "legacy"}`
            : "captured-update -> skipped",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await setUpdateActionResult(`captured-update -> error ${message}`);
      }
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
    void (async () => {
      try {
        await bootstrapRuntimeReady(
          runtimeConfigurationReady,
          async () => {
            await loadE2EStartupResources({
              loadFont: async (url) => {
                await loadProbeFont(url);
                setStartupFontReady(true);
              },
              loadExternal: loadExternalBootstrap,
              loadDynamic: loadDynamicProbe,
            });
          },
          () =>
            confirmRuntimeReady(HotUpdater, async (status) => {
              setLaunchStatus(status);
              await publishRuntimeSnapshot(status);
            }),
          ensurePendingActionPoller,
        );
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
    let timer: ReturnType<typeof setTimeout> | null = null;
    void runtimeConfigurationReady
      .then((ready) => {
        if (!active || !ready) return;
        timer = setTimeout(() => {
          void applyForcedUpdate(
            HotUpdater,
            () => !active || handledScenarioAction,
          ).catch((error) => reportActionError("force-update", error));
        }, 2500);
      })
      .catch((error) => {
        if (active) void reportActionError("force-update", error);
      });
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
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
        {currentScreen === "Ready" ? (
          <view
            style={styles.button}
            bindtap={() => void actions["action-open-detail-page"]?.()}
          >
            <text style={styles.buttonText}>Open detail page</text>
          </view>
        ) : null}
        <image
          style={{ height: "8px", width: "8px" }}
          src={E2E_STARTUP_IMAGE_URL}
          bindload={markE2EStartupImageLoaded}
        />
        <view
          style={{
            backgroundImage: `url("${E2E_STARTUP_IMAGE_URL}")`,
            height: "32px",
            width: "32px",
          }}
        />
        {startupFontReady ? (
          <text style={{ fontFamily: "ReleaseProbe" }}>E2E</text>
        ) : null}
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

let handledScenarioAction = false;
const pendingActionPoller = createPendingActionPoller({
  fetchState,
  getActionHandlers: () => actionHandlers.current,
  getPendingActionURL: () => pendingActionURL,
  markHandled: (testID) => {
    if (testID !== "action-capture-generation-events") {
      handledScenarioAction = true;
    }
  },
  navigateToTestId: (testID) => navigateToTestId.current(testID),
  onActionTimeout: () =>
    patchScreenState({
      updateActionResult: "current-channel -> error timeout",
    }),
});

const ensurePendingActionPoller = () => pendingActionPoller.start();

loadE2EDeployBundleAssets();

const configureE2eRuntime = async (): Promise<boolean> => {
  const resolved = await readE2eLaunchConfiguration(
    typeof NativeModules !== "undefined",
    () => HotUpdater.getLaunchConfiguration(),
  );
  if (!resolved) return false;
  runtimeConfigURL = resolved.runtimeConfigURL;
  appBaseURL = resolved.appBaseURL;
  launchGeneration = resolved.launchGeneration ?? null;
  screenStateURL = runtimeConfigURL.endsWith("/runtime-config")
    ? runtimeConfigURL.replace(/\/runtime-config$/, "/screen-state")
    : `${runtimeConfigURL.replace(/\/+$/, "")}/screen-state`;
  pendingActionURL = screenStateURL.replace(
    /\/screen-state$/,
    "/pending-action",
  );
  HotUpdater.init({
    baseURL: appBaseURL,
    requestTimeout: 15000,
  });
  const resolvedBaseURL = await resolveAppBaseURL();
  if (resolvedBaseURL !== appBaseURL) {
    HotUpdater.init({
      baseURL: resolvedBaseURL,
      requestTimeout: 15000,
    });
  }
  return true;
};

const runtimeConfigurationReady = configureE2eRuntime().then(async (ready) => {
  if (ready) await maybeCrashForE2E();
  return ready;
});

root.render(<App />);
