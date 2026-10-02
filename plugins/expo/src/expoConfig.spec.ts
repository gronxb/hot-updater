import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function runWithExpo(
  manifest: Record<string, unknown>,
  files: Record<string, string>,
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "expo-config-resolution-"));
  tempDirs.push(cwd);
  const expoDir = path.join(cwd, "node_modules/expo");
  await mkdir(expoDir, { recursive: true });
  await writeFile(
    path.join(expoDir, "package.json"),
    JSON.stringify({ name: "expo", ...manifest }),
  );
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(expoDir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const source = await readFile(
    new URL("./expoConfig.ts", import.meta.url),
    "utf8",
  );
  await writeFile(path.join(cwd, "loader.mts"), source);
  // Use Node's resolver, since Vitest's resolver accepts paths that Node rejects.
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { getConfig } from "./loader.mts"; console.log(JSON.stringify(await getConfig("project", { skipSDKVersionRequirement: true })));',
    ],
    { cwd, encoding: "utf8" },
  );
}

const configModule =
  "exports.getConfig = (cwd, options) => ({ cwd, options });";
const expo58Exports = {
  "./config": { default: "./config/index.js" },
  "./*": "./*.js",
};

describe("Expo config resolution in Node", () => {
  it.each([
    ["legacy config.js", {}, { "config.js": configModule }],
    ["legacy config directory", {}, { "config/index.js": configModule }],
    [
      "Expo 58 public exports",
      { exports: expo58Exports },
      { "config/index.js": configModule },
    ],
    [
      "ES module config",
      { type: "module", exports: expo58Exports },
      {
        "config/index.js":
          "export const getConfig = (cwd, options) => ({ cwd, options });",
      },
    ],
  ])("loads %s", async (_name, manifest, files) => {
    const result = await runWithExpo(manifest, files);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      cwd: "project",
      options: { skipSDKVersionRequirement: true },
    });
  });

  it("preserves a missing dependency error inside the public config module", async () => {
    const result = await runWithExpo(
      { type: "module", exports: expo58Exports },
      { "config/index.js": 'import "./missing-dependency.js";' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing-dependency.js");
    expect(result.stderr).not.toContain("index.js.js");
  });

  it("preserves config evaluation errors", async () => {
    const result = await runWithExpo(
      { exports: expo58Exports },
      { "config/index.js": 'throw new Error("config evaluation failed");' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("config evaluation failed");
  });
});
