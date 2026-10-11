import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LYNX_REQUIRED_SCENARIO,
  readLynxDefaultScenarioNames,
  validateLynxScenarioManifest,
} from "./suite-manifest";

const repoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const sharedDefault = JSON.parse(
  readFileSync(path.join(repoDir, "e2e/scenario-names.json"), "utf8"),
) as string[];

function runDry(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      path.join(repoDir, "e2e/lynx/scripts/run.ts"),
      "--device",
      "00000000-0000-0000-0000-000000000000",
      "--dry-run",
      ...args,
    ],
    { cwd: repoDir, encoding: "utf8" },
  );
}

function plannedScenarios(stdout: string): string[] {
  return JSON.parse(stdout).scenarios;
}

describe("Lynx E2E suite manifest", () => {
  it("equals the shared default in order, then the Sparkling scenario", () => {
    const actual = readLynxDefaultScenarioNames(repoDir);

    expect(actual).toEqual([...sharedDefault, LYNX_REQUIRED_SCENARIO]);
    expect(actual).toEqual(
      expect.arrayContaining([
        "bspatch-builtin-to-diff-ota",
        "bspatch-consecutive-diff-ota",
        "bspatch-disabled-chain-rollback",
        "bspatch-manifest-diff-fallback",
      ]),
    );
  });

  it.each([
    {
      name: "an exclusion",
      manifest: [
        ...sharedDefault.filter(
          (scenario) => scenario !== "bspatch-builtin-to-diff-ota",
        ),
        LYNX_REQUIRED_SCENARIO,
      ],
    },
    {
      name: "an added Lynx-only scenario",
      manifest: [
        ...sharedDefault,
        LYNX_REQUIRED_SCENARIO,
        "lynx-only-shortcut",
      ],
    },
    {
      name: "a reordered scenario",
      manifest: [
        sharedDefault[1],
        sharedDefault[0],
        ...sharedDefault.slice(2),
        LYNX_REQUIRED_SCENARIO,
      ],
    },
  ])("rejects $name", ({ manifest }) => {
    expect(() => validateLynxScenarioManifest(sharedDefault, manifest)).toThrow(
      "Lynx default manifest must equal the shared default manifest followed by sparkling-multipage-ota",
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

  it("dry-run plans the validated Lynx suite", () => {
    const result = runDry(["--platform", "ios"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      runtime: "lynx",
      workers: 1,
      retries: 0,
    });
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
    expect(result.stderr).toContain("Unknown scenario: lynx-shortcut");
    expect(result.stdout).toBe("");
  });
});
