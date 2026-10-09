import { readFileSync } from "node:fs";
import path from "node:path";

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
import { headlessLaunchKeepsStagedBundleScenario } from "./scenarios/headless-launch-keeps-staged-bundle.ts";
import { interruptedLaunchRetriesBundleScenario } from "./scenarios/interrupted-launch-retries-bundle.ts";
import { launchStatusAfterSessionInstallScenario } from "./scenarios/launch-status-after-session-install.ts";
import { metadataV1MigrationScenario } from "./scenarios/metadata-v1-migration.ts";
import { multiAssetReplacementScenario } from "./scenarios/multi-asset-replacement.ts";
import { numericCohortRolloutScenario } from "./scenarios/numeric-cohort-rollout.ts";
import { releaseOtaRecoveryScenario } from "./scenarios/release-ota-recovery.ts";
import { remoteConfigFetchActivateScenario } from "./scenarios/remote-config-fetch-activate.ts";
import { republishedCrashedBundleSkippedScenario } from "./scenarios/republished-crashed-bundle-skipped.ts";
import { runtimeChannelCrashRestoreScenario } from "./scenarios/runtime-channel-crash-restore.ts";
import { runtimeChannelSwitchResetScenario } from "./scenarios/runtime-channel-switch-reset.ts";
import { sameBundleReleaseAdoptionScenario } from "./scenarios/same-bundle-release-adoption.ts";
import { sizeAwareArtifactSelectionScenario } from "./scenarios/size-aware-artifact-selection.ts";
import { slowOldArtifactAfterNewerInstallScenario } from "./scenarios/slow-old-artifact-after-newer-install.ts";
import { staleCatalogAfterNewerGenerationScenario } from "./scenarios/stale-catalog-after-newer-generation.ts";
import { startupHangRecoveryScenario } from "./scenarios/startup-hang-recovery.ts";
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
  runtimeChannelSwitchResetScenario,
  numericCohortRolloutScenario,
  targetCohortsOnlyScenario,
  targetCohortsRolloutInteractionScenario,
  targetedCohortSwitchbackScenario,
  forceUpdateAutoReloadScenario,
  disabledBundleRollbackToBuiltinScenario,
  disabledBundleRollbackToPreviousOtaScenario,
  fingerprintInitialInstallScenario,
  catalogOnlyNoUpdateScenario,
  sameBundleReleaseAdoptionScenario,
  sizeAwareArtifactSelectionScenario,
  staleCatalogAfterNewerGenerationScenario,
  slowOldArtifactAfterNewerInstallScenario,
  failedDownloadSameGenerationRetryScenario,
  republishedCrashedBundleSkippedScenario,
  crashThenNextSafeUpdateScenario,
  runtimeChannelCrashRestoreScenario,
  metadataV1MigrationScenario,
  tenCrashHistorySafeBundleScenario,
  remoteConfigFetchActivateScenario,
];

const scenarioByName = new Map(
  registeredScenarios.map((scenario) => [scenario.name, scenario]),
);
if (scenarioByName.size !== registeredScenarios.length) {
  throw new Error("E2E scenario registrations contain duplicate names");
}

const defaultScenarioNames: unknown = JSON.parse(
  readFileSync(path.join(process.cwd(), "e2e/scenario-names.json"), "utf8"),
);
if (
  !Array.isArray(defaultScenarioNames) ||
  defaultScenarioNames.length === 0 ||
  !defaultScenarioNames.every(
    (name) => typeof name === "string" && name.length > 0,
  ) ||
  new Set(defaultScenarioNames).size !== defaultScenarioNames.length
) {
  throw new Error("e2e/scenario-names.json must contain unique scenario names");
}

const scenarios: readonly ScenarioDefinition[] = defaultScenarioNames.map(
  (name) => {
    const scenario = scenarioByName.get(name);
    if (!scenario) {
      throw new Error(`Default E2E scenario is not registered: ${name}`);
    }
    return scenario;
  },
);

if (scenarios.length !== registeredScenarios.length) {
  const defaultScenarioSet = new Set(defaultScenarioNames);
  const unlisted = registeredScenarios
    .map((scenario) => scenario.name)
    .filter((name) => !defaultScenarioSet.has(name));
  throw new Error(
    `Registered E2E scenarios are missing from the default suite: ${unlisted.join(", ")}`,
  );
}

export function listSuiteNames(): readonly string[] {
  return ["default"];
}

export function listScenarioNames(): readonly string[] {
  return scenarios.map((scenario) => scenario.name);
}

export function resolveSuiteScenarioNames(
  suiteName: string,
): readonly string[] {
  if (suiteName !== "default") {
    throw new Error(`Unknown E2E suite: ${suiteName}`);
  }
  return listScenarioNames();
}

export function getScenarioDefinition(
  scenarioName: string,
): ScenarioDefinition {
  const scenario = scenarios.find((entry) => entry.name === scenarioName);
  if (!scenario) {
    throw new Error(`Unknown E2E scenario: ${scenarioName}`);
  }
  return scenario;
}
