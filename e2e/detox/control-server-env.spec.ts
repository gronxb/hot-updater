import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildDetoxControlServerEnv } from "./scripts/control-server.ts";

describe("Detox control server environment", () => {
  it("uses a unique iOS DerivedData path for each split control server", () => {
    const first = buildDetoxControlServerEnv("ios", {
      HOT_UPDATER_E2E_CHANNEL_NAMESPACE: "e2e-job-ios-s1",
      HOT_UPDATER_E2E_CONTROL_PORT: "3107",
      HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 16",
    });
    const second = buildDetoxControlServerEnv("ios", {
      HOT_UPDATER_E2E_CHANNEL_NAMESPACE: "e2e-job-ios-s2",
      HOT_UPDATER_E2E_CONTROL_PORT: "3109",
      HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 17 Pro",
    });

    expect(first.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH).toContain(
      "e2e-job-ios-s1",
    );
    expect(second.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH).toContain(
      "e2e-job-ios-s2",
    );
    expect(first.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH).not.toBe(
      second.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH,
    );
  });

  it("preserves an explicit iOS DerivedData override", () => {
    const controlServerEnv = buildDetoxControlServerEnv("ios", {
      HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH: "/tmp/custom-derived-data",
    });

    expect(controlServerEnv.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH).toBe(
      "/tmp/custom-derived-data",
    );
  });

  it("uses the profile app base URL as the provider target when control proxy env is present", async () => {
    // Given: dashboard split jobs expose a control proxy URL and write the
    // provider URL to the env target file.
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-detox-env-"),
    );
    const envTargetPath = path.join(tempDir, ".env.hotupdater");
    await fs.writeFile(
      envTargetPath,
      "HOT_UPDATER_APP_BASE_URL=https://updates.example.com/hot-updater\n",
    );

    try {
      // When: the Detox control server env is built for a split child.
      const controlServerEnv = buildDetoxControlServerEnv("ios", {
        HOT_UPDATER_CONTROL_BASE_URL: "http://127.0.0.1:3009/hot-updater",
        HOT_UPDATER_E2E_CONTROL_PORT: "3109",
        HOT_UPDATER_E2E_ENV_TARGET_PATH: envTargetPath,
        HOT_UPDATER_SERVER_PORT: "3009",
        PORT: "3009",
      });

      // Then: provider proxying targets the real update server while control
      // traffic stays on the Detox control port.
      expect(controlServerEnv.PORT).toBe("3109");
      expect(controlServerEnv.HOT_UPDATER_E2E_APP_BASE_URL).toBe(
        "https://updates.example.com/hot-updater",
      );
      expect(controlServerEnv.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL).toBe(
        "http://localhost:3109/e2e/runtime-config",
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to the control proxy URL when the env target omits the app base URL", async () => {
    // Given: the env target file exists but does not contain the provider URL.
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-detox-env-"),
    );
    const envTargetPath = path.join(tempDir, ".env.hotupdater");
    await fs.writeFile(
      envTargetPath,
      [
        "# malformed and unrelated entries are ignored",
        "MALFORMED_LINE",
        "=missing-key",
        "OTHER_URL=https://updates.example.com/hot-updater",
      ].join("\n"),
    );

    try {
      // When: the Detox control server env is built for a split child.
      const controlServerEnv = buildDetoxControlServerEnv("ios", {
        HOT_UPDATER_CONTROL_BASE_URL: "http://127.0.0.1:3009/hot-updater",
        HOT_UPDATER_E2E_CONTROL_PORT: "3109",
        HOT_UPDATER_E2E_ENV_TARGET_PATH: envTargetPath,
      });

      // Then: malformed file content does not replace the configured proxy.
      expect(controlServerEnv.HOT_UPDATER_E2E_APP_BASE_URL).toBe(
        "http://127.0.0.1:3009/hot-updater",
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses one Android device runtime config port across split shards", () => {
    // Given: Android split shards run distinct host control servers and may
    // still carry stale per-shard device-port env from older runners.
    const first = buildDetoxControlServerEnv("android", {
      HOT_UPDATER_E2E_ANDROID_CONTROL_DEVICE_PORT: "3108",
      HOT_UPDATER_E2E_CONTROL_PORT: "3108",
      HOT_UPDATER_SERVER_PORT: "3008",
      PORT: "3008",
    });
    const second = buildDetoxControlServerEnv("android", {
      HOT_UPDATER_E2E_ANDROID_CONTROL_DEVICE_PORT: "3112",
      HOT_UPDATER_E2E_CONTROL_PORT: "3112",
      HOT_UPDATER_SERVER_PORT: "3012",
      PORT: "3012",
    });

    expect(first.HOT_UPDATER_E2E_ANDROID_CONTROL_DEVICE_PORT).toBe("3107");
    expect(first.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL).toBe(
      "http://localhost:3107/e2e/runtime-config",
    );
    expect(second.HOT_UPDATER_E2E_ANDROID_CONTROL_DEVICE_PORT).toBe("3107");
    expect(second.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL).toBe(
      "http://localhost:3107/e2e/runtime-config",
    );
  });
});
