import "./polyfill";
import { HotUpdater } from "@hot-updater/lynx";
import { root } from "@lynx-js/react";

import { App } from "./app";
import { TEST_ID_TO_SCREEN } from "./e2eStack";
import { loadE2EDeployBundleAssets, maybeCrashForE2E } from "./patchSurface";
import { navigateToTestId } from "./router";
import {
  bindStandaloneE2eActionHandlers,
  bootNotifyAppReady,
  publishOverlayReady,
  scheduleForceUpdateReload,
} from "./runtime-actions";
import {
  actionHandlers,
  markScenarioActionHandled,
  pendingActionURL,
} from "./runtime-model";

declare const __E2E_APP_BASE_URL__: string;
declare const __E2E_RUNTIME_CONFIG_URL__: string;
declare const __E2E_BUILD_ID__: string;

void (typeof __E2E_BUILD_ID__ === "string" ? __E2E_BUILD_ID__ : "");
void TEST_ID_TO_SCREEN;

const runtimeConfigURL =
  typeof __E2E_RUNTIME_CONFIG_URL__ === "string" && __E2E_RUNTIME_CONFIG_URL__
    ? __E2E_RUNTIME_CONFIG_URL__
    : "http://localhost:3107/e2e/runtime-config";
const appBaseURL =
  typeof __E2E_APP_BASE_URL__ === "string" && __E2E_APP_BASE_URL__
    ? __E2E_APP_BASE_URL__
    : "http://localhost:3007/hot-updater";

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

let pollerStarted = false;
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
  markScenarioActionHandled();
  navigateToTestId(testID);
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
  try {
    HotUpdater.init({
      insights: true,
      baseURL,
      requestTimeout: 15000,
    });
  } catch {
    // Overlay ready and the pending-action poller must still start.
  }
  if (!started) {
    started = true;
  }
  bindStandaloneE2eActionHandlers();
  void publishOverlayReady();
  ensurePendingActionPoller();
  void bootNotifyAppReady();
  scheduleForceUpdateReload();
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
