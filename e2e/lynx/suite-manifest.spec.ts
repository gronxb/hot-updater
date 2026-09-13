import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LYNX_EXCLUDED_DEFAULT_SCENARIOS,
  readLynxDefaultScenarioNames,
  validateLynxScenarioManifest,
} from "./suite-manifest";

const repoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const sharedDefault = JSON.parse(
  readFileSync(
    path.join(repoDir, "e2e/detox/default-scenario-names.json"),
    "utf8",
  ),
) as string[];

function runDry(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      path.join(repoDir, "e2e/lynx/scripts/run.ts"),
      "--dry-run",
      ...args,
    ],
    { cwd: repoDir, encoding: "utf8" },
  );
}

function plannedScenarios(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^\d+\.\s+/, ""));
}

describe("Lynx E2E suite manifest", () => {
  it("equals the shared default in order minus only RN metadata migration", () => {
    const excluded = new Set<string>(LYNX_EXCLUDED_DEFAULT_SCENARIOS);
    const expected = sharedDefault.filter((name) => !excluded.has(name));
    const actual = readLynxDefaultScenarioNames(repoDir);

    expect(actual).toEqual(expected);
    expect(actual).not.toContain("metadata-v1-migration");
    expect(actual).toEqual(
      expect.arrayContaining([
        "bspatch-archive-to-diff-ota",
        "bspatch-consecutive-diff-ota",
        "bspatch-disabled-chain-rollback",
        "bspatch-manifest-diff-fallback",
      ]),
    );
  });

  it.each([
    {
      name: "an additional exclusion",
      manifest: sharedDefault.filter(
        (scenario) =>
          scenario !== "metadata-v1-migration" &&
          scenario !== "bspatch-archive-to-diff-ota",
      ),
    },
    {
      name: "an added Lynx-only scenario",
      manifest: [
        ...sharedDefault.filter(
          (scenario) => scenario !== "metadata-v1-migration",
        ),
        "lynx-only-shortcut",
      ],
    },
    {
      name: "a reordered scenario",
      manifest: [
        sharedDefault[1],
        sharedDefault[0],
        ...sharedDefault
          .slice(2)
          .filter((scenario) => scenario !== "metadata-v1-migration"),
      ],
    },
  ])("rejects $name", ({ manifest }) => {
    expect(() => validateLynxScenarioManifest(sharedDefault, manifest)).toThrow(
      "Lynx default manifest must equal the shared default manifest minus only metadata-v1-migration",
    );
  });

  it("rejects duplicate and malformed scenario names", () => {
    expect(() =>
      validateLynxScenarioManifest(sharedDefault, [
        "release-ota-recovery",
        "release-ota-recovery",
      ]),
    ).toThrow("Lynx default manifest must contain unique");
    expect(() =>
      validateLynxScenarioManifest(sharedDefault, [" release-ota-recovery"]),
    ).toThrow("Lynx default manifest must contain unique");
  });

  it("fails if the shared suite stops declaring the explicit exclusion", () => {
    expect(() =>
      validateLynxScenarioManifest(
        sharedDefault.filter(
          (scenario) => scenario !== "metadata-v1-migration",
        ),
        sharedDefault.filter(
          (scenario) => scenario !== "metadata-v1-migration",
        ),
      ),
    ).toThrow(
      "Shared default manifest no longer contains metadata-v1-migration",
    );
  });

  it("dry-run plans the validated Lynx suite", () => {
    const result = runDry(["--platform", "ios"]);
    expect(result.status).toBe(0);
    expect(plannedScenarios(result.stdout)).toEqual(
      readLynxDefaultScenarioNames(repoDir),
    );
  });

  it("rejects an unknown explicit scenario before device work", () => {
    const result = runDry([
      "--platform",
      "android",
      "--scenario",
      "lynx-shortcut",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown Lynx scenario: lynx-shortcut");
    expect(result.stdout).toBe("");
  });
});
