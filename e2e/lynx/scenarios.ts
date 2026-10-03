import {
  getDetoxScenarioDefinition,
  listDetoxScenarioNames,
} from "../detox/scenarios.ts";
import type { LynxAppDriver } from "./lynx-app-driver.ts";
import { lynxRuntimeChannelSwitchResetScenario } from "./scenarios/runtime-channel-switch-reset.ts";
import { sparklingMultipageOtaScenario } from "./scenarios/sparkling-multipage-ota.ts";

export type LynxScenarioDefinition = {
  readonly name: string;
  readonly run: (app: LynxAppDriver) => Promise<void>;
};

const lynxOnlyScenarios: readonly LynxScenarioDefinition[] = [
  sparklingMultipageOtaScenario,
];
const lynxScenarioOverrides: readonly LynxScenarioDefinition[] = [
  lynxRuntimeChannelSwitchResetScenario,
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
  const override = lynxScenarioOverrides.find(
    ({ name }) => name === scenarioName,
  );
  if (override) return override;
  const lynxOnly = lynxOnlyScenarios.find(({ name }) => name === scenarioName);
  if (lynxOnly) return lynxOnly;
  return getDetoxScenarioDefinition(scenarioName) as LynxScenarioDefinition;
}
