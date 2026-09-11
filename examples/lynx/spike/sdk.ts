import { createHotUpdater, type PreparedUpdate } from "@hot-updater/lynx";

declare const __SPIKE_VARIANT__: string;
declare const __SPIKE_BEHAVIOR__: string;
declare const __SPIKE_ASSET_PREFIX__: string;
declare const __SDK_BASE_URL__: string;
declare const __SDK_RESOURCES__: boolean;

export const variant = __SPIKE_VARIANT__;
export const resources = __SDK_RESOURCES__;
export const imageUrl = `${__SPIKE_ASSET_PREFIX__}assets/probe.png`;
const updater = createHotUpdater({ baseURL: __SDK_BASE_URL__ });
let imageReady = false;
let completeImage: (() => void) | undefined;
let prepared: PreparedUpdate | null = null;
let busy = false;
let ready = false;

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
    const launch = await updater.getLaunchInfo();
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
    const confirmation = await updater.notifyAppReady();
    console.log("HOT_UPDATER_SDK_READY", JSON.stringify(confirmation));
    if (__SPIKE_BEHAVIOR__ === "double-ready") {
      const repeated = await updater.notifyAppReady();
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
    prepared = await updater.checkForUpdate();
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

export async function installSdkUpdate(
  status: (value: string) => void,
  canInstall: (value: boolean) => void,
) {
  if (busy || !prepared) return;
  busy = true;
  try {
    const result = await prepared.install();
    console.log("HOT_UPDATER_SDK_INSTALL", JSON.stringify(result));
    prepared = null;
    canInstall(false);
    status(
      result.requiresRestart
        ? "Update installed. Close and reopen the app."
        : "Release adopted.",
    );
  } catch (error) {
    status(`Installation failed: ${String(error)}`);
    console.error("HOT_UPDATER_SDK_INSTALL_FAILURE", String(error));
  } finally {
    busy = false;
  }
}
