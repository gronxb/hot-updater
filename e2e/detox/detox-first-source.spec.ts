import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoDir = path.resolve(import.meta.dirname, "../..");
const detoxDir = path.join(repoDir, "e2e/detox");
const scenarioDir = path.join(detoxDir, "scenarios");
const e2eSourceDirectories = ["e2e/detox/"] as const;
const textScenarioFilePattern = /^e2e\/.*\.(?:ya?ml)$/i;
const legacyHarnessTerms = [
  "DetoxScenarioRuntime",
  "DetoxScenarioDriver",
  "scenario-runtime",
  "run-flow",
  "runFlow",
  "step.kind",
  "stages\\s*:",
] as const;
const legacyHarnessPattern = new RegExp(
  `\\b(?:${legacyHarnessTerms.join("|")})\\b`,
);
const controlServerPath = path.join(detoxDir, "control-server/controller.ts");
const expectedScenarioModuleFiles = [
  "bspatch-archive-to-diff-ota.ts",
  "bspatch-consecutive-diff-ota.ts",
  "bspatch-disabled-chain-rollback.ts",
  "bspatch-manifest-diff-fallback.ts",
  "catalog-only-no-update.ts",
  "crash-then-next-safe-update.ts",
  "disabled-bundle-rollback-to-builtin.ts",
  "disabled-bundle-rollback-to-previous-ota.ts",
  "explicit-embedded-receipt.ts",
  "failed-download-same-generation-retry.ts",
  "fingerprint-initial-install.ts",
  "force-update-auto-reload.ts",
  "forward-release-rollback-old-bundle.ts",
  "metadata-v1-migration.ts",
  "multi-asset-replacement.ts",
  "numeric-cohort-rollout.ts",
  "release-ota-recovery.ts",
  "republished-crashed-bundle-skipped.ts",
  "runtime-channel-crash-restore.ts",
  "runtime-channel-switch-reset.ts",
  "same-bundle-release-adoption.ts",
  "slow-old-artifact-after-newer-install.ts",
  "stale-catalog-after-newer-generation.ts",
  "target-cohorts-only.ts",
  "target-cohorts-rollout-interaction.ts",
  "targeted-cohort-switchback.ts",
  "ten-crash-history-safe-bundle.ts",
  "types.ts",
] as const;

function trackedE2eFiles(): readonly string[] {
  const result = spawnSync("git", ["ls-files", "e2e"], {
    cwd: repoDir,
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .filter((file) => existsSync(path.join(repoDir, file)));
}

describe("Detox-first source shape", () => {
  it("keeps active E2E source inside Detox-owned directories", () => {
    const activeE2eFiles = trackedE2eFiles();

    expect(
      activeE2eFiles.filter(
        (file) =>
          !e2eSourceDirectories.some((directory) => file.startsWith(directory)),
      ),
    ).toEqual([]);
    expect(
      activeE2eFiles.filter((file) => textScenarioFilePattern.test(file)),
    ).toEqual([]);
  });

  it("keeps example app ignore rules from hiding E2E source", async () => {
    const exampleIgnoreSource = await fs.readFile(
      path.join(repoDir, "examples/v0.85.0/.gitignore"),
      "utf8",
    );

    expect(exampleIgnoreSource).not.toMatch(/(?:^|\n)\/?e2e\/?(?:\n|$)/);
  });

  it("keeps each Detox scenario in an explicit catalog module", async () => {
    const scenarioFiles = (await fs.readdir(scenarioDir)).sort();

    expect(scenarioFiles).toEqual([...expectedScenarioModuleFiles].sort());
  });

  it("keeps Detox scenarios as executable app-driver specs, not translated flow data", async () => {
    const sourceFiles = trackedE2eFiles().filter(
      (file) => file.startsWith("e2e/detox/") && !file.includes(".spec."),
    );
    const sources = await Promise.all(
      sourceFiles.map(async (file) => ({
        file,
        source: await fs.readFile(path.join(repoDir, file), "utf8"),
      })),
    );

    expect(
      sources
        .filter(({ source }) => legacyHarnessPattern.test(source))
        .map(({ file }) => file),
    ).toEqual([]);
  });

  it("keeps native app build and install lifecycle in Detox config, not the fixture server", async () => {
    const controlServerSource = await fs.readFile(controlServerPath, "utf8");

    expect(controlServerSource).not.toMatch(
      /\b(?:xcodebuild|gradlew|pod install|simctl",\s*\["install"|adb",\s*\[[^\]]*"install")\b/,
    );
    expect(controlServerSource).not.toContain("reinstallBuiltInApp");
  });

  it("keeps per-interaction foreground recovery out of the control server", async () => {
    const controlServerSource = await fs.readFile(controlServerPath, "utf8");
    const routesSource = await fs.readFile(
      path.join(detoxDir, "control-server/routes.ts"),
      "utf8",
    );

    expect(controlServerSource).not.toContain("ensureAppForeground");
    expect(controlServerSource).not.toContain("android ensure foreground");
    expect(routesSource).not.toContain("/e2e/ensure-app-foreground");
  });

  it("keeps provider plugin method names at the fixture boundary", async () => {
    const controlServerSource = await fs.readFile(controlServerPath, "utf8");

    expect(controlServerSource).not.toContain(
      "databasePlugin.updateFixtureBundle",
    );
  });

  it("keeps provider visibility waits below the Detox stage timeout", async () => {
    const controlServerSource = await fs.readFile(controlServerPath, "utf8");

    expect(controlServerSource).toContain(
      "HOT_UPDATER_E2E_UPDATE_CHECK_VISIBILITY_ATTEMPTS",
    );
    expect(controlServerSource).toContain(
      "HOT_UPDATER_E2E_UPDATE_CHECK_EXCLUSION_ATTEMPTS",
    );
    expect(controlServerSource).toContain("update check visibility pending");
    expect(controlServerSource).toContain("Release catalog exclusion pending");
    expect(controlServerSource).not.toMatch(
      /waitForReleaseCatalogVisibility[\s\S]*index < 360/,
    );
    expect(controlServerSource).not.toMatch(
      /waitForReleaseCatalogExcludesRelease[\s\S]*index < 240/,
    );
  });

  it("probes the selector stored by the deployed Release catalog", async () => {
    const controlServerSource = await fs.readFile(controlServerPath, "utf8");

    expect(controlServerSource).toMatch(
      /args\.catalog\.strategy === "FINGERPRINT"[\s\S]{0,400}fingerprintHash: args\.catalog\.fingerprint_hash/,
    );
    expect(controlServerSource).toMatch(
      /waitForReleaseCatalogVisibility\(\{[\s\S]{0,120}catalog: deployed\.catalog/,
    );
    expect(controlServerSource).toMatch(
      /waitForReleaseCatalogExcludesRelease\(\{[\s\S]{0,120}catalog: result\.catalog/,
    );
    expect(controlServerSource).toMatch(
      /waitForReleaseCatalogVisibility\(\{[\s\S]{0,120}catalog: created\.catalog/,
    );
  });
});
