import { readFileSync } from "node:fs";
import path from "node:path";

import { assetHeavyOtaUsesArchiveScenario } from "./scenarios/asset-heavy-ota-uses-archive.ts";
import { brownfieldInstanceCrashRollsBackOnlyItselfScenario } from "./scenarios/brownfield-instance-crash-rolls-back-only-itself.ts";
import { brownfieldInstanceRollbackIsolatedScenario } from "./scenarios/brownfield-instance-rollback-isolated.ts";
import { brownfieldInstancesUpdateIndependentlyScenario } from "./scenarios/brownfield-instances-update-independently.ts";
import { brownfieldNativeMinorUpdateScenario } from "./scenarios/brownfield-native-minor-update.ts";
import { brownfieldNativeRequiredUpdateScenario } from "./scenarios/brownfield-native-required-update.ts";
import { bspatchBuiltinToDiffOtaScenario } from "./scenarios/bspatch-builtin-to-diff-ota.ts";
import { bspatchConsecutiveDiffOtaScenario } from "./scenarios/bspatch-consecutive-diff-ota.ts";
import { bspatchDisabledChainRollbackScenario } from "./scenarios/bspatch-disabled-chain-rollback.ts";
import { bspatchManifestDiffFallbackScenario } from "./scenarios/bspatch-manifest-diff-fallback.ts";
import { catalogOnlyNoUpdateScenario } from "./scenarios/catalog-only-no-update.ts";
import { crashThenNextSafeUpdateScenario } from "./scenarios/crash-then-next-safe-update.ts";
import { disabledBundleRollbackToBuiltinScenario } from "./scenarios/disabled-bundle-rollback-to-builtin.ts";
import { disabledBundleRollbackToPreviousOtaScenario } from "./scenarios/disabled-bundle-rollback-to-previous-ota.ts";
import { failedDownloadSameGenerationRetryScenario } from "./scenarios/failed-download-same-generation-retry.ts";
import { fingerprintInitialInstallScenario } from "./scenarios/fingerprint-initial-install.ts";
import { forceUpdateAutoReloadScenario } from "./scenarios/force-update-auto-reload.ts";
import { foreignSigningKeyRefusedScenario } from "./scenarios/foreign-signing-key-refused.ts";
import { headlessLaunchKeepsStagedBundleScenario } from "./scenarios/headless-launch-keeps-staged-bundle.ts";
import { interruptedLaunchRetriesBundleScenario } from "./scenarios/interrupted-launch-retries-bundle.ts";
import { launchStatusAfterSessionInstallScenario } from "./scenarios/launch-status-after-session-install.ts";
import { multiAssetReplacementScenario } from "./scenarios/multi-asset-replacement.ts";
import { numericCohortRolloutScenario } from "./scenarios/numeric-cohort-rollout.ts";
import { postContentCrashNativeRecoveryScenario } from "./scenarios/post-content-crash-native-recovery.ts";
import { postContentCrashNativeRollbackScenario } from "./scenarios/post-content-crash-native-rollback.ts";
import { releaseOtaRecoveryScenario } from "./scenarios/release-ota-recovery.ts";
import { remoteConfigFetchActivateScenario } from "./scenarios/remote-config-fetch-activate.ts";
import { republishedCrashedBundleSkippedScenario } from "./scenarios/republished-crashed-bundle-skipped.ts";
import { resumedBackgroundArchiveDownloadScenario } from "./scenarios/resumed-background-archive-download.ts";
import { runtimeChannelCrashRestoreScenario } from "./scenarios/runtime-channel-crash-restore.ts";
import { runtimeChannelSwitchResetScenario } from "./scenarios/runtime-channel-switch-reset.ts";
import { sameBundleReleaseAdoptionScenario } from "./scenarios/same-bundle-release-adoption.ts";
import { sizeAwareArtifactSelectionScenario } from "./scenarios/size-aware-artifact-selection.ts";
import { skippedForceUpdatePropagatesScenario } from "./scenarios/skipped-force-update-propagates.ts";
import { slowOldArtifactAfterNewerInstallScenario } from "./scenarios/slow-old-artifact-after-newer-install.ts";
import { staleCatalogAfterNewerGenerationScenario } from "./scenarios/stale-catalog-after-newer-generation.ts";
import { startupHangRecoveryScenario } from "./scenarios/startup-hang-recovery.ts";
import { storeInstallBuiltInMismatchDownloadsScenario } from "./scenarios/store-install-built-in-mismatch-downloads.ts";
import { storeInstallPatchesFromBuiltInScenario } from "./scenarios/store-install-patches-from-built-in.ts";
import { targetCohortsOnlyScenario } from "./scenarios/target-cohorts-only.ts";
import { targetCohortsRolloutInteractionScenario } from "./scenarios/target-cohorts-rollout-interaction.ts";
import { targetedCohortSwitchbackScenario } from "./scenarios/targeted-cohort-switchback.ts";
import { tenCrashHistorySafeBundleScenario } from "./scenarios/ten-crash-history-safe-bundle.ts";
import type { ScenarioDefinition } from "./scenarios/types.ts";

export type {
  ScenarioDefinition,
  ScenarioAppDriver,
} from "./scenarios/types.ts";

const registeredScenarios: readonly ScenarioDefinition[] = [
  startupHangRecoveryScenario,
  headlessLaunchKeepsStagedBundleScenario,
  interruptedLaunchRetriesBundleScenario,
  launchStatusAfterSessionInstallScenario,
  releaseOtaRecoveryScenario,
  multiAssetReplacementScenario,
  bspatchBuiltinToDiffOtaScenario,
  bspatchConsecutiveDiffOtaScenario,
  bspatchDisabledChainRollbackScenario,
  bspatchManifestDiffFallbackScenario,
  storeInstallPatchesFromBuiltInScenario,
  storeInstallBuiltInMismatchDownloadsScenario,
  runtimeChannelSwitchResetScenario,
  numericCohortRolloutScenario,
  targetCohortsOnlyScenario,
  targetCohortsRolloutInteractionScenario,
  targetedCohortSwitchbackScenario,
  forceUpdateAutoReloadScenario,
  skippedForceUpdatePropagatesScenario,
  disabledBundleRollbackToBuiltinScenario,
  disabledBundleRollbackToPreviousOtaScenario,
  fingerprintInitialInstallScenario,
  catalogOnlyNoUpdateScenario,
  sameBundleReleaseAdoptionScenario,
  sizeAwareArtifactSelectionScenario,
  assetHeavyOtaUsesArchiveScenario,
  staleCatalogAfterNewerGenerationScenario,
  slowOldArtifactAfterNewerInstallScenario,
  failedDownloadSameGenerationRetryScenario,
  resumedBackgroundArchiveDownloadScenario,
  republishedCrashedBundleSkippedScenario,
  crashThenNextSafeUpdateScenario,
  postContentCrashNativeRecoveryScenario,
  postContentCrashNativeRollbackScenario,
  runtimeChannelCrashRestoreScenario,
  tenCrashHistorySafeBundleScenario,
  remoteConfigFetchActivateScenario,
  foreignSigningKeyRefusedScenario,
  brownfieldNativeRequiredUpdateScenario,
  brownfieldNativeMinorUpdateScenario,
  brownfieldInstancesUpdateIndependentlyScenario,
  brownfieldInstanceRollbackIsolatedScenario,
  brownfieldInstanceCrashRollsBackOnlyItselfScenario,
];

const scenarioByName = new Map(
  registeredScenarios.map((scenario) => [scenario.name, scenario]),
);
if (scenarioByName.size !== registeredScenarios.length) {
  throw new Error("E2E scenario registrations contain duplicate names");
}

/** Each suite's manifest; the bot reads the same files. */
const suiteManifests = {
  default: "e2e/scenario-names.json",
  brownfield: "e2e/brownfield-scenario-names.json",
} as const;

function readSuite(manifest: string): readonly string[] {
  const names: unknown = JSON.parse(
    readFileSync(path.join(process.cwd(), manifest), "utf8"),
  );
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    !names.every((name) => typeof name === "string" && name.length > 0) ||
    new Set(names).size !== names.length
  ) {
    throw new Error(`${manifest} must contain unique scenario names`);
  }
  for (const name of names) {
    if (!scenarioByName.has(name)) {
      throw new Error(`${manifest} lists an unregistered scenario: ${name}`);
    }
  }
  return names as string[];
}

const suites = new Map<string, readonly string[]>(
  Object.entries(suiteManifests).map(([suite, manifest]) => [
    suite,
    readSuite(manifest),
  ]),
);

const suiteScenarioNames = new Set([...suites.values()].flat());
const unlisted = registeredScenarios
  .map((scenario) => scenario.name)
  .filter((name) => !suiteScenarioNames.has(name));
if (unlisted.length) {
  throw new Error(
    `Registered E2E scenarios are missing from every suite: ${unlisted.join(", ")}`,
  );
}

export function listSuiteNames(): readonly string[] {
  return [...suites.keys()];
}

/** The scenarios of a suite, the default suite unless one is named. */
export function listScenarioNames(suiteName = "default"): readonly string[] {
  return resolveSuiteScenarioNames(suiteName);
}

export function resolveSuiteScenarioNames(
  suiteName: string,
): readonly string[] {
  const names = suites.get(suiteName);
  if (!names) {
    throw new Error(`Unknown E2E suite: ${suiteName}`);
  }
  return names;
}

export function getScenarioDefinition(
  scenarioName: string,
): ScenarioDefinition {
  const scenario = scenarioByName.get(scenarioName);
  if (!scenario) {
    throw new Error(`Unknown E2E scenario: ${scenarioName}`);
  }
  return scenario;
}
