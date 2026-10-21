import { Image } from "react-native";

import { hotUpdater } from "@examples/e2e-app";

export const E2E_SCENARIO_MARKER = "crash-detox-recovery";

void hotUpdater;
void Image;

export function maybeCrashForE2E(): void {
  /* E2E_CRASH_GUARD_START */
  const E2E_SAFE_BUNDLE_IDS = new Set([
  "7000-8000-000000000000",
  "01a15c54-f9ab-77b0-ab90-641c17d9576d"
]);
  const E2E_BUILT_IN_MIN_BUNDLE_ID_SUFFIX = "7000-8000-000000000000";
  const E2E_CURRENT_BUNDLE_ID = hotUpdater.getManifest().bundleId;
  const E2E_IS_BUILT_IN_BUNDLE =
    typeof E2E_CURRENT_BUNDLE_ID === "string" &&
    E2E_CURRENT_BUNDLE_ID.endsWith(E2E_BUILT_IN_MIN_BUNDLE_ID_SUFFIX);

  if (!E2E_IS_BUILT_IN_BUNDLE && !E2E_SAFE_BUNDLE_IDS.has(E2E_CURRENT_BUNDLE_ID)) {
    throw new Error("hot-updater e2e crash bundle");
  }
  /* E2E_CRASH_GUARD_END */
}

export function loadE2EDeployBundleAssets(): void {
  /* E2E_DEPLOY_ASSET_GUARD_START */
  /* E2E_DEPLOY_ASSET_GUARD_END */
}
