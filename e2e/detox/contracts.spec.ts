import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSuiteScenarioNames } from "../maestro/scenarios.ts";

const repoDir = path.resolve(import.meta.dirname, "../..");
const packageJsonPath = path.join(repoDir, "package.json");
const detoxRunnerPath = path.join(repoDir, "e2e/detox/scripts/run.ts");
const detoxConfigPath = path.join(repoDir, ".detoxrc.js");
const detoxJestConfigPath = path.join(repoDir, "e2e/detox/jest.config.js");

async function readRootPackageJson(): Promise<{
  readonly devDependencies?: Record<string, string>;
  readonly scripts?: Record<string, string>;
}> {
  return JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
}

function runDetoxRunner(...args: readonly string[]) {
  return runDetoxRunnerWithEnv(args);
}

function runDetoxRunnerWithEnv(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", detoxRunnerPath, ...args],
    {
      cwd: repoDir,
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
      },
    },
  );
}

describe("Detox E2E harness contract", () => {
  it("exposes root scripts without removing Maestro scripts", async () => {
    // Given: root scripts are the dashboard bot command surface.
    const rootPackage = await readRootPackageJson();

    // When: the migration adds Detox as a parallel harness.
    const scripts = rootPackage.scripts ?? {};

    // Then: both runner families are available.
    expect(scripts["e2e:maestro"]).toBe(
      "node --experimental-strip-types ./e2e/maestro/scripts/run.ts",
    );
    expect(scripts["e2e:detox"]).toBe(
      "node --experimental-strip-types ./e2e/detox/scripts/run.ts",
    );
    expect(scripts["e2e:detox:ios"]).toBe(
      "node --experimental-strip-types ./e2e/detox/scripts/run.ts --platform ios",
    );
    expect(scripts["e2e:detox:android"]).toBe(
      "node --experimental-strip-types ./e2e/detox/scripts/run.ts --platform android",
    );
    expect(rootPackage.devDependencies?.detox).toBe("20.51.3");
    expect(rootPackage.devDependencies?.jest).toBe("^29.7.0");
  });

  it("includes Detox config files needed by the CLI", async () => {
    // Given: Detox CLI discovery depends on root config files.
    const detoxConfig = await fs.readFile(detoxConfigPath, "utf8");
    const jestConfig = await fs.readFile(detoxJestConfigPath, "utf8");

    // When: Detox is configured for release simulator/emulator runs.
    const configText = `${detoxConfig}\n${jestConfig}`;

    // Then: both platform configurations and the Jest runner are declared.
    expect(configText).toContain("ios.sim.release");
    expect(configText).toContain("android.emu.release");
    expect(configText).toContain("HOT_UPDATER_E2E_IOS_BINARY_PATH");
    expect(configText).toContain("HOT_UPDATER_E2E_ANDROID_BINARY_PATH");
    expect(configText).toContain("HOT_UPDATER_E2E_ANDROID_TEST_BINARY_PATH");
    expect(configText).toContain("HOT_UPDATER_E2E_IOS_SIMULATOR_NAME");
    expect(configText).toContain("android.attached");
    expect(configText).toContain("HOT_UPDATER_E2E_ANDROID_SERIAL");
    expect(configText).toContain("e2e/detox/jest.config.js");
    expect(configText).toContain("maxWorkers: 1");
    expect(configText).toContain(
      'globalSetup: "detox/runners/jest/globalSetup"',
    );
    expect(configText).toContain(
      'globalTeardown: "detox/runners/jest/globalTeardown"',
    );
    expect(configText).toContain('reporters: ["detox/runners/jest/reporter"]');
    expect(configText).toContain(
      'testEnvironment: "detox/runners/jest/testEnvironment"',
    );
  });

  it("transforms TypeScript support modules loaded by Detox Jest", async () => {
    // Given: the Detox JS spec dynamically loads TypeScript scenario modules.
    const jestConfig = await fs.readFile(detoxJestConfigPath, "utf8");

    // When: Jest runs those modules inside the Detox runner.
    // Then: Babel is configured to strip TypeScript syntax before execution.
    expect(jestConfig).toContain("transform:");
    expect(jestConfig).toContain("babel-jest");
    expect(jestConfig).toContain("@babel/preset-typescript");
    expect(jestConfig).toContain("@babel/plugin-transform-modules-commonjs");
  });

  it("lists the same default suite as the Maestro harness", () => {
    // Given: the current Maestro default suite is the parity oracle.
    const expectedScenarios = resolveSuiteScenarioNames("default");

    // When: the Detox runner prints its catalog.
    const result = runDetoxRunner("--list");

    // Then: the catalog contains every default scenario in order.
    expect(result.status).toBe(0);
    for (const [index, scenario] of expectedScenarios.entries()) {
      expect(result.stdout).toContain(`${index + 1}. ${scenario}`);
    }
  });

  it("prints a dry-run plan without launching Detox", () => {
    // Given: a focused scenario smoke run.
    const scenario = "release-ota-recovery";

    // When: the Detox runner is asked for an iOS dry-run plan.
    const result = runDetoxRunner(
      "--platform",
      "ios",
      "--scenario",
      scenario,
      "--dry-run",
    );

    // Then: no device work starts and the selected scenario is visible.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Platforms:");
    expect(result.stdout).toContain("  - ios");
    expect(result.stdout).toContain("Scenarios:");
    expect(result.stdout).toContain(`1. ${scenario}`);
    expect(result.stdout).toContain("Detox command:");
  });

  it("passes multiple selected scenarios as one Jest full-name pattern", () => {
    const result = runDetoxRunner(
      "--platform",
      "android",
      "--scenario",
      "release-ota-recovery",
      "--scenario",
      "target-cohorts-only",
      "--dry-run",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--testNamePattern '(?:^|\\s)(?:");
    expect(result.stdout).toContain(
      "--testNamePattern '(?:^|\\s)(?:release-ota-recovery|target-cohorts-only)$'",
    );
    expect(result.stdout.match(/--testNamePattern/g)).toHaveLength(1);
  });

  it("passes Node VM module support to Detox Jest runs", async () => {
    // Given: a fake Detox binary captures the exact child-process environment.
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-detox-"),
    );
    const fakeDetoxPath = path.join(tempDir, "detox");
    const nodeOptionsPath = path.join(tempDir, "node-options.txt");
    const argvPath = path.join(tempDir, "argv.txt");
    await fs.writeFile(
      fakeDetoxPath,
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "${NODE_OPTIONS:-}" > "$HOT_UPDATER_DETOX_NODE_OPTIONS_PATH"',
        'printf "%s\\n" "$@" > "$HOT_UPDATER_DETOX_ARGV_PATH"',
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(fakeDetoxPath, 0o755);

    try {
      // When: the runner starts a real non-dry-run Detox command.
      const result = runDetoxRunnerWithEnv(
        ["--platform", "ios", "--scenario", "release-ota-recovery"],
        {
          HOT_UPDATER_DETOX_ARGV_PATH: argvPath,
          HOT_UPDATER_DETOX_NODE_OPTIONS_PATH: nodeOptionsPath,
          PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        },
      );

      // Then: Jest receives the VM flag required by dynamic TypeScript imports.
      expect(result.status).toBe(0);
      await expect(fs.readFile(nodeOptionsPath, "utf8")).resolves.toContain(
        "--experimental-vm-modules",
      );
      await expect(fs.readFile(argvPath, "utf8")).resolves.toContain(
        "--testNamePattern",
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
