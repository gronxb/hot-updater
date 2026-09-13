import { readFileSync } from "node:fs";
import path from "node:path";

export const LYNX_EXCLUDED_DEFAULT_SCENARIOS = [
  "metadata-v1-migration",
] as const;

function parseScenarioNames(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (name) =>
        typeof name === "string" && name.length > 0 && name.trim() === name,
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} must contain unique, non-empty scenario names`);
  }
  return value;
}

export function validateLynxScenarioManifest(
  sharedValue: unknown,
  lynxValue: unknown,
): readonly string[] {
  const shared = parseScenarioNames(sharedValue, "Shared default manifest");
  const lynx = parseScenarioNames(lynxValue, "Lynx default manifest");
  const excluded = new Set<string>(LYNX_EXCLUDED_DEFAULT_SCENARIOS);
  const expected = shared.filter((name) => !excluded.has(name));

  if (expected.length === shared.length) {
    throw new Error(
      "Shared default manifest no longer contains metadata-v1-migration",
    );
  }
  if (
    lynx.length !== expected.length ||
    lynx.some((name, index) => name !== expected[index])
  ) {
    throw new Error(
      "Lynx default manifest must equal the shared default manifest minus only metadata-v1-migration, in the same order",
    );
  }
  return lynx;
}

export function readLynxDefaultScenarioNames(
  repoDir: string,
): readonly string[] {
  const readJson = (relativePath: string): unknown =>
    JSON.parse(readFileSync(path.join(repoDir, relativePath), "utf8"));
  return validateLynxScenarioManifest(
    readJson("e2e/detox/default-scenario-names.json"),
    readJson("e2e/lynx/default-scenario-names.json"),
  );
}
