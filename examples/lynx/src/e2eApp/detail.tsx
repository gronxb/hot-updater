import { HotUpdater } from "@hot-updater/lynx";
import { close } from "@hot-updater/lynx/navigation";
import { root, useEffect, useState } from "@lynx-js/react";

import { readGenerationEvents } from "./generationEvents";
import { resolveE2eLaunchConfiguration } from "./launchConfiguration";
import { E2E_SCENARIO_MARKER } from "./patchSurface";
import { createPendingActionPoller } from "./pendingActionPoller";
import { publishScreenStatePatch } from "./screenStatePublication";

let screenStateURL = "http://localhost:3107/e2e/screen-state";
let pendingActionURL = "http://localhost:3107/e2e/pending-action";
let launchGeneration: string | null = null;

const fetchState = (url: string, init?: RequestInit) => fetch(url, init);

const patchScreenState = (patch: Record<string, unknown>) =>
  publishScreenStatePatch(fetchState, screenStateURL, patch, {
    launchGeneration,
  });

const closeDetailPage = () =>
  new Promise<void>((resolve, reject) => {
    close(undefined, (result) => {
      if (result.code === 1) resolve();
      else reject(new Error(result.msg));
    });
  });

const actionHandlers: Record<string, (text?: string) => Promise<void>> = {
  "action-close-detail-page": closeDetailPage,
  "action-capture-generation-events": async () => {
    const snapshot = await readGenerationEvents(HotUpdater, {
      allowTruncated: true,
    });
    await patchScreenState({
      generationEvents: JSON.stringify(snapshot),
      updateActionResult: `generation-events -> ${snapshot.latestSequence}`,
    });
  },
};

const poller = createPendingActionPoller({
  fetchState,
  getActionHandlers: () => actionHandlers,
  getPendingActionURL: () => pendingActionURL,
  markHandled: () => undefined,
  navigateToTestId: () => undefined,
  onActionTimeout: () =>
    patchScreenState({ updateActionResult: "detail-action -> error timeout" }),
});

const configure = async () => {
  const native = await HotUpdater.getLaunchConfiguration();
  const endpoints = resolveE2eLaunchConfiguration(native);
  launchGeneration = endpoints.launchGeneration ?? null;
  screenStateURL = endpoints.runtimeConfigURL.endsWith("/runtime-config")
    ? endpoints.runtimeConfigURL.replace(/\/runtime-config$/, "/screen-state")
    : `${endpoints.runtimeConfigURL.replace(/\/+$/, "")}/screen-state`;
  pendingActionURL = screenStateURL.replace(
    /\/screen-state$/,
    "/pending-action",
  );
  HotUpdater.init({ baseURL: endpoints.appBaseURL, requestTimeout: 15_000 });
  return typeof native.title === "string" ? native.title : null;
};

function Detail() {
  const [status, setStatus] = useState("Detail starting");
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    void configure()
      .then(async (pageTitle) => {
        const launch = await HotUpdater.getLaunchInfo();
        const confirmation = await HotUpdater.notifyAppReady();
        setTitle(pageTitle);
        await patchScreenState({
          detailPageMarker: E2E_SCENARIO_MARKER,
          detailPageTitle: pageTitle,
        });
        console.log(
          "HOT_UPDATER_E2E_DETAIL_READY",
          JSON.stringify({ launch, confirmation, pageTitle }),
        );
        setStatus(`Detail ready ${launch.running.bundleId}`);
        poller.start();
      })
      .catch((error) => setStatus(`Detail failed: ${String(error)}`));
  }, []);

  return (
    <view style={{ padding: "24px" }}>
      <text>Hot Updater E2E detail</text>
      <text>{E2E_SCENARIO_MARKER}</text>
      <text>{title ?? "Missing detail title"}</text>
      <text>{status}</text>
      <view bindtap={() => void closeDetailPage()}>
        <text>Close detail page</text>
      </view>
    </view>
  );
}

root.render(<Detail />);
