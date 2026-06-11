import { HotUpdater } from "@hot-updater/react-native";
import { Image } from "react-native";

export const E2E_SCENARIO_MARKER = "targeted-qa-detox";

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
