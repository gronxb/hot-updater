import fs from "fs";
import os from "os";
import path from "path";

import type { BasePluginArgs, BuildPlugin } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execa: vi.fn(),
}));

vi.mock("execa", () => ({
  execa: mocks.execa,
}));

import { withBugsnag } from "./withBugsnag";

const BUNDLE_ID = "0195c1a6-9b3e-7000-8000-000000000000";

describe("withBugsnag", () => {
  let buildPath: string;

  const createBuildFn =
    () =>
    (_: BasePluginArgs): BuildPlugin => ({
      build: async () => ({
        buildPath,
        bundleId: BUNDLE_ID,
        stdout: null,
      }),
      name: "test-build",
    });

  const runBuild = async (
    config: Parameters<typeof withBugsnag>[1],
    platform: "ios" | "android" = "ios",
  ) => {
    const plugin = withBugsnag(createBuildFn(), config)({ cwd: "/app" });
    return plugin.build({ platform });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.execa.mockResolvedValue({});
    buildPath = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-bugsnag-test-"),
    );
  });

  afterEach(async () => {
    await fs.promises.rm(buildPath, { recursive: true, force: true });
  });

  const writeFiles = async (files: string[]) => {
    await Promise.all(
      files.map((file) =>
        fs.promises.writeFile(path.join(buildPath, file), ""),
      ),
    );
  };

  it("uploads the plain javascript bundle and sourcemap", async () => {
    await writeFiles(["index.ios.bundle", "index.ios.bundle.map"]);

    const result = await runBuild({ apiKey: "api-key" });

    expect(result.bundleId).toBe(BUNDLE_ID);
    expect(mocks.execa).toHaveBeenCalledWith("npx", [
      "bugsnag-cli",
      "upload",
      "react-native-sourcemaps",
      "--api-key",
      "api-key",
      "--platform",
      "ios",
      "--bundle",
      path.join(buildPath, "index.ios.bundle"),
      "--source-map",
      path.join(buildPath, "index.ios.bundle.map"),
      "--code-bundle-id",
      BUNDLE_ID,
      "--project-root",
      "/app",
    ]);
  });

  it("prefers the hermes bundle and sourcemap when present", async () => {
    await writeFiles([
      "index.android.bundle",
      "index.android.bundle.map",
      "index.android.bundle.hbc",
      "index.android.bundle.hbc.map",
    ]);

    await runBuild({ apiKey: "api-key" }, "android");

    const args = mocks.execa.mock.calls[0]?.[1] as string[];
    expect(args[args.indexOf("--bundle") + 1]).toBe(
      path.join(buildPath, "index.android.bundle.hbc"),
    );
    expect(args[args.indexOf("--source-map") + 1]).toBe(
      path.join(buildPath, "index.android.bundle.hbc.map"),
    );
    expect(args[args.indexOf("--platform") + 1]).toBe("android");
  });

  it("passes codeBundleId, projectRoot and overwrite from config", async () => {
    await writeFiles(["index.ios.bundle", "index.ios.bundle.map"]);

    await runBuild({
      apiKey: "api-key",
      codeBundleId: "custom-code-bundle-id",
      overwrite: true,
      projectRoot: "/custom/root",
    });

    const args = mocks.execa.mock.calls[0]?.[1] as string[];
    expect(args[args.indexOf("--code-bundle-id") + 1]).toBe(
      "custom-code-bundle-id",
    );
    expect(args[args.indexOf("--project-root") + 1]).toBe("/custom/root");
    expect(args).toContain("--overwrite");
  });

  it("throws when the sourcemap is missing", async () => {
    await writeFiles(["index.ios.bundle"]);

    await expect(runBuild({ apiKey: "api-key" })).rejects.toThrow(
      "Sourcemap or original bundle not found",
    );
    expect(mocks.execa).not.toHaveBeenCalled();
  });

  it("throws when the hermes bundle exists without its sourcemap", async () => {
    await writeFiles([
      "index.ios.bundle",
      "index.ios.bundle.map",
      "index.ios.bundle.hbc",
    ]);

    await expect(runBuild({ apiKey: "api-key" })).rejects.toThrow(
      "Hermes bundle or sourcemap not found",
    );
    expect(mocks.execa).not.toHaveBeenCalled();
  });
});
