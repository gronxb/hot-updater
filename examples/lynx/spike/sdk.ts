import {
  HotUpdater,
  LynxUpdaterError,
  type CheckForUpdateResult,
} from "@hot-updater/lynx";

declare const __SPIKE_VARIANT__: string;
declare const __SPIKE_BEHAVIOR__: string;
declare const __SPIKE_ASSET_PREFIX__: string;
declare const __SDK_RESOURCES__: boolean;
declare const TextCodecHelper: {
  encode(value: string): ArrayBuffer;
};

export const variant = __SPIKE_VARIANT__;
export const resources = __SDK_RESOURCES__;
export const imageUrl = `${__SPIKE_ASSET_PREFIX__}assets/probe.png`;
let initialized = false;
let imageReady = false;
let completeImage: (() => void) | undefined;
let prepared: CheckForUpdateResult | null = null;
let busy = false;
let ready = false;
let evidenceOrigin: string | null = null;

const jsonBody = (value: unknown) =>
  TextCodecHelper.encode(JSON.stringify(value));

const evidenceOriginFrom = (appBaseURL: string): string => {
  const match = /^(https?:\/\/[^/?#]+)/i.exec(appBaseURL);
  if (!match) throw new Error("Invalid evidence endpoint");
  return match[1];
};

export function sdkImageLoaded() {
  imageReady = true;
  completeImage?.();
}

export async function startSdk(
  status: (value: string) => void,
  fontRegistered: () => void,
  loadFont: (url: string) => Promise<void>,
  loadExternal: (url: string) => Promise<{ lazyVariant: string }>,
  loadDynamic: (url: string) => Promise<string>,
) {
  try {
    if (!initialized) {
      const launchConfiguration = await HotUpdater.getLaunchConfiguration();
      evidenceOrigin = evidenceOriginFrom(
        launchConfiguration.appBaseURL ?? "http://localhost:3007/hot-updater",
      );
      HotUpdater.init({
        baseURL:
          launchConfiguration.appBaseURL ?? "http://localhost:3007/hot-updater",
      });
      initialized = true;
    }
    const launch = await HotUpdater.getLaunchInfo();
    console.log("HOT_UPDATER_SDK_LAUNCH", JSON.stringify(launch));
    console.log(
      "HOT_UPDATER_SDK_TRANSPORT",
      JSON.stringify({
        fetch: typeof fetch,
        globalFetch: typeof globalThis.fetch,
        abortController: typeof AbortController,
      }),
    );
    if (!imageReady)
      await new Promise<void>((resolve) => {
        completeImage = resolve;
      });
    if (__SDK_RESOURCES__) {
      await loadFont(`${__SPIKE_ASSET_PREFIX__}assets/probe.ttf`);
      fontRegistered();
      const [external, dynamic] = await Promise.all([
        loadExternal(`${__SPIKE_ASSET_PREFIX__}assets/bootstrap.js`),
        loadDynamic(`${__SPIKE_ASSET_PREFIX__}dynamic/component.lynx.bundle`),
      ]);
      if (external.lazyVariant !== variant || dynamic !== variant)
        throw new Error("Missing or mixed release bootstrap resources");
      console.log(
        "HOT_UPDATER_SDK_RESOURCES",
        JSON.stringify({ variant, external: external.lazyVariant, dynamic }),
      );
    }
    if (__SPIKE_BEHAVIOR__ === "unconfirmed") {
      status(`Bundle ${variant}: readiness deliberately withheld.`);
      console.log("HOT_UPDATER_SDK_UNCONFIRMED", variant);
      return;
    }
    // Font registration is not loading. Native must hold this callback until
    // its actual essential font/image loaders and initial content succeed.
    const confirmation = await HotUpdater.notifyAppReady();
    console.log("HOT_UPDATER_SDK_READY", JSON.stringify(confirmation));
    if (__SPIKE_BEHAVIOR__ === "double-ready") {
      const repeated = await HotUpdater.notifyAppReady();
      console.log(
        "HOT_UPDATER_SDK_REPEATED_READY",
        JSON.stringify({ confirmation, repeated }),
      );
    }
    ready = true;
    status(
      __SPIKE_BEHAVIOR__ === "double-ready"
        ? `Bundle ${variant}: two readiness replies received.`
        : `Bundle ${variant} ready. Check for an update.`,
    );
  } catch (error) {
    status(`Startup failed: ${String(error)}`);
    console.error("HOT_UPDATER_SDK_FAILURE", String(error));
  }
}

export async function checkSdkUpdate(
  status: (value: string) => void,
  canInstall: (value: boolean) => void,
) {
  if (busy || !ready) return;
  busy = true;
  prepared = null;
  canInstall(false);
  status("Checking and preparing update…");
  try {
    prepared = await HotUpdater.checkForUpdate({
      updateStrategy: "appVersion",
    });
    console.log(
      "HOT_UPDATER_SDK_CHECK",
      JSON.stringify(
        prepared && {
          bundleId: prepared.bundleId,
          releaseId: prepared.releaseId,
          status: prepared.status,
        },
      ),
    );
    canInstall(prepared !== null);
    status(
      prepared
        ? "Update verified and ready to install."
        : "No update available.",
    );
  } catch (error) {
    status(`Update check failed: ${String(error)}`);
    console.error("HOT_UPDATER_SDK_CHECK_FAILURE", String(error));
  } finally {
    busy = false;
  }
}

export async function captureRuntimeEvents(
  status: (value: string) => void,
): Promise<void> {
  try {
    const snapshot = await HotUpdater.getRuntimeEvents();
    if (
      snapshot.schemaVersion !== 1 ||
      (snapshot.latestSequence !== null &&
        typeof snapshot.latestSequence !== "string") ||
      (snapshot.oldestSequence !== null &&
        typeof snapshot.oldestSequence !== "string") ||
      !Array.isArray(snapshot.events)
    ) {
      throw new Error("Invalid runtime event snapshot");
    }
    const appBaseURL = (await HotUpdater.getLaunchConfiguration()).appBaseURL;
    if (typeof appBaseURL !== "string") {
      throw new Error("Missing runtime snapshot endpoint");
    }
    const response = await fetch(
      `${evidenceOriginFrom(appBaseURL)}/matrix-runtime-snapshot`,
      {
        body: jsonBody({ snapshot }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    if (!response.ok) {
      throw new Error(`Runtime snapshot endpoint returned ${response.status}`);
    }
    console.log(`HOT_UPDATER_RUNTIME_SNAPSHOT ${JSON.stringify(snapshot)}`);
    status(
      `Runtime events captured: ${snapshot.events.length} events, truncated ${snapshot.truncated}`,
    );
  } catch (error) {
    status(`Runtime event capture failed: ${String(error)}`);
    console.error("HOT_UPDATER_RUNTIME_SNAPSHOT_FAILURE", String(error));
  }
}

export async function installSdkUpdate(
  status: (value: string) => void,
  canInstall: (value: boolean) => void,
) {
  if (busy || !prepared) return;
  busy = true;
  try {
    const installed = await prepared.updateBundle();
    console.log(
      "HOT_UPDATER_SDK_INSTALL",
      JSON.stringify({
        installed,
        id: prepared.id,
        transitionKind: prepared.transitionKind,
      }),
    );
    const needsRestart = prepared.transitionKind !== "ADOPT_RELEASE";
    prepared = null;
    canInstall(false);
    status(
      installed && needsRestart
        ? "Update installed. Close and reopen the app."
        : installed
          ? "Release adopted."
          : "Installation skipped.",
    );
  } catch (error) {
    const failure = {
      bundleId: prepared?.bundleId ?? null,
      code: error instanceof LynxUpdaterError ? error.code : "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : String(error),
      releaseId: prepared?.releaseId ?? null,
    };
    if (evidenceOrigin !== null) {
      try {
        const response = await fetch(
          `${evidenceOrigin}/matrix-install-failure`,
          {
            body: jsonBody({ failure }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        if (!response.ok) {
          throw new Error(
            `Install failure evidence endpoint returned ${response.status}`,
          );
        }
      } catch (publishError) {
        console.error(
          "HOT_UPDATER_SDK_INSTALL_FAILURE_EVIDENCE_FAILURE",
          String(publishError),
        );
      }
    }
    status(`Installation failed: [${failure.code}] ${failure.message}`);
    console.error("HOT_UPDATER_SDK_INSTALL_FAILURE", JSON.stringify(failure));
  } finally {
    busy = false;
  }
}

export async function installSdkUpdateAndReload(
  status: (value: string) => void,
  canInstall: (value: boolean) => void,
) {
  if (busy) throw new Error("An SDK update action is already running");
  if (!prepared) throw new Error("No verified SDK update is prepared");
  busy = true;
  const update = prepared;
  try {
    const installed = await update.updateBundle();
    if (!installed)
      throw new Error("The verified SDK update was not installed");
    prepared = null;
    canInstall(false);
    status("Update installed. Replacing the managed Lynx generation…");
    console.log(
      "HOT_UPDATER_SDK_RELOAD",
      JSON.stringify({
        id: update.id,
        bundleId: update.bundleId,
        releaseId: update.releaseId,
        transitionKind: update.transitionKind,
      }),
    );
  } catch (error) {
    busy = false;
    status(`Install and reload failed: ${String(error)}`);
    console.error("HOT_UPDATER_SDK_RELOAD_FAILURE", String(error));
    throw error;
  }
  busy = false;
  return HotUpdater.reload().catch((error) => {
    status(`Install and reload failed: ${String(error)}`);
    console.error("HOT_UPDATER_SDK_RELOAD_FAILURE", String(error));
    throw error;
  });
}
