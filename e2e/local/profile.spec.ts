import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { planAndroidReverses } from "../mobile/android-reverse.ts";
import { createNativeBuildPlan } from "../mobile/build.ts";
import { buildControlServerEnv } from "../shared/scripts/control-server-env.ts";
import { preserveFiles } from "./files.ts";
import {
  createLocalProfile,
  localAppConfig,
  localEnvFile,
  selectDevice,
  siloImage,
} from "./profile.ts";

describe("local standalone profile", () => {
  it.each(["android", "ios"] as const)(
    "isolates a local Lynx %s run from inherited RN paths and remote admin endpoints",
    (platform) => {
      const profile = createLocalProfile({
        root: "/checkout",
        platform,
        runtime: "lynx",
        runDir: "/checkout/e2e/results/local/run",
        id: "abc",
        providerPort: 4001,
        controlPort: 4002,
        storagePort: 4003,
        token: "local-admin",
        storagePassword: "local-storage",
        env: {
          HOT_UPDATER_E2E_ENV_TARGET_DIR: "/other/examples/v0.85.0",
          HOT_UPDATER_E2E_IOS_APP_ID: "com.example.rn",
          HOT_UPDATER_E2E_ANDROID_APK_PATH: "/other/app.apk",
          HOT_UPDATER_STANDALONE_BASE_URL: "https://outside.invalid/admin",
        },
      });
      expect(profile.appDir).toBe("/checkout/examples/lynx");
      expect(profile.env.HOT_UPDATER_E2E_ENV_TARGET_DIR).toBe(profile.appDir);
      expect(profile.env.HOT_UPDATER_E2E_IOS_APP_ID).toBe(
        "com.hotupdater.lynxexample",
      );
      expect(profile.env.HOT_UPDATER_E2E_APP_ID).toBe(
        "com.hotupdater.lynxexample",
      );
      expect(profile.env.HOT_UPDATER_E2E_ANDROID_BINARY_PATH).toBe(
        "/checkout/examples/lynx/android/e2e-app/build/outputs/apk/release/e2e-app-release.apk",
      );
      expect(profile.env.HOT_UPDATER_E2E_IOS_BINARY_PATH).toBe(
        "/checkout/examples/lynx/ios/build/e2e/Build/Products/Release-iphonesimulator/SparklingGoE2E.app",
      );
      expect(profile.env.HOT_UPDATER_STANDALONE_BASE_URL).toBeUndefined();
      expect(
        buildControlServerEnv(platform, profile.env).HOT_UPDATER_E2E_APP_ID,
      ).toBe("com.hotupdater.lynxexample");
    },
  );
  it("isolates local services from inherited cloud client and native build settings", () => {
    const profile = createLocalProfile({
      root: "/checkout",
      platform: "ios",
      runDir: "/checkout/e2e/results/run",
      id: "abc",
      providerPort: 3001,
      controlPort: 3002,
      storagePort: 3003,
      token: "local-admin",
      storagePassword: "local-storage",
      env: {
        NODE_ENV: "development",
        BABEL_ENV: "development",
        HOT_UPDATER_E2E_DEVICE_ID: "00000000-0000-0000-0000-000000000001",
        HOT_UPDATER_API_KEY: "cloud-api-key",
        CONTROL_URL: "https://outside.invalid",
        HOT_UPDATER_E2E_ANDROID_BINARY_PATH: "/old.apk",
      },
    });
    expect(profile.env).toMatchObject({
      NODE_ENV: "production",
      BABEL_ENV: "production",
      HOT_UPDATER_E2E_LOCAL_PROVIDER: "1",
      TEST_DB_PATH: "/checkout/e2e/results/run/database",
      AWS_S3_ENDPOINT: "http://127.0.0.1:3003",
      HOT_UPDATER_E2E_RUNTIME_CONFIG_URL:
        "http://127.0.0.1:3002/e2e/runtime-config",
      HOT_UPDATER_APP_BASE_URL: "http://127.0.0.1:3001/hot-updater",
    });
    expect(profile.env.HOT_UPDATER_API_KEY).toBeUndefined();
    expect(profile.env.CONTROL_URL).toBeUndefined();
    expect(profile.env.HOT_UPDATER_E2E_ANDROID_BINARY_PATH).toBeUndefined();
    const builds = createNativeBuildPlan(
      { platform: "ios", dryRun: false },
      profile.root,
      profile.env,
    );
    for (const build of builds) {
      expect({ ...profile.env, ...build.env }).toMatchObject({
        NODE_ENV: "production",
        BABEL_ENV: "production",
      });
    }
    expect(buildControlServerEnv("ios", profile.env)).toMatchObject({
      NODE_ENV: "production",
      BABEL_ENV: "production",
    });
    const file = localEnvFile(profile.env);
    expect(file).not.toContain("cloud-api-key");
    expect(file).not.toContain("outside.invalid");
    expect(localAppConfig("appVersion")).not.toContain("local-admin");
  });

  it("uses Android loopback URLs allowed by native cleartext policy and reverse mappings", async () => {
    const profile = createLocalProfile({
      root: "/checkout",
      platform: "android",
      runDir: "/checkout/e2e/results/run",
      id: "abc",
      providerPort: 4001,
      controlPort: 4002,
      storagePort: 4003,
      token: "local-admin",
      storagePassword: "local-storage",
      env: {},
    });
    const childEnv = buildControlServerEnv("android", profile.env);
    expect(childEnv.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL).toBe(
      "http://127.0.0.1:3107/e2e/runtime-config",
    );
    // The storage port too: presigned download URLs name the local S3.
    expect(planAndroidReverses(childEnv)).toEqual([
      { device: "tcp:4001", host: "tcp:4001" },
      { device: "tcp:4003", host: "tcp:4003" },
      { device: "tcp:3107", host: "tcp:4002" },
    ]);
    const policy = await fs.readFile(
      new URL(
        "../../examples/v0.85.0/android/app/src/main/res/xml/network_security_config.xml",
        import.meta.url,
      ),
      "utf8",
    );
    const allowedDomains = [
      ...policy.matchAll(
        /<domain-config\s+cleartextTrafficPermitted="true">([\s\S]*?)<\/domain-config>/g,
      ),
    ].flatMap(([, config]) =>
      [...config.matchAll(/<domain(?:\s[^>]*)?>([^<]+)<\/domain>/g)].map(
        ([, hostname]) => hostname.trim(),
      ),
    );
    for (const key of [
      "HOT_UPDATER_APP_BASE_URL",
      "HOT_UPDATER_E2E_RUNTIME_CONFIG_URL",
      "AWS_S3_ENDPOINT",
    ]) {
      const url = new URL(profile.env[key]!);
      expect(url.protocol).toBe("http:");
      expect(allowedDomains, `${key}: ${url.hostname}`).toContain(url.hostname);
    }
  });

  it("uses the pinned storage image and refuses unpinned or unrelated images", () => {
    expect(
      siloImage(
        "services:\n  minio:\n    image: pgsty/silo:RELEASE.2026-09-16T00-00-00Z\n",
      ),
    ).toBe("pgsty/silo:RELEASE.2026-09-16T00-00-00Z");
    expect(() =>
      siloImage("services:\n  minio:\n    image: other/image:latest\n"),
    ).toThrow("pinned Silo");
    expect(() =>
      siloImage("services:\n  minio:\n    image: pgsty/silo:latest\n"),
    ).toThrow("pinned Silo");
  });

  it("selects only an unambiguous booted iOS device or the explicit available ID", () => {
    const state = JSON.stringify({
      devices: {
        ios: [
          { udid: "booted", name: "Phone", state: "Booted", isAvailable: true },
          {
            udid: "shutdown",
            name: "Other",
            state: "Shutdown",
            isAvailable: true,
          },
          {
            udid: "unavailable",
            name: "Old",
            state: "Booted",
            isAvailable: false,
          },
        ],
      },
    });
    expect(selectDevice("ios", state)).toBe("booted");
    expect(selectDevice("ios", state, "shutdown")).toBe("shutdown");
    expect(() => selectDevice("ios", state, "unavailable")).toThrow(
      "unavailable",
    );
  });

  it("refuses ambiguous Android devices, offline emulators, and physical phones", () => {
    const state =
      "List of devices attached\nemulator-5554 device product:sdk\nemulator-5556 device\nemulator-5558 offline\nphysical-phone device\n";
    expect(() => selectDevice("android", state)).toThrow(
      "emulator-5554, emulator-5556",
    );
    expect(selectDevice("android", state, "emulator-5556")).toBe(
      "emulator-5556",
    );
    expect(() => selectDevice("android", state, "physical-phone")).toThrow(
      "unavailable",
    );
    expect(() => selectDevice("android", state, "emulator-5558")).toThrow(
      "unavailable",
    );
  });

  it("restores existing caller bytes and permissions and removes newly generated files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hu-local-files-"));
    try {
      const original = Buffer.from([0, 1, 2, 13, 10]);
      await fs.writeFile(path.join(dir, "config"), original, { mode: 0o640 });
      const backupDir = path.join(dir, "originals");
      const restore = await preserveFiles(
        dir,
        ["config", "generated"],
        backupDir,
      );
      expect(await fs.readFile(path.join(backupDir, "0"))).toEqual(original);
      expect((await fs.stat(backupDir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(backupDir, "0"))).mode & 0o777).toBe(
        0o600,
      );
      expect(
        JSON.parse(
          await fs.readFile(path.join(backupDir, "manifest.json"), "utf8"),
        ),
      ).toEqual([
        { path: path.join(dir, "config"), mode: 0o640, backup: "0" },
        { path: path.join(dir, "generated"), backup: null },
      ]);
      try {
        await fs.writeFile(path.join(dir, "config"), "temporary credentials", {
          mode: 0o600,
        });
        await fs.chmod(path.join(dir, "config"), 0o600);
        await fs.writeFile(
          path.join(dir, "generated"),
          "temporary native config",
        );
        throw new Error("native build failed");
      } catch {
        await restore();
      }
      expect(await fs.readFile(path.join(dir, "config"))).toEqual(original);
      expect((await fs.stat(path.join(dir, "config"))).mode & 0o777).toBe(
        0o640,
      );
      await expect(fs.stat(path.join(dir, "generated"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a caller's symlinked configuration", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hu-local-symlink-"));
    try {
      const target = path.join(dir, "private-config");
      await fs.writeFile(target, "original");
      await fs.symlink(target, path.join(dir, "config"));
      await expect(preserveFiles(dir, ["config"])).rejects.toThrow("non-file");
      expect(await fs.readFile(target, "utf8")).toBe("original");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
