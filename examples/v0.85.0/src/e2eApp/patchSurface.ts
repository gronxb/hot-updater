import { HotUpdater } from "@hot-updater/react-native";
import { Image } from "react-native";

export const E2E_SCENARIO_MARKER = "targeted-qa-detox";

void HotUpdater;
void Image;

export function maybeCrashForE2E(): void {
  /* E2E_CRASH_GUARD_START */
  /* E2E_CRASH_GUARD_END */
}

export function maybeThrowDuringRenderForE2E(): void {
  /* E2E_RENDER_ERROR_GUARD_START */
  /* E2E_RENDER_ERROR_GUARD_END */
}

export function shouldSkipHotUpdaterInitForE2E(): boolean {
  /* E2E_SKIP_INIT_GUARD_START */
  /* E2E_SKIP_INIT_GUARD_END */
  return false;
}

export function loadE2EDeployBundleAssets(): void {
  /* E2E_DEPLOY_ASSET_GUARD_START */
  /* E2E_DEPLOY_ASSET_GUARD_END */
}
