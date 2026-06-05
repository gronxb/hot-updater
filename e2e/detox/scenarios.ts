import type {
  DetoxScenarioDefinition,
  DetoxScenarioWave,
} from "./scenarios/types.ts";
import { wave1Scenarios } from "./scenarios/wave1.ts";
import { wave2Scenarios } from "./scenarios/wave2.ts";
import { wave3Scenarios } from "./scenarios/wave3.ts";
import { wave4Scenarios } from "./scenarios/wave4.ts";

export type {
  DetoxScenarioDefinition,
  DetoxScenarioDriver,
} from "./scenarios/types.ts";

export const detoxScenarioWaves: readonly DetoxScenarioWave[] = [
  {
    label: "recovery",
    scenarios: wave1Scenarios.map((scenario) => scenario.name),
    wave: 1,
  },
  {
    label: "asset and patch",
    scenarios: wave2Scenarios.map((scenario) => scenario.name),
    wave: 2,
  },
  {
    label: "channel and cohort",
    scenarios: wave3Scenarios.map((scenario) => scenario.name),
    wave: 3,
  },
  {
    label: "reload and rollback",
    scenarios: wave4Scenarios.map((scenario) => scenario.name),
    wave: 4,
  },
];

const detoxScenarios: readonly DetoxScenarioDefinition[] = [
  ...wave1Scenarios,
  ...wave2Scenarios,
  ...wave3Scenarios,
  ...wave4Scenarios,
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
