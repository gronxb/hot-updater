import { HotUpdater, type CheckForUpdateResult } from "@hot-updater/lynx";

const assetPrefix = "hot-updater:///";

export const imageUrl = `${assetPrefix}assets/probe.png`;
let imageReady = false;
let completeImage: (() => void) | undefined;
let prepared: CheckForUpdateResult | null = null;
let busy = false;
let ready = false;
const configurationRequired =
  "Production update endpoint is not configured in the native build.";
let unavailableReason = configurationRequired;

export function productionImageLoaded() {
  imageReady = true;
  completeImage?.();
}

export async function loadProductionFont(): Promise<void> {
  return new Promise((resolve) => {
    lynx.addFont(
      {
        "font-family": "ReleaseProbe",
        src: `url("${assetPrefix}assets/probe.ttf")`,
      },
      resolve,
    );
  });
}

const loadProductionExternal = (): Promise<void> =>
  new Promise((resolve, reject) => {
    lynx.requireModuleAsync(`${assetPrefix}assets/bootstrap.js`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const loadProductionDynamic = async (): Promise<void> => {
  const result = await lynx.loadDynamicComponent(
    `${assetPrefix}dynamic/component.lynx.bundle`,
  );
  if (result.code !== 0) throw new Error("Dynamic component could not load");
};

export async function startProductionSdk(
  setStatus: (value: string) => void,
  fontRegistered: () => void,
): Promise<void> {
  try {
    const launchConfiguration = await HotUpdater.getLaunchConfiguration();
    const baseURL = launchConfiguration.appBaseURL;
    if (baseURL) HotUpdater.init({ baseURL });
    if (!imageReady) {
      await new Promise<void>((resolve) => {
        completeImage = resolve;
      });
    }
    await loadProductionFont();
    fontRegistered();
    await Promise.all([loadProductionExternal(), loadProductionDynamic()]);
    await HotUpdater.notifyAppReady();
    if (!baseURL) {
      unavailableReason = configurationRequired;
      setStatus(configurationRequired);
      return;
    }
    ready = true;
    setStatus("Ready. Check for an update.");
  } catch (error) {
    unavailableReason = `Startup failed: ${String(error)}`;
    setStatus(unavailableReason);
  }
}

export async function checkProductionUpdate(
  setStatus: (value: string) => void,
  setCanInstall: (value: boolean) => void,
): Promise<void> {
  if (busy) return;
  if (!ready) {
    setStatus(unavailableReason);
    return;
  }
  busy = true;
  prepared = null;
  setCanInstall(false);
  setStatus("Checking for an update…");
  try {
    prepared = await HotUpdater.checkForUpdate({
      updateStrategy: "appVersion",
    });
    setCanInstall(prepared !== null);
    setStatus(prepared ? "Update ready to install." : "No update available.");
  } catch (error) {
    setStatus(`Update check failed: ${String(error)}`);
  } finally {
    busy = false;
  }
}

export async function installProductionUpdate(
  setStatus: (value: string) => void,
  setCanInstall: (value: boolean) => void,
  reload: boolean,
): Promise<void> {
  if (busy || !prepared) return;
  busy = true;
  const update = prepared;
  try {
    const installed = await update.updateBundle();
    if (!installed) throw new Error("The update was not installed");
    prepared = null;
    setCanInstall(false);
    if (reload) {
      setStatus("Update installed. Reloading…");
      await HotUpdater.reload();
    } else {
      setStatus("Update installed for the next launch.");
    }
  } catch (error) {
    setStatus(`Installation failed: ${String(error)}`);
  } finally {
    busy = false;
  }
}
