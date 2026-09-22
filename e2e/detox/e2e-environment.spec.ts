import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";

import { transformFileSync } from "@babel/core";
import { describe, expect, it, onTestFinished, vi } from "vitest";

const appRoot = path.resolve(import.meta.dirname, "../../examples/v0.85.0");
const publicSettings = {
  HOT_UPDATER_APP_BASE_URL: "https://updates.example.com/hot-updater",
  HOT_UPDATER_E2E_RUNTIME_CONFIG_URL:
    "http://localhost:3219/e2e/runtime-config",
  HOT_UPDATER_API_KEY: "public-client-key",
};

async function buildPublicSettings(
  file: string | null,
  overrides: NodeJS.ProcessEnv = {},
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "hot-updater-e2e-env-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, "src"));
  await copyFile(
    path.join(appRoot, "e2e-build-config.cjs"),
    path.join(cwd, "e2e-build-config.cjs"),
  );
  if (file !== null) {
    await writeFile(path.join(cwd, "profile.env"), file);
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("HOT_UPDATER_"),
    ),
  );
  const generated = execFileSync(
    process.execPath,
    [
      "-e",
      'require("./e2e-build-config.cjs"); process.stdout.write(JSON.stringify(require("./src/e2eBuildConfig.js")));',
    ],
    {
      cwd,
      env: {
        ...env,
        HOT_UPDATER_E2E_ENV_TARGET_PATH: path.join(cwd, "profile.env"),
        ...overrides,
      },
      encoding: "utf8",
    },
  );
  return JSON.parse(generated) as Record<string, string>;
}

function loadRuntimeConfig(
  buildSettings: Record<string, unknown>,
  launchArguments: Record<string, unknown>,
) {
  const code = transformFileSync(
    path.join(appRoot, "src/e2eRuntimeConfig.ts"),
    {
      babelrc: false,
      configFile: false,
      presets: ["@babel/preset-typescript"],
      plugins: ["@babel/plugin-transform-modules-commonjs"],
    },
  )!.code!;
  const runtime = {} as {
    fallbackHotUpdaterBaseURL: string;
    resolveHotUpdaterBaseURL(): Promise<string>;
  };
  const fetch = vi.fn(async () => {
    throw new Error("control server unavailable");
  });
  new Script(code).runInNewContext({
    exports: runtime,
    fetch,
    require: (name: string) => {
      if (name === "./e2eBuildConfig") return buildSettings;
      if (name === "react-native-launch-arguments") {
        return { LaunchArguments: { value: () => launchArguments } };
      }
      throw new Error(`Unexpected runtime import: ${name}`);
    },
  });
  return { runtime, fetch };
}

describe("E2E public build configuration", () => {
  it("bundles only public settings from a selected profile for manual launches", async () => {
    const settings = await buildPublicSettings(
      Object.entries({
        ...publicSettings,
        HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY: "private-provider-credential",
        HOT_UPDATER_ADMIN_TOKEN: "private-admin-token",
      })
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );
    expect(settings).toEqual(publicSettings);
    const { runtime, fetch } = loadRuntimeConfig(settings, {});
    await expect(runtime.resolveHotUpdaterBaseURL()).resolves.toBe(
      publicSettings.HOT_UPDATER_APP_BASE_URL,
    );
    expect(fetch).toHaveBeenCalledWith(
      publicSettings.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL,
    );
  });

  it("accepts CI settings without an env file and preserves shell precedence", async () => {
    expect(await buildPublicSettings(null, publicSettings)).toEqual(
      publicSettings,
    );
    expect(
      await buildPublicSettings(
        "HOT_UPDATER_APP_BASE_URL=https://file.example.com",
        {
          HOT_UPDATER_APP_BASE_URL: "https://shell.example.com",
        },
      ),
    ).toEqual({ HOT_UPDATER_APP_BASE_URL: "https://shell.example.com" });
  });

  it("uses launch arguments for a shard reusing an app built for another port", async () => {
    const { runtime, fetch } = loadRuntimeConfig(publicSettings, {
      HOT_UPDATER_APP_BASE_URL: "https://shard.example.com",
      HOT_UPDATER_E2E_RUNTIME_CONFIG_URL:
        "http://localhost:3229/e2e/runtime-config",
    });
    await expect(runtime.resolveHotUpdaterBaseURL()).resolves.toBe(
      "https://shard.example.com",
    );
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3229/e2e/runtime-config",
    );
  });

  it("uses local defaults when no public configuration is provided", async () => {
    const settings = await buildPublicSettings(null);
    expect(settings).toEqual({});
    const { runtime, fetch } = loadRuntimeConfig(settings, {
      HOT_UPDATER_APP_BASE_URL: "   ",
      HOT_UPDATER_E2E_RUNTIME_CONFIG_URL: 3219,
    });
    await expect(runtime.resolveHotUpdaterBaseURL()).resolves.toBe(
      "http://localhost:3007/hot-updater",
    );
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3107/e2e/runtime-config",
    );
  });
});
