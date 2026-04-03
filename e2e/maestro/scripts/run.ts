#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { p } from "../../../packages/cli-tools/src/prompts.ts";
import {
  getScenarioNameFromFlowPath,
  listAvailableScenarioNames,
  listSuiteNames,
  type MaestroPlatform,
  resolveScenarioFlowPath,
  resolveSuiteScenarioNames,
} from "../scenarios.ts";

type RunOptions = {
  dryRun: boolean;
  help?: boolean;
  interactive: boolean;
  list?: boolean;
  platforms: MaestroPlatform[];
  reuseApp: boolean;
  scenarioInputs: string[];
  suiteName: string;
  suiteNameExplicitlySet: boolean;
};

type ScenarioRun = {
  flowPath: string;
  scenarioName: string;
};

type InteractiveSelectionMode = "custom" | "suite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(__dirname, "../../..");
const RUN_FLOW_SCRIPT_PATH = path.join(__dirname, "run-flow.ts");

function getRequiredArgValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function resolvePlatforms(value: string) {
  if (value === "all") {
    return ["ios", "android"] satisfies MaestroPlatform[];
  }

  if (value === "ios" || value === "android") {
    return [value];
  }

  throw new Error(`Unsupported platform: ${value}`);
}

function parseArgs(argv: string[]): RunOptions {
  const options: RunOptions = {
    dryRun: false,
    interactive: false,
    platforms: ["ios", "android"],
    reuseApp: true,
    scenarioInputs: [],
    suiteName: "default",
    suiteNameExplicitlySet: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--platform") {
      options.platforms = resolvePlatforms(
        getRequiredArgValue(argv, index, arg),
      );
      index += 1;
      continue;
    }
    if (arg === "--interactive" || arg === "-i") {
      options.interactive = true;
      continue;
    }
    if (arg === "--scenario" || arg === "--flow") {
      options.scenarioInputs.push(getRequiredArgValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--suite") {
      options.suiteName = getRequiredArgValue(argv, index, arg);
      options.suiteNameExplicitlySet = true;
      index += 1;
      continue;
    }
    if (arg === "--no-reuse-app") {
      options.reuseApp = false;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.scenarioInputs.length > 0 && options.suiteNameExplicitlySet) {
    throw new Error("Use either --suite or --scenario/--flow, not both.");
  }

  return options;
}

function usage() {
  return [
    "Usage:",
    "  node ./e2e/maestro/scripts/run.ts [--platform <ios|android|all>] [--suite <name>]",
    "  node ./e2e/maestro/scripts/run.ts [--platform <ios|android|all>] [--scenario <name>]...",
    "  node ./e2e/maestro/scripts/run.ts [--platform <ios|android|all>] [--flow <path>]...",
    "",
    "Examples:",
    "  pnpm run e2e:maestro",
    "  pnpm run e2e:maestro -- -i",
    "  pnpm run e2e:maestro:ios -- --scenario release-ota-recovery",
    "  pnpm run e2e:maestro -- --platform android --flow ./e2e/maestro/flows/force-update-auto-reload.yaml",
    "",
    "Options:",
    "  --platform <ios|android|all>  Select platform(s). Default: all",
    "  -i, --interactive             Pick platforms and scenarios with Clack prompts",
    "  --suite <name>                Run a named suite. Default: default",
    "  --scenario <name>             Run a scenario by file name without .yaml",
    "  --flow <path>                 Run a scenario by explicit YAML path",
    "  --no-reuse-app                Disable app reuse between sequential runs",
    "  --dry-run                     Print the execution plan without running flows",
    "  --list                        Print available suites and scenarios",
  ].join("\n");
}

function printCatalog() {
  const suiteNames = listSuiteNames();
  const availableScenarios = listAvailableScenarioNames();
  const defaultSuite = resolveSuiteScenarioNames("default");

  p.intro("Maestro E2E");
  p.note(
    [
      "Suites:",
      ...suiteNames.map((suiteName) => `  - ${suiteName}`),
      "",
      "Default suite order:",
      ...defaultSuite.map(
        (scenarioName, index) => `  ${index + 1}. ${scenarioName}`,
      ),
      "",
      "Available scenarios:",
      ...availableScenarios.map((scenarioName) => `  - ${scenarioName}`),
    ].join("\n"),
    "Catalog",
  );
  p.outro("Listed Maestro suites and scenarios.");
}

function resolveScenarioRuns(options: RunOptions): ScenarioRun[] {
  const scenarioInputs =
    options.scenarioInputs.length > 0
      ? options.scenarioInputs
      : resolveSuiteScenarioNames(options.suiteName);

  return scenarioInputs.map((input) => {
    const flowPath = resolveScenarioFlowPath(input);

    return {
      flowPath,
      scenarioName: getScenarioNameFromFlowPath(flowPath),
    };
  });
}

function formatRepoRelative(targetPath: string) {
  return path.relative(REPO_DIR, targetPath) || targetPath;
}

function formatRunPlan(
  platforms: MaestroPlatform[],
  scenarioRuns: ScenarioRun[],
  reuseApp: boolean,
) {
  const flowPaths = scenarioRuns.map((scenarioRun) =>
    formatRepoRelative(scenarioRun.flowPath),
  );

  return [
    "Platforms:",
    ...platforms.map((platform) => `  - ${platform}`),
    "",
    "Scenarios:",
    ...scenarioRuns.map(
      (scenarioRun, index) => `  ${index + 1}. ${scenarioRun.scenarioName}`,
    ),
    "",
    "Flows:",
    ...flowPaths.map((flowPath, index) => `  ${index + 1}. ${flowPath}`),
    "",
    `Reuse app: ${reuseApp ? "yes" : "no"}`,
  ].join("\n");
}

function showUsage() {
  p.note(usage(), "Usage");
}

function cancelInteractiveRun() {
  p.cancel("Maestro run cancelled.");
  process.exit(0);
}

function unwrapPromptValue<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    cancelInteractiveRun();
  }

  return value;
}

function resolveInitialScenarioNames(options: RunOptions) {
  if (options.scenarioInputs.length === 0) {
    return resolveSuiteScenarioNames(options.suiteName);
  }

  return options.scenarioInputs.map((input) =>
    getScenarioNameFromFlowPath(resolveScenarioFlowPath(input)),
  );
}

async function promptForOptions(
  initialOptions: RunOptions,
): Promise<RunOptions> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("-i/--interactive requires a TTY.");
  }

  const defaultSuiteScenarios = resolveSuiteScenarioNames("default");
  const initialScenarioNames = resolveInitialScenarioNames(initialOptions);
  const availableScenarios = listAvailableScenarioNames();

  p.intro("Maestro E2E");

  const platforms = unwrapPromptValue(
    await p.multiselect<MaestroPlatform>({
      initialValues: initialOptions.platforms,
      message: "Choose platform(s)",
      options: [
        { hint: "iOS simulator", label: "iOS", value: "ios" },
        {
          hint: "Android device or emulator",
          label: "Android",
          value: "android",
        },
      ],
      required: true,
    }),
  );

  const selectionMode = unwrapPromptValue(
    await p.select<InteractiveSelectionMode>({
      initialValue:
        initialOptions.scenarioInputs.length > 0 ? "custom" : "suite",
      message: "What do you want to run?",
      options: [
        {
          hint: `${defaultSuiteScenarios.length} scenarios in the default order`,
          label: "Default suite",
          value: "suite",
        },
        {
          hint: "Pick one or more scenarios",
          label: "Custom scenarios",
          value: "custom",
        },
      ],
    }),
  );

  const scenarioInputs =
    selectionMode === "custom"
      ? unwrapPromptValue(
          await p.multiselect<string>({
            initialValues: initialScenarioNames,
            maxItems: 10,
            message: "Choose scenario(s)",
            options: availableScenarios.map((scenarioName) => ({
              hint: defaultSuiteScenarios.includes(scenarioName)
                ? "included in default suite"
                : undefined,
              label: scenarioName,
              value: scenarioName,
            })),
            required: true,
          }),
        )
      : [];

  const reuseApp = unwrapPromptValue(
    await p.confirm({
      initialValue: initialOptions.reuseApp,
      message: "Reuse the app between sequential scenarios?",
    }),
  );

  const promptedOptions: RunOptions = {
    ...initialOptions,
    platforms,
    reuseApp,
    scenarioInputs,
    suiteName: "default",
    suiteNameExplicitlySet: selectionMode === "suite",
  };
  const scenarioRuns = resolveScenarioRuns(promptedOptions);

  p.note(formatRunPlan(platforms, scenarioRuns, reuseApp), "Run plan");

  const shouldRun = unwrapPromptValue(
    await p.confirm({
      initialValue: true,
      message: "Start Maestro run now?",
    }),
  );

  if (!shouldRun) {
    cancelInteractiveRun();
  }

  p.outro("Starting Maestro E2E");
  return promptedOptions;
}

function runScenario(
  platform: MaestroPlatform,
  scenarioRun: ScenarioRun,
  reuseApp: boolean,
  dryRun: boolean,
) {
  const args = [
    RUN_FLOW_SCRIPT_PATH,
    "--platform",
    platform,
    "--flow",
    scenarioRun.flowPath,
  ];

  if (reuseApp) {
    args.push("--reuse-app");
  }

  const label = `${platform}/${scenarioRun.scenarioName}`;
  p.log.step(`Run ${label}${reuseApp ? " (reuse-app)" : ""}`);

  if (dryRun) {
    p.log.info(
      `${process.execPath} ${args.map((value) => JSON.stringify(value)).join(" ")}`,
    );
    return;
  }

  const result = spawnSync(process.execPath, args, {
    cwd: REPO_DIR,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Scenario failed: ${label}`);
  }
}

async function main() {
  let options = parseArgs(process.argv.slice(2));

  if (options.help) {
    showUsage();
    return;
  }

  if (options.list) {
    printCatalog();
    return;
  }

  if (options.interactive) {
    options = await promptForOptions(options);
  }

  const scenarioRuns = resolveScenarioRuns(options);

  if (!options.interactive) {
    p.intro("Maestro E2E");
    p.note(
      formatRunPlan(options.platforms, scenarioRuns, options.reuseApp),
      options.dryRun ? "Dry run plan" : "Run plan",
    );
  }

  for (const platform of options.platforms) {
    for (const [index, scenarioRun] of scenarioRuns.entries()) {
      runScenario(
        platform,
        scenarioRun,
        options.reuseApp && index > 0,
        options.dryRun,
      );
    }
  }

  if (!options.interactive) {
    p.outro(options.dryRun ? "Dry run complete." : "Maestro run complete.");
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown run error";
  p.log.error(message);
  process.exit(1);
}
