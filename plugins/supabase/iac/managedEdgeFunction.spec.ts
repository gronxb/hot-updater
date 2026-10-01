import fs from "fs/promises";
import os from "os";
import path from "path";

import { InitError } from "@hot-updater/cli-tools";
import { definePlugin, defineTable } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { plugins } from "../src/plugins";
import { resolveEdgeFunctionDenoConfig } from "./index";
import {
  stageEdgeFunctionFromDefinition,
  writePluginMigration,
} from "./managedEdgeFunction";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");

/** A project's server definition, as init writes it, with a plugin of its own. */
const DEFINITION = `import { createHotUpdater } from "@hot-updater/server";
import { definePlugin, defineTable } from "@hot-updater/plugin-core";
import {
  plugins,
  supabaseDatabase,
  supabaseStorage,
} from "@hot-updater/supabase";

const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {
    notes: defineTable(
      { id: { type: "string" }, text: { type: "string" } },
      { key: ["id"] },
    ),
  },
  init: () => ({
    api: {},
    endpoints: [
      {
        method: "GET",
        path: "/notes/:id",
        access: "client",
        handler: async () => Response.json({ from: "sample notes plugin" }),
      },
    ],
  }),
});

export const hotUpdater = createHotUpdater({
  database: supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
  }),
  storage: [
    supabaseStorage({
      supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
      supabaseServiceRoleKey:
        process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
      bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
    }),
  ],
  plugins: [...plugins, notes],
});
`;

const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {
    notes: defineTable(
      { id: { type: "string" }, text: { type: "string" } },
      { key: ["id"] },
    ),
  },
  init: () => ({ api: {} }),
});

let project: string;

beforeEach(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-function-"));
  // The project's dependencies, such as the server its plugin is written against.
  await fs.symlink(
    path.join(packageRoot, "node_modules"),
    path.join(project, "node_modules"),
  );
  await fs.mkdir(path.join(project, "supabase", "migrations"), {
    recursive: true,
  });
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

const migrationIn = async (workdir: string) => {
  const [file] = await fs.readdir(path.join(workdir, "supabase", "migrations"));
  return {
    file,
    sql: await fs.readFile(
      path.join(workdir, "supabase", "migrations", file!),
      "utf-8",
    ),
  };
};

describe("the managed Edge Function from a project's server definition", () => {
  it("bundles the definition on the function's service role and bucket, with the project's plugin", async () => {
    const definition = path.join(project, "hotUpdater.ts");
    await fs.writeFile(definition, DEFINITION);
    const functionDir = path.join(project, "supabase", "functions", "fn");
    await fs.mkdir(functionDir, { recursive: true });

    await stageEdgeFunctionFromDefinition({
      bucketName: "bundles",
      definition,
      functionDir,
      functionName: "hot-updater-v1",
      packageRoot,
      projectRoot: project,
    });

    // The entry loads the bundle; the file that built it is gone.
    expect((await fs.readdir(functionDir)).sort()).toEqual([
      "hotUpdater.mjs",
      "index.ts",
    ]);
    await expect(
      fs.readFile(path.join(functionDir, "index.ts"), "utf-8"),
    ).resolves.toBe('import "./hotUpdater.mjs";\n');
    const code = await fs.readFile(
      path.join(functionDir, "hotUpdater.mjs"),
      "utf-8",
    );
    // A CommonJS dependency can require a built-in, and the definition can
    // read process.env, which the Edge Runtime may lack.
    expect(
      code.startsWith(
        'import { createRequire as __hotUpdaterCreateRequire } from "node:module";',
      ),
    ).toBe(true);
    expect(code).toContain("globalThis.process ??= { env: {} };");
    expect(code).toContain("sample notes plugin");
    // What init set up is in the code; the function's name is its base path.
    expect(code).toContain('"bundles"');
    expect(code).toContain('"hot-updater-v1"');
    expect(code).not.toContain("HotUpdater.BUCKET_NAME");
    // The function's import map vendors the server it runs on.
    expect(code).toMatch(/from\s*"@hot-updater\/server"/u);
    expect(code).toMatch(/from\s*"@hot-updater\/plugin-core"/u);
    expect(code).toMatch(/from\s*"@supabase\/supabase-js"/u);
    // None of the machine's paths are deployed: not the project's, the
    // repository's its packages come from, or the home directory, not even
    // in a module's name, which esbuild writes from the project.
    for (const local of [
      project,
      await fs.realpath(project),
      repositoryRoot,
      await fs.realpath(repositoryRoot),
      os.homedir(),
    ]) {
      expect(code).not.toContain(local);
    }

    // The import map vendors what the bundle leaves to the function's
    // server, such as the plugin API the project's plugin is written with,
    // from the packages the function's server depends on.
    const { imports } = await resolveEdgeFunctionDenoConfig(functionDir);
    expect(imports["@hot-updater/plugin-core"]).toMatch(
      /^\.\/.*plugin-core.*\.m?js$/u,
    );
    await expect(
      fs.access(path.join(functionDir, imports["@hot-updater/plugin-core"]!)),
    ).resolves.toBeUndefined();
  });

  it("offers the definition every export of @hot-updater/supabase", async () => {
    const names = Object.keys(await import("@hot-updater/supabase")).sort();
    const definition = path.join(project, "hotUpdater.ts");
    await fs.writeFile(
      definition,
      `import { ${names.join(", ")} } from "@hot-updater/supabase";
import { createHotUpdater } from "@hot-updater/server";

export const imported = [${names.join(", ")}];
export default createHotUpdater({
  database: supabaseDatabase({ supabaseUrl: "the CLI's" }),
  storage: [supabaseStorage({ supabaseUrl: "the CLI's", bucketName: "the CLI's" })],
  plugins,
});
`,
    );
    const functionDir = path.join(project, "supabase", "functions", "fn");
    await fs.mkdir(functionDir, { recursive: true });

    await stageEdgeFunctionFromDefinition({
      bucketName: "bundles",
      definition,
      functionDir,
      functionName: "hot-updater-v1",
      packageRoot,
      projectRoot: project,
    });

    expect(names).toEqual(
      expect.arrayContaining([
        "plugins",
        "supabaseDatabase",
        "supabaseStorage",
      ]),
    );
  });

  it("names the definition when it cannot be bundled", async () => {
    const definition = path.join(project, "hotUpdater.ts");
    await fs.writeFile(
      definition,
      `import { notes } from "@acme/missing-plugin";\nexport const hotUpdater = notes;\n`,
    );
    const functionDir = path.join(project, "supabase", "functions", "fn");
    await fs.mkdir(functionDir, { recursive: true });

    const failure = stageEdgeFunctionFromDefinition({
      bucketName: "bundles",
      definition,
      functionDir,
      functionName: "hot-updater-v1",
      packageRoot,
      projectRoot: project,
    });
    await expect(failure).rejects.toBeInstanceOf(InitError);
    await expect(failure).rejects.toThrow(
      /^Could not bundle hotUpdater\.ts into the Supabase Edge Function: .*Could not resolve "@acme\/missing-plugin"/su,
    );
  });

  it("migrates the plugins' tables and settings rows after the package's migration", async () => {
    await writePluginMigration(project, [...plugins, notes]);

    const { file, sql } = await migrationIn(project);
    expect(file).toMatch(/^\d{14}_hot-updater\.sql$/u);
    expect(sql).toContain("notes_notes");
    expect(sql).toContain("'schema.notes'");
    expect(sql).toContain("'schema.insights'");
  });

  it("migrates only the plugins the server runs", async () => {
    await writePluginMigration(project, [notes]);

    const { sql } = await migrationIn(project);
    expect(sql).toContain("'schema.notes'");
    expect(sql).not.toContain("'schema.insights'");
    expect(sql).not.toContain("'schema.apiKeys'");
  });
});
