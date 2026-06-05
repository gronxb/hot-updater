import { bspatchArchiveToDiffOtaScenario } from "./scenarios/bspatch-archive-to-diff-ota.ts";
import { bspatchConsecutiveDiffOtaScenario } from "./scenarios/bspatch-consecutive-diff-ota.ts";
import { bspatchDisabledChainRollbackScenario } from "./scenarios/bspatch-disabled-chain-rollback.ts";
import { bspatchManifestDiffFallbackScenario } from "./scenarios/bspatch-manifest-diff-fallback.ts";
import { disabledBundleRollbackToBuiltinScenario } from "./scenarios/disabled-bundle-rollback-to-builtin.ts";
import { disabledBundleRollbackToPreviousOtaScenario } from "./scenarios/disabled-bundle-rollback-to-previous-ota.ts";
import { forceUpdateAutoReloadScenario } from "./scenarios/force-update-auto-reload.ts";
import { multiAssetReplacementScenario } from "./scenarios/multi-asset-replacement.ts";
import { numericCohortRolloutScenario } from "./scenarios/numeric-cohort-rollout.ts";
import { releaseOtaRecoveryScenario } from "./scenarios/release-ota-recovery.ts";
import { runtimeChannelSwitchResetScenario } from "./scenarios/runtime-channel-switch-reset.ts";
import { targetCohortsOnlyScenario } from "./scenarios/target-cohorts-only.ts";
import { targetCohortsRolloutInteractionScenario } from "./scenarios/target-cohorts-rollout-interaction.ts";
import { targetedCohortSwitchbackScenario } from "./scenarios/targeted-cohort-switchback.ts";
import type { DetoxScenarioDefinition } from "./scenarios/types.ts";

export type {
  DetoxScenarioDefinition,
  DetoxScenarioDriver,
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
