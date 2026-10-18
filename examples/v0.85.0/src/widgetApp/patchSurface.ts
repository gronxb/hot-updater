import { Image } from "react-native";

import { hotUpdater } from "./runtime";

// The E2E control server rewrites this file for each widget deploy, as it
// rewrites src/e2eApp/patchSurface.ts for the example's.
export const E2E_SCENARIO_MARKER = "targeted-qa-detox";

void hotUpdater;
void Image;

export function maybeCrashForE2E(): void {
  /* E2E_CRASH_GUARD_START */
  /* E2E_CRASH_GUARD_END */
}

export function loadE2EDeployBundleAssets(): void {
  /* E2E_DEPLOY_ASSET_GUARD_START */
  /* E2E_DEPLOY_ASSET_GUARD_END */
}
