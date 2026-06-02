#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

import {
  listDetoxScenarioNames,
  listDetoxSuiteNames,
  resolveDetoxSuiteScenarioNames,
} from "../scenarios.ts";

const supportedPlatforms = ["ios", "android"] as const;

type DetoxPlatform = (typeof supportedPlatforms)[number];

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
    "  pnpm -w e2e:detox -- --platform <ios|android|all> --suite <name>",
    "  pnpm -w e2e:detox -- --platform <ios|android|all> --scenario <name>",
    "",
    "Options:",
    "  --platform <ios|android|all>  Select platform(s). Default: all",
    "  --suite <name>                Run a named suite. Default: default",
    "  --scenario <name>             Run a scenario by name",
    "  --dry-run                     Print the execution plan without running Detox",
    "  --list                        Print available suites and scenarios",
  ].join("\n");
}

function printCatalog(): void {
  const defaultSuite = resolveDetoxSuiteScenarioNames("default");
  console.log(
    [
      "Detox E2E",
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
      throw new Error(`Unknown Detox scenario: ${scenario}`);
    }
  }
  return options.scenarioInputs;
}

function configurationForPlatform(platform: DetoxPlatform): string {
  switch (platform) {
    case "ios":
      return "ios.sim.release";
    case "android":
      return "android.emu.release";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function testNamePatternForScenarios(scenarios: readonly string[]): string {
  return `(?:^|\\s)(?:${scenarios.map(escapeRegExp).join("|")})$`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function nodeOptionsForDetox(): string {
  const existingOptions = (process.env.NODE_OPTIONS ?? "")
    .split(/\s+/)
    .filter(Boolean);
  if (existingOptions.includes("--experimental-vm-modules")) {
    return existingOptions.join(" ");
  }
  return [...existingOptions, "--experimental-vm-modules"].join(" ");
}

function detoxCommand(platform: DetoxPlatform, scenarios: readonly string[]) {
  return [
    "detox",
    "test",
    "--configuration",
    configurationForPlatform(platform),
    "--",
    "--runInBand",
    "--testNamePattern",
    shellQuote(testNamePatternForScenarios(scenarios)),
  ];
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
    "",
    "Detox command:",
    ...platforms.map(
      (platform) => `  ${detoxCommand(platform, scenarios).join(" ")}`,
    ),
  ].join("\n");
}

function run(options: RunOptions): number {
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
  if (options.dryRun) {
    console.log(plan);
    return 0;
  }

  console.log(plan);
  for (const platform of options.platforms) {
    const command = detoxCommand(platform, scenarios);
    const result = spawnSync(command[0], command.slice(1), {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptionsForDetox(),
      },
      stdio: "inherit",
    });
    if (result.status !== 0) {
      return result.status ?? 1;
    }
  }
  return 0;
}

try {
  process.exitCode = run(parseArgs(process.argv.slice(2)));
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    throw error;
  }
  process.exitCode = 1;
}
