import { HotUpdater } from "@hot-updater/lynx";
import { navigate } from "@hot-updater/lynx/navigation";

import { callE2eDiagnostic } from "./diagnostics";

export const E2E_SCENARIO_MARKER = "targeted-qa-detox";
export const E2E_STARTUP_IMAGE_URL = "hot-updater:///assets/probe.png";

let startupImageReady = false;
let resolveStartupImage: (() => void) | undefined;

const Image = {
  resolveAssetSource: (asset: unknown) => asset,
};

void HotUpdater;
void Image;
void callE2eDiagnostic;
void navigate;

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
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("E2E startup image did not load"));
      }, 10_000);
      resolveStartupImage = () => {
        clearTimeout(timer);
        resolve();
      };
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

export async function maybeCrashForE2E(): Promise<boolean> {
  /* E2E_CRASH_GUARD_START */
  return false;
  /* E2E_CRASH_GUARD_END */
}

export function loadE2EDeployBundleAssets(): void {
  try {
    /* E2E_DEPLOY_ASSET_GUARD_START */
    /* E2E_DEPLOY_ASSET_GUARD_END */
  } catch {
    // Lynx cannot load Metro Image assets; fixtures are copied into the archive.
  }
}
