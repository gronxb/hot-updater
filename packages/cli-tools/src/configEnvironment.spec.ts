import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { transformSync } from "oxc-transform";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  createHotUpdaterConfigScaffold,
  writeHotUpdaterConfig,
} from "./hotUpdaterConfig";

const createProject = async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "hot-updater-native-env-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  for (const [name, exports] of Object.entries({
    "hot-updater": ["defineConfig"],
    "@hot-updater/bare": ["bare"],
    "@hot-updater/supabase": ["supabaseStorage", "supabaseDatabase"],
  })) {
    const directory = path.join(cwd, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        type: "module",
        exports: "./index.js",
      }),
    );
    await writeFile(
      path.join(directory, "index.js"),
      exports
        .map((name) => `export const ${name} = (options) => options;`)
        .join("\n"),
    );
  }
  const scaffold = createHotUpdaterConfigScaffold({
    build: "bare",
    storage: {
      imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseStorage"] }],
      configString:
        "supabaseStorage({ token: process.env.HOT_UPDATER_TEST_ENV_TOKEN })",
    },
    database: {
      imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseDatabase"] }],
      configString: "supabaseDatabase({})",
    },
  });
  const configPath = path.join(cwd, "hot-updater.config.ts");
  const run = async (token?: string) => {
    const source = await readFile(configPath, "utf-8");
    const { code, errors } = transformSync(configPath, source);
    expect(errors).toEqual([]);
    await writeFile(path.join(cwd, "config.mjs"), code);
    const env = { ...process.env };
    delete env.HOT_UPDATER_TEST_ENV_TOKEN;
    if (token !== undefined) env.HOT_UPDATER_TEST_ENV_TOKEN = token;
    return execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import config from "./config.mjs"; console.log(config.storage.token);',
      ],
      { cwd, env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  };
  return { cwd, scaffold, configPath, run };
};

describe("config environment loading", () => {
  it.each([
    { file: true, token: undefined, expected: "from-file" },
    { file: true, token: "from-ci", expected: "from-ci" },
    { file: true, token: "", expected: "" },
    { file: false, token: "from-ci", expected: "from-ci" },
  ])(
    "runs without dotenv: $file, $token",
    async ({ file, token, expected }) => {
      const project = await createProject();
      if (file)
        await writeFile(
          path.join(project.cwd, ".env.hotupdater"),
          "HOT_UPDATER_TEST_ENV_TOKEN=from-file\n",
        );
      await writeHotUpdaterConfig(project.scaffold, project.configPath);
      expect(await project.run(token)).toBe(expected);
      await writeHotUpdaterConfig(project.scaffold, project.configPath);
      expect(await project.run(token)).toBe(expected);
    },
  );

  it("does not hide env-file read errors", async () => {
    const project = await createProject();
    await mkdir(path.join(project.cwd, ".env.hotupdater"));
    await writeHotUpdaterConfig(project.scaffold, project.configPath);
    await expect(project.run()).rejects.toThrow(/EISDIR|ERR_INVALID_ARG_TYPE/);
  });

  it.each([
    "process.loadEnvFile(envPath);",
    'if (true) { process.loadEnvFile("custom.env"); }',
    'loadEnvFile("custom.env");',
    "",
  ])(
    "preserves existing environment setup on repeated init: %s",
    async (setup) => {
      const project = await createProject();
      await writeFile(
        path.join(project.cwd, ".env.hotupdater"),
        "HOT_UPDATER_TEST_ENV_TOKEN=wrong-file\n",
      );
      await writeFile(
        path.join(project.cwd, "custom.env"),
        "HOT_UPDATER_TEST_ENV_TOKEN=custom\n",
      );
      await writeFile(
        project.configPath,
        `import { loadEnvFile } from "node:process";
import { bare } from "@hot-updater/bare";
import { supabaseStorage, supabaseDatabase } from "@hot-updater/supabase";
import { defineConfig } from "hot-updater";
const envPath = "custom.env";
${setup}
export default defineConfig({
  build: bare({}),
  storage: supabaseStorage({ token: process.env.HOT_UPDATER_TEST_ENV_TOKEN }),
  database: supabaseDatabase({}),
});`,
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(
          (await writeHotUpdaterConfig(project.scaffold, project.configPath))
            .status,
        ).toBe("merged");
        expect(await project.run()).toBe(setup ? "custom" : "undefined");
      }
    },
  );

  it("preserves legacy dotenv imports, custom paths, options and statement order", async () => {
    const project = await createProject();
    const setup = `const envPath = "custom.env";
config({ path: envPath, override: true });`;
    await writeFile(
      project.configPath,
      `import { config } from "dotenv";
import { bare } from "@hot-updater/bare";
import { supabaseStorage, supabaseDatabase } from "@hot-updater/supabase";
import { defineConfig } from "hot-updater";
${setup}
export default defineConfig({
  build: bare({}),
  storage: supabaseStorage({}),
  database: supabaseDatabase({}),
});`,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await writeHotUpdaterConfig(project.scaffold, project.configPath);
      const updated = await readFile(project.configPath, "utf-8");
      expect(updated).toContain('import { config } from "dotenv";');
      expect(updated).toContain("config({ path: envPath, override: true });");
      expect(updated.indexOf("const envPath")).toBeLessThan(
        updated.indexOf("config({"),
      );
      expect(updated).not.toContain("process.loadEnvFile");
      expect(updated.match(/config\(\{/g)).toHaveLength(1);
    }
  });
});
