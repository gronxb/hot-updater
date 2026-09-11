#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createControlClient } from "../../detox/control-client.ts";
import {
  getDetoxScenarioDefinition,
  listDetoxScenarioNames,
  listDetoxSuiteNames,
  resolveDetoxSuiteScenarioNames,
} from "../../detox/scenarios.ts";
import {
  type DetoxPlatform,
  startDetoxControlServer,
} from "../../detox/scripts/control-server.ts";
import { LynxAppDriver } from "../lynx-app-driver.ts";

const repoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const supportedPlatforms = ["ios", "android"] as const;

type RunOptions = {
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly list: boolean;
  readonly platforms: readonly DetoxPlatform[];
  readonly scenarioInputs: readonly string[];
  readonly suiteName: string;
  readonly suiteNameExplicitlySet: boolean;
};

function getRequiredArgValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function resolvePlatforms(value: string): readonly DetoxPlatform[] {
  if (value === "all") {
    return supportedPlatforms;
  }
  if (value === "ios" || value === "android") {
    return [value];
  }
  throw new Error(`Unsupported platform: ${value}`);
}

function parseScenarioEnv(): readonly string[] {
  return (process.env.HOT_UPDATER_E2E_SCENARIOS ?? "")
    .split(",")
    .map((scenario) => scenario.trim())
    .filter(Boolean);
}

function parseArgs(argv: readonly string[]): RunOptions {
  const scenarioInputs = [...parseScenarioEnv()];
  let platforms: readonly DetoxPlatform[] = supportedPlatforms;
  let dryRun = false;
  let help = false;
  let list = false;
  let suiteName = "default";
  let suiteNameExplicitlySet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--platform") {
      platforms = resolvePlatforms(getRequiredArgValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--scenario") {
      scenarioInputs.push(getRequiredArgValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--suite") {
      suiteName = getRequiredArgValue(argv, index, arg);
      suiteNameExplicitlySet = true;
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--list") {
      list = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (scenarioInputs.length > 0 && suiteNameExplicitlySet) {
    throw new Error("Use either --suite or --scenario, not both.");
  }

  return {
    dryRun,
    help,
    list,
    platforms,
    scenarioInputs,
    suiteName,
    suiteNameExplicitlySet,
  };
}

function usage(): string {
  return [
    "Usage:",
    "  pnpm -w e2e:lynx -- --platform <ios|android|all> --suite <name>",
    "  pnpm -w e2e:lynx -- --platform <ios|android|all> --scenario <name>",
    "",
    "Options:",
    "  --platform <ios|android|all>  Select platform(s). Default: all",
    "  --suite <name>                Run a named suite. Default: default",
    "  --scenario <name>             Run a scenario by name",
    "  --dry-run                     Print the execution plan without running",
    "  --list                        Print available suites and scenarios",
  ].join("\n");
}

function printCatalog(): void {
  const defaultSuite = resolveDetoxSuiteScenarioNames("default");
  console.log(
    [
      "Lynx E2E",
      "",
      "Suites:",
      ...listDetoxSuiteNames().map((suiteName) => `  - ${suiteName}`),
      "",
      "Default suite order:",
      ...defaultSuite.map((scenario, index) => `  ${index + 1}. ${scenario}`),
      "",
      "Available scenarios:",
      ...listDetoxScenarioNames().map((scenario) => `  - ${scenario}`),
    ].join("\n"),
  );
}

function resolveScenarioNames(options: RunOptions): readonly string[] {
  if (options.scenarioInputs.length === 0) {
    return resolveDetoxSuiteScenarioNames(options.suiteName);
  }

  const availableScenarios = new Set(listDetoxScenarioNames());
  for (const scenario of options.scenarioInputs) {
    if (!availableScenarios.has(scenario)) {
      throw new Error(`Unknown Lynx scenario: ${scenario}`);
    }
  }
  return options.scenarioInputs;
}

function formatRunPlan(
  platforms: readonly DetoxPlatform[],
  scenarios: readonly string[],
): string {
  return [
    "Platforms:",
    ...platforms.map((platform) => `  - ${platform}`),
    "",
    "Scenarios:",
    ...scenarios.map((scenario, index) => `  ${index + 1}. ${scenario}`),
  ].join("\n");
}

function lynxChildEnv(platform: DetoxPlatform): NodeJS.ProcessEnv {
  const exampleDir =
    process.env.HOT_UPDATER_E2E_ENV_TARGET_DIR ??
    path.join(repoDir, "examples/lynx");
  return {
    ...process.env,
    HOT_UPDATER_E2E_ENV_TARGET_DIR: exampleDir,
    HOT_UPDATER_E2E_PLATFORM: platform,
    HOT_UPDATER_E2E_APP_ID:
      process.env.HOT_UPDATER_E2E_APP_ID ?? "com.hotupdater.lynxexample",
    HOT_UPDATER_E2E_IOS_APP_ID:
      process.env.HOT_UPDATER_E2E_IOS_APP_ID ?? "com.hotupdater.lynxexample",
  };
}

async function runScenarios(
  platform: DetoxPlatform,
  scenarios: readonly string[],
): Promise<void> {
  const env = lynxChildEnv(platform);
  const controlServer = await startDetoxControlServer(platform, env);
  const controlClient = createControlClient({
    baseUrl: controlServer.baseUrl,
    onStageTiming: (timing) => {
      console.log(`[lynx-stage:timing] ${JSON.stringify(timing)}`);
    },
  });
  try {
    for (const scenarioName of scenarios) {
      console.log(`Start ${platform}/${scenarioName}`);
      const bootstrapResult = await controlClient.runJob(
        "bootstrap",
        "/e2e/jobs/bootstrap",
        {},
      );
      const app = new LynxAppDriver(
        controlClient,
        platform,
        env,
        bootstrapResult,
      );
      app.ensureInstalled();
      await controlClient.runJob(
        "reset remote bundles",
        "/e2e/jobs/reset-remote-bundles",
        {},
      );
      await controlClient.postJson(
        "reset local app state",
        "/e2e/reset-local-app-state",
        {},
      );
      const scenario = getDetoxScenarioDefinition(scenarioName);
      await scenario.run(app);
      console.log(`Scenario passed: ${platform}/${scenarioName}`);
    }
  } finally {
    await controlServer.stop();
  }
}

async function run(options: RunOptions): Promise<number> {
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.list) {
    printCatalog();
    return 0;
  }

  const scenarios = resolveScenarioNames(options);
  const plan = formatRunPlan(options.platforms, scenarios);
  console.log(plan);
  if (options.dryRun) {
    return 0;
  }

  for (const platform of options.platforms) {
    await runScenarios(platform, scenarios);
  }
  return 0;
}

try {
  process.exitCode = await run(parseArgs(process.argv.slice(2)));
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    throw error;
  }
  process.exitCode = 1;
}
