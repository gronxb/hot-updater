import { HotUpdater } from "@hot-updater/lynx";

export const E2E_SCENARIO_MARKER = "targeted-qa-detox";

const Image = {
  resolveAssetSource: (asset: unknown) => asset,
};

void HotUpdater;
void Image;

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
