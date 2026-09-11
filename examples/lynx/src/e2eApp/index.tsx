import { HotUpdater } from "@hot-updater/lynx";
import { root, useEffect, useRef, useState } from "@lynx-js/react";

import {
  E2E_SCENARIO_MARKER,
  loadE2EDeployBundleAssets,
  maybeCrashForE2E,
} from "./patchSurface";

declare const __E2E_APP_BASE_URL__: string;
declare const __E2E_RUNTIME_CONFIG_URL__: string;

const DEFAULT_ACTION_RESULT = "idle";

type ScreenState = {
  channelActionResult: string;
  cohortActionResult: string;
  cohortInput: string | null;
  launchStatus: string;
  runtimeChannelInput: string;
  stagingBundleId: string | null;
  stagingReleaseId: string | null;
  stableBundleId: string | null;
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
    try {
      await setUpdateActionResult(`${actionLabel} -> checking`);
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
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to install update";
      await setUpdateActionResult(`${actionLabel} -> error ${message}`);
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
    "action-install-runtime-channel-update": () =>
      installUpdate({
        actionLabel: `runtime-channel:${runtimeChannelInput.trim().toLowerCase()}`,
        channel: runtimeChannelInput.trim().toLowerCase(),
      }),
    "action-reset-runtime-channel": async () => {
      const didReset = await HotUpdater.resetChannel();
      await setChannelActionResult(`reset -> ${String(didReset)}`);
    },
    "action-apply-cohort-input": () => applyCohortValue(cohortInput),
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
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    void HotUpdater.notifyAppReady()
      .then((result) => {
        const status = `Current Launch Status: ${result.status}`;
        setLaunchStatus(status);
        void patchScreenState({ launchStatus: status });
      })
      .catch(() => undefined);
    const timer = setInterval(() => {
      void (async () => {
        const response = await fetch(pendingActionURL);
        const payload = (await response.json()) as {
          action?: { testID?: string; text?: string } | null;
        };
        const testID = payload.action?.testID;
        if (!testID) return;
        const handler = actionsRef.current[testID];
        if (!handler) return;
        await handler(payload.action?.text);
      })().catch(() => undefined);
    }, 200);
    return () => clearInterval(timer);
  }, []);

  return (
    <scroll-view style={{ width: "100%", height: "100%" }}>
      <text id="ready">Lynx E2E {E2E_SCENARIO_MARKER}</text>
      <text id="update-action-result">{updateActionResult}</text>
      <text id="channel-action-result">{channelActionResult}</text>
      <text id="cohort-action-result">{cohortActionResult}</text>
      <text id="launch-status-result">{launchStatus}</text>
      <text id="runtime-marker-result">{E2E_SCENARIO_MARKER}</text>
      {Object.keys(actions).map((testID) => (
        <view key={testID} id={testID} bindtap={() => void actions[testID]?.()}>
          <text>{testID}</text>
        </view>
      ))}
    </scroll-view>
  );
}

let started = false;
const startE2eApp = (baseURL: string) => {
  if (started) {
    return;
  }
  started = true;
  void Promise.resolve(
    HotUpdater.init({
      insights: true,
      baseURL,
      requestTimeout: 15000,
    }),
  ).catch(() => undefined);
  maybeCrashForE2E();
  try {
    loadE2EDeployBundleAssets();
  } catch {
    // Overlay must keep polling even if Metro asset requires throw.
  }
  root.render(<App />);
};

void resolveAppBaseURL()
  .then((baseURL) => {
    startE2eApp(baseURL);
  })
  .catch(() => {
    startE2eApp(appBaseURL);
  });
