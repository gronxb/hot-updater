import {
  getDetoxScenarioDefinition,
  listDetoxScenarioNames,
} from "../detox/scenarios.ts";
import type { LynxAppDriver } from "./lynx-app-driver.ts";
import { sparklingMultipageOtaScenario } from "./scenarios/sparkling-multipage-ota.ts";

export type LynxScenarioDefinition = {
  readonly name: string;
  readonly run: (app: LynxAppDriver) => Promise<void>;
};

const lynxOnlyScenarios: readonly LynxScenarioDefinition[] = [
  sparklingMultipageOtaScenario,
];

export function listLynxScenarioNames(): readonly string[] {
  return [
    ...listDetoxScenarioNames(),
    ...lynxOnlyScenarios.map(({ name }) => name),
  ];
}

export function getLynxScenarioDefinition(
  scenarioName: string,
): LynxScenarioDefinition {
  const lynxOnly = lynxOnlyScenarios.find(({ name }) => name === scenarioName);
  if (lynxOnly) return lynxOnly;
  return getDetoxScenarioDefinition(scenarioName) as LynxScenarioDefinition;
}
