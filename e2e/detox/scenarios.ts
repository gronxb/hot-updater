import { readFileSync } from "node:fs";
import path from "node:path";

import { bspatchArchiveToDiffOtaScenario } from "./scenarios/bspatch-archive-to-diff-ota.ts";
import { bspatchConsecutiveDiffOtaScenario } from "./scenarios/bspatch-consecutive-diff-ota.ts";
import { bspatchDisabledChainRollbackScenario } from "./scenarios/bspatch-disabled-chain-rollback.ts";
import { bspatchManifestDiffFallbackScenario } from "./scenarios/bspatch-manifest-diff-fallback.ts";
import { catalogOnlyNoUpdateScenario } from "./scenarios/catalog-only-no-update.ts";
import { crashThenNextSafeUpdateScenario } from "./scenarios/crash-then-next-safe-update.ts";
import { disabledBundleRollbackToBuiltinScenario } from "./scenarios/disabled-bundle-rollback-to-builtin.ts";
import { disabledBundleRollbackToPreviousOtaScenario } from "./scenarios/disabled-bundle-rollback-to-previous-ota.ts";
import { explicitEmbeddedReceiptScenario } from "./scenarios/explicit-embedded-receipt.ts";
import { failedDownloadSameGenerationRetryScenario } from "./scenarios/failed-download-same-generation-retry.ts";
import { fingerprintInitialInstallScenario } from "./scenarios/fingerprint-initial-install.ts";
import { forceUpdateAutoReloadScenario } from "./scenarios/force-update-auto-reload.ts";
import { forwardReleaseRollbackOldBundleScenario } from "./scenarios/forward-release-rollback-old-bundle.ts";
import { metadataV1MigrationScenario } from "./scenarios/metadata-v1-migration.ts";
import { multiAssetReplacementScenario } from "./scenarios/multi-asset-replacement.ts";
import { numericCohortRolloutScenario } from "./scenarios/numeric-cohort-rollout.ts";
import { releaseOtaRecoveryScenario } from "./scenarios/release-ota-recovery.ts";
import { republishedCrashedBundleSkippedScenario } from "./scenarios/republished-crashed-bundle-skipped.ts";
import { runtimeChannelCrashRestoreScenario } from "./scenarios/runtime-channel-crash-restore.ts";
import { runtimeChannelSwitchResetScenario } from "./scenarios/runtime-channel-switch-reset.ts";
import { sameBundleReleaseAdoptionScenario } from "./scenarios/same-bundle-release-adoption.ts";
import { slowOldArtifactAfterNewerInstallScenario } from "./scenarios/slow-old-artifact-after-newer-install.ts";
import { staleCatalogAfterNewerGenerationScenario } from "./scenarios/stale-catalog-after-newer-generation.ts";
import { targetCohortsOnlyScenario } from "./scenarios/target-cohorts-only.ts";
import { targetCohortsRolloutInteractionScenario } from "./scenarios/target-cohorts-rollout-interaction.ts";
import { targetedCohortSwitchbackScenario } from "./scenarios/targeted-cohort-switchback.ts";
import { tenCrashHistorySafeBundleScenario } from "./scenarios/ten-crash-history-safe-bundle.ts";
import type { DetoxScenarioDefinition } from "./scenarios/types.ts";

export type {
  DetoxScenarioDefinition,
  DetoxAppDriver,
} from "./scenarios/types.ts";

const registeredDetoxScenarios: readonly DetoxScenarioDefinition[] = [
  releaseOtaRecoveryScenario,
  multiAssetReplacementScenario,
  bspatchArchiveToDiffOtaScenario,
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
  staleCatalogAfterNewerGenerationScenario,
  slowOldArtifactAfterNewerInstallScenario,
  failedDownloadSameGenerationRetryScenario,
  forwardReleaseRollbackOldBundleScenario,
  explicitEmbeddedReceiptScenario,
  republishedCrashedBundleSkippedScenario,
  crashThenNextSafeUpdateScenario,
  runtimeChannelCrashRestoreScenario,
  metadataV1MigrationScenario,
  tenCrashHistorySafeBundleScenario,
];

const scenarioByName = new Map(
  registeredDetoxScenarios.map((scenario) => [scenario.name, scenario]),
);
if (scenarioByName.size !== registeredDetoxScenarios.length) {
  throw new Error("Detox scenario registrations contain duplicate names");
}

const defaultScenarioNames: unknown = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "e2e/detox/default-scenario-names.json"),
    "utf8",
  ),
);
if (
  !Array.isArray(defaultScenarioNames) ||
  defaultScenarioNames.length === 0 ||
  !defaultScenarioNames.every(
    (name) => typeof name === "string" && name.length > 0,
  ) ||
  new Set(defaultScenarioNames).size !== defaultScenarioNames.length
) {
  throw new Error(
    "e2e/detox/default-scenario-names.json must contain unique scenario names",
  );
}

const detoxScenarios: readonly DetoxScenarioDefinition[] =
  defaultScenarioNames.map((name) => {
    const scenario = scenarioByName.get(name);
    if (!scenario) {
      throw new Error(`Default Detox scenario is not registered: ${name}`);
    }
    return scenario;
  });

if (detoxScenarios.length !== registeredDetoxScenarios.length) {
  const defaultScenarioSet = new Set(defaultScenarioNames);
  const unlisted = registeredDetoxScenarios
    .map((scenario) => scenario.name)
    .filter((name) => !defaultScenarioSet.has(name));
  throw new Error(
    `Registered Detox scenarios are missing from the default suite: ${unlisted.join(", ")}`,
  );
}

export function listDetoxSuiteNames(): readonly string[] {
  return ["default"];
}

export function listDetoxScenarioNames(): readonly string[] {
  return detoxScenarios.map((scenario) => scenario.name);
}

export function resolveDetoxSuiteScenarioNames(
  suiteName: string,
): readonly string[] {
  if (suiteName !== "default") {
    throw new Error(`Unknown Detox suite: ${suiteName}`);
  }
  return listDetoxScenarioNames();
}

export function getDetoxScenarioDefinition(
  scenarioName: string,
): DetoxScenarioDefinition {
  const scenario = detoxScenarios.find((entry) => entry.name === scenarioName);
  if (!scenario) {
    throw new Error(`Unknown Detox scenario: ${scenarioName}`);
  }
  return scenario;
}
