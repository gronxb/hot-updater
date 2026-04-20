import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type MaestroPlatform = "ios" | "android";
export type MaestroSuiteName = "default";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(__dirname, "../..");
const FLOWS_DIR = path.join(__dirname, "flows");
const DEFAULT_SUITE_SCENARIOS = [
  "release-ota-recovery",
  "bspatch-ota",
  "runtime-channel-switch-reset",
  "numeric-cohort-rollout",
  "target-cohorts-with-rollout",
  "targeted-cohort-switchback",
  "force-update-auto-reload",
  "disabled-bundle-rollback-to-builtin",
  "disabled-bundle-rollback-to-previous-ota",
] as const;

function isScenarioFlowFile(entry: fs.Dirent) {
  return entry.isFile() && entry.name.endsWith(".yaml");
}

function formatScenarioList(scenarios: readonly string[]) {
  return scenarios.map((scenario) => `  - ${scenario}`).join("\n");
}

function formatOrderedScenarioList(scenarios: readonly string[]) {
  return scenarios
    .map((scenario, index) => `  ${index + 1}. ${scenario}`)
    .join("\n");
}

function isFlowPathInput(value: string) {
  return (
    value.includes("/") || value.includes(path.sep) || value.endsWith(".yaml")
  );
}

export function listAvailableScenarioNames() {
  return fs
    .readdirSync(FLOWS_DIR, { withFileTypes: true })
    .filter(isScenarioFlowFile)
    .map((entry) => path.basename(entry.name, path.extname(entry.name)))
    .sort();
}

export function getScenarioNameFromFlowPath(flowPath: string) {
  return path.basename(flowPath, path.extname(flowPath));
}

export function resolveScenarioFlowPath(input: string) {
  const flowPath = isFlowPathInput(input)
    ? path.resolve(REPO_DIR, input)
    : path.join(FLOWS_DIR, `${input}.yaml`);

  if (fs.existsSync(flowPath) && fs.statSync(flowPath).isFile()) {
    return flowPath;
  }

  throw new Error(
    [
      `Unknown Maestro scenario or flow path: ${input}`,
      "Available scenarios:",
      formatScenarioList(listAvailableScenarioNames()),
    ].join("\n"),
  );
}

export function listSuiteNames(): MaestroSuiteName[] {
  return ["default"];
}

export function resolveSuiteScenarioNames(suiteName: string) {
  if (suiteName !== "default") {
    throw new Error(
      [
        `Unknown Maestro suite: ${suiteName}`,
        "Available suites:",
        listSuiteNames()
          .map((availableSuiteName) => `  - ${availableSuiteName}`)
          .join("\n"),
      ].join("\n"),
    );
  }

  const availableScenarios = new Set(listAvailableScenarioNames());
  const missingScenarios = DEFAULT_SUITE_SCENARIOS.filter(
    (scenarioName) => !availableScenarios.has(scenarioName),
  );

  if (missingScenarios.length > 0) {
    throw new Error(
      [
        "Default Maestro suite references missing scenarios:",
        formatScenarioList(missingScenarios),
        "Expected default suite order:",
        formatOrderedScenarioList(DEFAULT_SUITE_SCENARIOS),
        "Available scenarios:",
        formatScenarioList(listAvailableScenarioNames()),
      ].join("\n"),
    );
  }

  return [...DEFAULT_SUITE_SCENARIOS];
}
