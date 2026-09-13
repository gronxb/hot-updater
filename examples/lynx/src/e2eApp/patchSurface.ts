import { HotUpdater } from "@hot-updater/lynx";

export const E2E_SCENARIO_MARKER = "targeted-qa-detox";
export const E2E_STARTUP_IMAGE_URL = "hot-updater:///assets/probe.png";

let startupImageReady = false;
let resolveStartupImage: (() => void) | undefined;

const Image = {
  resolveAssetSource: (asset: unknown) => asset,
};

void HotUpdater;
void Image;

export function markE2EStartupImageLoaded(): void {
  startupImageReady = true;
  resolveStartupImage?.();
}

export async function loadE2EStartupResources(loaders: {
  loadFont: (url: string) => Promise<void>;
  loadExternal: (url: string) => Promise<{ lazyVariant: string }>;
  loadDynamic: (url: string) => Promise<string>;
}): Promise<void> {
  if (!startupImageReady) {
    await new Promise<void>((resolve) => {
      resolveStartupImage = resolve;
    });
  }
  await loaders.loadFont("hot-updater:///assets/probe.ttf");
  const [external, dynamic] = await Promise.all([
    loaders.loadExternal("hot-updater:///assets/bootstrap.js"),
    loaders.loadDynamic("hot-updater:///dynamic/component.lynx.bundle"),
  ]);
  if (external.lazyVariant !== "A" || dynamic !== "A") {
    throw new Error("Missing or mixed Lynx E2E startup resources");
  }
}

export function maybeCrashForE2E(): void {
  try {
    /* E2E_CRASH_GUARD_START */
    /* E2E_CRASH_GUARD_END */
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("hot-updater e2e crash")) {
      throw error;
    }
    if (
      message.includes("notifyAppReady") ||
      message.includes("NATIVE_STATE")
    ) {
      throw new Error("hot-updater e2e crash bundle");
    }
    throw error;
  }
}

export function loadE2EDeployBundleAssets(): void {
  try {
    /* E2E_DEPLOY_ASSET_GUARD_START */
    /* E2E_DEPLOY_ASSET_GUARD_END */
  } catch {
    // Lynx cannot load Metro Image assets; fixtures are copied into the archive.
  }
}
