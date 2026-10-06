import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSuiteScenarioNames } from "./scenarios.ts";
const repoDir = path.resolve(import.meta.dirname, "../..");
const controlServerPath = path.join(
  repoDir,
  "e2e/shared/scripts/control-server.ts",
);
describe("E2E harness contract", () => {
  it("exposes the mobile runner and the shared scenario manifest", async () => {
    const contract = JSON.parse(
      await fs.readFile(path.join(repoDir, "e2e/runner-contract.json"), "utf8"),
    );
    expect(contract).toEqual({
      version: 1,
      runners: ["mobile"],
      resultVersion: 1,
    });
    const names = JSON.parse(
      await fs.readFile(path.join(repoDir, "e2e/scenario-names.json"), "utf8"),
    );
    expect(names).toEqual(resolveSuiteScenarioNames("default"));
    const mobile = spawnSync(
      process.execPath,
      [path.join(repoDir, "e2e/mobile/run.ts"), "--list"],
      { cwd: repoDir, encoding: "utf8" },
    );
    expect(mobile.status, mobile.stderr).toBe(0);
    expect(mobile.stdout.trim().split("\n")).toEqual(names);
  });
  it("keeps E2E control traffic on the control port when provider PORT is set", async () => {
    // Given: split provider jobs run the update server and control plane on
    // different ports.
    const { buildChildEnv, buildControlServerEnv } = await import(
      controlServerPath
    );
    const providerEnv = {
      HOT_UPDATER_CONTROL_BASE_URL: "http://127.0.0.1:3009/hot-updater",
      HOT_UPDATER_E2E_CONTROL_PORT: "3109",
      HOT_UPDATER_SERVER_PORT: "3009",
      PORT: "3009",
    } satisfies Record<string, string>;

    // When: the E2E runner prepares host-side runner and control-server env.
    const childEnv = buildChildEnv("ios", providerEnv);
    const controlServerEnv = buildControlServerEnv("ios", providerEnv);

    // Then: The runner talks to the control server while the control server proxies
    // provider requests to the update server.
    expect(childEnv.CONTROL_URL).toBe("http://127.0.0.1:3109");
    expect(childEnv.HOT_UPDATER_E2E_CONTROL_BASE_URL).toBe(
      "http://127.0.0.1:3109",
    );
    expect(childEnv.PORT).toBe("3009");
    expect(controlServerEnv.PORT).toBe("3109");
    expect(controlServerEnv.HOT_UPDATER_E2E_APP_BASE_URL).toBe(
      "http://127.0.0.1:3009/hot-updater",
    );
    expect(controlServerEnv.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL).toBe(
      "http://localhost:3109/e2e/runtime-config",
    );
  });

  it("resolves an iOS simulator name to a UDID for xcodebuild", async () => {
    // Given: split dashboard jobs pass simulator names to E2E config.
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
      const { buildChildEnv, buildControlServerEnv } = await import(
        controlServerPath
      );

      // When: the control server environment is prepared for iOS.
      const controlServerEnv = buildControlServerEnv("ios", {
        HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 16",
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
      });

      const childEnv = buildChildEnv("ios", {
        HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 16",
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
      });
      expect(childEnv.HOT_UPDATER_E2E_DEVICE_ID).toBe(
        controlServerEnv.HOT_UPDATER_E2E_DEVICE_ID,
      );

      // Then: xcodebuild receives the simulator UDID, not the display name.
      expect(controlServerEnv.HOT_UPDATER_E2E_DEVICE_ID).toBe(
        "0368C5D9-1111-2222-3333-444455556666",
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
