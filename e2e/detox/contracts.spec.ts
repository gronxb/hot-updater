import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDetoxSuiteScenarioNames } from "./scenarios.ts";

const repoDir = path.resolve(import.meta.dirname, "../..");
const packageJsonPath = path.join(repoDir, "package.json");
const detoxRunnerPath = path.join(repoDir, "e2e/detox/scripts/run.ts");
const detoxConfigPath = path.join(repoDir, ".detoxrc.js");
const detoxJestConfigPath = path.join(repoDir, "e2e/detox/jest.config.js");
const detoxControlServerPath = path.join(
  repoDir,
  "e2e/detox/scripts/control-server.ts",
);

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
  it("exposes Detox as the root E2E command surface", async () => {
    // Given: root scripts are the dashboard bot command surface.
    const rootPackage = await readRootPackageJson();

    const scripts = rootPackage.scripts ?? {};

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

  it("keeps Detox as the repository E2E harness directory", async () => {
    const detoxStat = await fs.stat(path.join(repoDir, "e2e", "detox"));

    expect(detoxStat.isDirectory()).toBe(true);
  });

  it("keeps the tracked E2E source surface Detox-first", async () => {
    const expectedE2eFiles = [
      "e2e/detox/control-server/controller.ts",
      "e2e/detox/control-server/crash-recovery-wait.spec.ts",
      "e2e/detox/control-server/crash-recovery-wait.ts",
      "e2e/detox/control-server/database-v2-contract.spec.ts",
      "e2e/detox/control-server/deploy-lock-contract.spec.ts",
      "e2e/detox/control-server/index.ts",
      "e2e/detox/control-server/routes.ts",
      "e2e/detox/control-server/screen-state.spec.ts",
      "e2e/detox/control-server/screen-state.ts",
      "e2e/detox/control-server/update-check-request-bundle-id.spec.ts",
      "e2e/detox/control-server/update-check-request-bundle-id.ts",
      "e2e/detox/control-server/update-check-visibility.spec.ts",
      "e2e/detox/control-server/update-check-visibility.ts",
      "e2e/detox/android-native.spec.ts",
      "e2e/detox/contracts.spec.ts",
      "e2e/detox/control-client.spec.ts",
      "e2e/detox/control-client.ts",
      "e2e/detox/control-protocol.ts",
      "e2e/detox/control-server-env.spec.ts",
      "e2e/detox/detox-assertion-contract.spec.ts",
      "e2e/detox/e2e-navigation-action-routes-contract.spec.ts",
      "e2e/detox/e2e-navigation-compact-contract.spec.ts",
      "e2e/detox/e2e-navigation-contract.spec.ts",
      "e2e/detox/e2e-navigation-stack-contract.spec.ts",
      "e2e/detox/detox-first-source.spec.ts",
      "e2e/detox/detox-page.js",
      "e2e/detox/detox-screen-routes.js",
      "e2e/detox/jest.config.js",
      "e2e/detox/proxy-url-contract.spec.ts",
      "e2e/detox/recovery-foreground.spec.ts",
      "e2e/detox/scenario-context.spec.ts",
      "e2e/detox/scenario-context.ts",
      "e2e/detox/scenario-contract.spec.ts",
      "e2e/detox/detox-app-driver.js",
      "e2e/detox/scenarios.spec.js",
      "e2e/detox/scenarios.ts",
      "e2e/detox/scenarios/bspatch-archive-to-diff-ota.ts",
      "e2e/detox/scenarios/bspatch-consecutive-diff-ota.ts",
      "e2e/detox/scenarios/bspatch-disabled-chain-rollback.ts",
      "e2e/detox/scenarios/bspatch-manifest-diff-fallback.ts",
      "e2e/detox/scenarios/disabled-bundle-rollback-to-builtin.ts",
      "e2e/detox/scenarios/disabled-bundle-rollback-to-previous-ota.ts",
      "e2e/detox/scenarios/force-update-auto-reload.ts",
      "e2e/detox/scenarios/multi-asset-replacement.ts",
      "e2e/detox/scenarios/numeric-cohort-rollout.ts",
      "e2e/detox/scenarios/release-ota-recovery.ts",
      "e2e/detox/scenarios/runtime-channel-switch-reset.ts",
      "e2e/detox/scenarios/target-cohorts-only.ts",
      "e2e/detox/scenarios/target-cohorts-rollout-interaction.ts",
      "e2e/detox/scenarios/targeted-cohort-switchback.ts",
      "e2e/detox/scenarios/types.ts",
      "e2e/detox/screen-routes/action-screen-routes.js",
      "e2e/detox/screen-routes/index.js",
      "e2e/detox/screen-routes/input-screen-routes.js",
      "e2e/detox/screen-routes/ready-screen-routes.js",
      "e2e/detox/screen-routes/result-screen-routes.js",
      "e2e/detox/screen-routes/runtime-screen-routes.js",
      "e2e/detox/screen-routes/status-screen-routes.js",
      "e2e/detox/scripts/control-server-env.ts",
      "e2e/detox/scripts/control-server.ts",
      "e2e/detox/scripts/run.ts",
    ];
    const result = spawnSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "e2e"],
      {
        cwd: repoDir,
        encoding: "utf8",
      },
    );
    const trackedFiles = (
      await Promise.all(
        result.stdout
          .split("\n")
          .filter(Boolean)
          .map(async (file) => {
            try {
              await fs.access(path.join(repoDir, file));
              return file;
            } catch (error) {
              if (error instanceof Error) return null;
              throw error;
            }
          }),
      )
    ).filter((file) => file !== null);

    expect(result.status).toBe(0);
    expect(trackedFiles.toSorted()).toEqual(expectedE2eFiles.toSorted());
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
    expect(configText).toContain("bail: 1");
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

  it("injects the fixed E2E min bundle id into Detox release builds", async () => {
    // Given: provider scenarios compare the built-in bundle id after rollbacks.
    const detoxConfig = await fs.readFile(detoxConfigPath, "utf8");

    // When: Detox builds the release binaries used by the dashboard.
    // Then: both native builds receive the same deterministic min bundle id.
    expect(detoxConfig).toContain(
      "HOT_UPDATER_MIN_BUNDLE_ID=00000000-0000-7000-8000-000000000000",
    );
    expect(detoxConfig).toContain(
      "-PMIN_BUNDLE_ID=00000000-0000-7000-8000-000000000000",
    );
  });

  it("pins the iOS Detox build to the resolved simulator destination", () => {
    // Given: dashboard split jobs resolve simulator names to UDIDs.
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        [
          "process.env.HOT_UPDATER_E2E_DEVICE_ID = '0368C5D9-1111-2222-3333-444455556666';",
          "const config = require('./.detoxrc.js');",
          "console.log(config.apps['ios.release'].build);",
        ].join(""),
      ],
      {
        cwd: repoDir,
        encoding: "utf8",
      },
    );

    // When: Detox reads the iOS release build command.
    // Then: xcodebuild receives an explicit destination instead of
    // relying on the first matching simulator.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "-destination 'id=0368C5D9-1111-2222-3333-444455556666'",
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

  it("lists the Detox-owned default suite", () => {
    const expectedScenarios = resolveDetoxSuiteScenarioNames("default");

    // When: the Detox runner prints its catalog.
    const result = runDetoxRunner("--list");

    // Then: the catalog contains every default scenario in order.
    expect(result.status).toBe(0);
    for (const [index, scenario] of expectedScenarios.entries()) {
      expect(result.stdout).toContain(`${index + 1}. ${scenario}`);
    }
  });

  it("keeps executable Detox harness files scenario-owned", async () => {
    const detoxRoots = [
      path.join(repoDir, "e2e/detox/scenarios.ts"),
      path.join(repoDir, "e2e/detox/scripts"),
      path.join(repoDir, "e2e/detox/scenarios"),
      path.join(repoDir, "e2e/detox/scenarios.spec.js"),
    ];
    const files: string[] = [];
    async function collectFiles(targetPath: string): Promise<void> {
      const stat = await fs.stat(targetPath);
      if (stat.isFile()) {
        files.push(targetPath);
        return;
      }
      const directory = targetPath;
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await collectFiles(absolutePath);
        } else if (entry.isFile() && /\.(?:ts|js|cjs|mjs)$/.test(entry.name)) {
          files.push(absolutePath);
        }
      }
    }
    for (const detoxRoot of detoxRoots) {
      await collectFiles(detoxRoot);
    }

    const joinedSource = (
      await Promise.all(files.map((file) => fs.readFile(file, "utf8")))
    ).join("\n");

    expect(joinedSource).toContain("releaseOtaRecoveryScenario");
    expect(joinedSource).toContain("getDetoxScenarioDefinition");
    expect(joinedSource).toContain("DetoxAppDriver");
  });

  it("prints a Detox command preview without launching Detox", () => {
    // Given: a focused scenario smoke run.
    const scenario = "release-ota-recovery";

    // When: the Detox runner is asked for an iOS command preview.
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
          HOT_UPDATER_E2E_CONTROL_BASE_URL: "http://127.0.0.1:3109",
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

  it("keeps Detox control traffic on the control port when provider PORT is set", async () => {
    // Given: split provider jobs run the update server and control plane on
    // different ports.
    const { buildDetoxChildEnv, buildDetoxControlServerEnv } = await import(
      detoxControlServerPath
    );
    const providerEnv = {
      HOT_UPDATER_CONTROL_BASE_URL: "http://127.0.0.1:3009/hot-updater",
      HOT_UPDATER_E2E_CONTROL_PORT: "3109",
      HOT_UPDATER_SERVER_PORT: "3009",
      PORT: "3009",
    } satisfies Record<string, string>;

    // When: the Detox runner prepares host-side Jest and control-server env.
    const detoxEnv = buildDetoxChildEnv("ios", providerEnv);
    const controlServerEnv = buildDetoxControlServerEnv("ios", providerEnv);

    // Then: Jest talks to the control server while the control server proxies
    // provider requests to the update server.
    expect(detoxEnv.CONTROL_URL).toBe("http://127.0.0.1:3109");
    expect(detoxEnv.HOT_UPDATER_E2E_CONTROL_BASE_URL).toBe(
      "http://127.0.0.1:3109",
    );
    expect(detoxEnv.PORT).toBe("3009");
    expect(controlServerEnv.PORT).toBe("3109");
    expect(controlServerEnv.HOT_UPDATER_E2E_APP_BASE_URL).toBe(
      "http://127.0.0.1:3009/hot-updater",
    );
    expect(controlServerEnv.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL).toBe(
      "http://localhost:3109/e2e/runtime-config",
    );
  });

  it("resolves an iOS simulator name to a UDID for xcodebuild", async () => {
    // Given: split dashboard jobs pass simulator names to Detox config.
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-xcrun-"),
    );
    const fakeXcrunPath = path.join(tempDir, "xcrun");
    await fs.writeFile(
      fakeXcrunPath,
      [
        "#!/usr/bin/env bash",
        "cat <<'JSON'",
        JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
              {
                isAvailable: true,
                name: "iPhone 16",
                udid: "0368C5D9-1111-2222-3333-444455556666",
              },
            ],
          },
        }),
        "JSON",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(fakeXcrunPath, 0o755);

    try {
      const { buildDetoxControlServerEnv } = await import(
        detoxControlServerPath
      );

      // When: the control server environment is prepared for iOS.
      const controlServerEnv = buildDetoxControlServerEnv("ios", {
        HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 16",
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
      });

      // Then: xcodebuild receives the simulator UDID, not the display name.
      expect(controlServerEnv.HOT_UPDATER_E2E_DEVICE_ID).toBe(
        "0368C5D9-1111-2222-3333-444455556666",
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
