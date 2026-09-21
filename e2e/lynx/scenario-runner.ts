import path from "node:path";

import type { DetoxPlatform } from "../detox/scripts/control-server.ts";

type ControlServerHandle = {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
};

export type ScenarioExecution = {
  readonly controlServer: ControlServerHandle;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: DetoxPlatform;
  readonly scenarioName: string;
};

type ScenarioRunnerDependencies = {
  readonly error: (message: string) => void;
  readonly executeScenario: (execution: ScenarioExecution) => Promise<void>;
  readonly log: (message: string) => void;
  readonly startControlServer: (
    platform: DetoxPlatform,
    env: NodeJS.ProcessEnv,
  ) => Promise<ControlServerHandle>;
};

type ScenarioRunnerOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: DetoxPlatform;
  readonly resultsRoot: string;
  readonly scenarios: readonly string[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runScenarioBatch(
  options: ScenarioRunnerOptions,
  dependencies: ScenarioRunnerDependencies,
): Promise<number> {
  let failed = false;

  for (const scenarioName of options.scenarios) {
    dependencies.log(`Start ${options.platform}/${scenarioName}`);
    const env: NodeJS.ProcessEnv = {
      ...options.env,
      HOT_UPDATER_E2E_RESULTS_DIR: path.join(
        options.resultsRoot,
        options.platform,
        scenarioName,
      ),
    };
    delete env.CONTROL_URL;
    delete env.HOT_UPDATER_E2E_CONTROL_BASE_URL;
    const controlServer = await dependencies.startControlServer(
      options.platform,
      env,
    );

    try {
      await dependencies.executeScenario({
        controlServer,
        env,
        platform: options.platform,
        scenarioName,
      });
      dependencies.log(`Scenario passed: ${options.platform}/${scenarioName}`);
    } catch (error) {
      failed = true;
      dependencies.error(
        `Scenario failed: ${options.platform}/${scenarioName}`,
      );
      dependencies.error(errorMessage(error));
    } finally {
      await controlServer.stop();
    }
  }

  return failed ? 1 : 0;
}
