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

const detoxScenarios: readonly DetoxScenarioDefinition[] = [
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
