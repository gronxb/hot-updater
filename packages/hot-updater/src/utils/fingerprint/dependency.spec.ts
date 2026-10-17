import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createMissingFingerprintDependencyError,
  isMissingExpoFingerprintError,
} from "./dependency";

describe("loadExpoFingerprint", () => {
  afterEach(() => {
    delete process.env["npm_config_user_agent"];
  });

  it("creates install guidance for the missing optional peer", () => {
    process.env["npm_config_user_agent"] = "pnpm/10.33.0";

    const error = createMissingFingerprintDependencyError();

    expect(error.message).toContain(
      "@expo/fingerprint is required for fingerprint commands but is not installed.",
    );
    expect(error.message).toContain(
      "pnpm add -D --save-exact @expo/fingerprint",
    );
  });

  it("detects missing @expo/fingerprint module errors", () => {
    const error = Object.assign(
      new Error("Cannot find package '@expo/fingerprint'"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );

    expect(isMissingExpoFingerprintError(error)).toBe(true);
    expect(isMissingExpoFingerprintError(new Error("boom"))).toBe(false);
  });
});

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function runWithFingerprint(
  source?: string,
  type = "commonjs",
  expression = 'JSON.stringify((await loadExpoFingerprint("./project")).SourceSkips)',
  { expoSdkFingerprint }: { expoSdkFingerprint?: string } = {},
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "fingerprint-resolution-"),
  );
  tempDirs.push(root);
  const adapterDir = path.join(root, "adapter");
  const projectDir = path.join(root, "project");
  await fs.mkdir(adapterDir);
  await fs.mkdir(projectDir);
  for (const [dir, contents] of [
    [adapterDir, 'exports.SourceSkips = { ExpoConfigAll: "adapter" };'],
    [projectDir, source],
  ]) {
    if (contents === undefined) continue;
    const packageDir = path.join(dir!, "node_modules/@expo/fingerprint");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "@expo/fingerprint",
        version: dir === projectDir ? "0.20.14" : "0.21.5",
        main: "index.js",
        type: dir === projectDir ? type : "commonjs",
      }),
    );
    await fs.writeFile(path.join(packageDir, "index.js"), contents);
  }
  if (expoSdkFingerprint) {
    const expoDir = path.join(projectDir, "node_modules/expo");
    const sdkCopy = path.join(expoDir, "node_modules/@expo/fingerprint");
    await fs.mkdir(sdkCopy, { recursive: true });
    await fs.writeFile(
      path.join(expoDir, "package.json"),
      JSON.stringify({ name: "expo", version: "52.0.0" }),
    );
    await fs.writeFile(
      path.join(sdkCopy, "package.json"),
      JSON.stringify({
        name: "@expo/fingerprint",
        version: expoSdkFingerprint,
        main: "index.js",
      }),
    );
    await fs.writeFile(
      path.join(sdkCopy, "index.js"),
      "exports.SourceSkips = {};",
    );
  }
  const loader = await fs.readFile(
    new URL("./dependency.ts", import.meta.url),
    "utf8",
  );
  await fs.writeFile(
    path.join(adapterDir, "loader.mts"),
    loader.replace('"../getPackageManager"', '"./getPackageManager.mts"'),
  );
  await fs.copyFile(
    new URL("../getPackageManager.ts", import.meta.url),
    path.join(adapterDir, "getPackageManager.mts"),
  );
  // Keep pnpm's test-runner NODE_PATH out of the app's resolution.
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { getExpoFingerprintEngine, loadExpoFingerprint } from "./adapter/loader.mts"; console.log(${expression});`,
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } },
  );
}

describe("project-scoped fingerprint loader", () => {
  it("loads the project's fingerprint package instead of the CLI's copy", async () => {
    const result = await runWithFingerprint(
      'exports.SourceSkips = { ExpoConfigAll: "project" };',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ExpoConfigAll: "project" });
  });

  it("preserves async ESM loading after resolving the public entry", async () => {
    const result = await runWithFingerprint(
      'await Promise.resolve(); export const SourceSkips = { ExpoConfigAll: "project" };',
      "module",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ExpoConfigAll: "project" });
  });

  it("records the version of the project's fingerprint package as the engine", async () => {
    const result = await runWithFingerprint(
      'exports.SourceSkips = { ExpoConfigAll: "project" };',
      "commonjs",
      'JSON.stringify(await getExpoFingerprintEngine("./project"))',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toBe("@expo/fingerprint@0.20.14");
  });

  it("prefers the fingerprint package the project's Expo SDK pins", async () => {
    const result = await runWithFingerprint(
      'exports.SourceSkips = { ExpoConfigAll: "project" };',
      "commonjs",
      'JSON.stringify(await getExpoFingerprintEngine("./project"))',
      { expoSdkFingerprint: "0.11.11" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toBe("@expo/fingerprint@0.11.11");
  });

  it("reports a missing project package even when the CLI has its own copy", async () => {
    const result = await runWithFingerprint();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("@expo/fingerprint is required");
  });

  it("preserves a missing transitive dependency error", async () => {
    const result = await runWithFingerprint(
      'require("./missing-internal.js");',
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing-internal.js");
    expect(result.stderr).not.toContain("@expo/fingerprint is required");
  });
});
