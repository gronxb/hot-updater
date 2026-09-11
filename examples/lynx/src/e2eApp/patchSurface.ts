import { HotUpdater } from "@hot-updater/lynx";

export const E2E_SCENARIO_MARKER = "targeted-qa-detox";

const Image = {
  resolveAssetSource: (asset: unknown) => asset,
};

void HotUpdater;
void Image;

export function maybeCrashForE2E(): void {
  /* E2E_CRASH_GUARD_START */
  /* E2E_CRASH_GUARD_END */
}

export function loadE2EDeployBundleAssets(): void {
  /* E2E_DEPLOY_ASSET_GUARD_START */
  /* E2E_DEPLOY_ASSET_GUARD_END */
}
