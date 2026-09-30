import fs from "fs/promises";
import os from "os";
import path from "path";

import { InitError } from "@hot-updater/cli-tools";
import { definePlugin, defineTable } from "@hot-updater/server/plugins";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { plugins } from "../src/plugins";
import {
  buildWorkerFromDefinition,
  writePluginMigration,
} from "./managedWorker";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");

/** A project's server definition, as init writes it, with a plugin of its own. */
const DEFINITION = `import { d1Database, plugins, r2Storage } from "@hot-updater/cloudflare";
import { createHotUpdater } from "@hot-updater/server";
import { definePlugin, defineTable } from "@hot-updater/server/plugins";

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
  database: d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  }),
  storage: [
    r2Storage({
      bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
      accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
      credentials: {
        accessKeyId: process.env.HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY!,
      },
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
  project = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-worker-"));
  // The project's dependencies, such as the server its plugin is written against.
  await fs.symlink(
    path.join(packageRoot, "node_modules"),
    path.join(project, "node_modules"),
  );
  await fs.mkdir(path.join(project, ".hot-updater", "worker", "migrations"), {
    recursive: true,
  });
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

describe("the managed Worker from a project's server definition", () => {
  it("bundles the definition on the Worker's bindings, with the project's plugin", async () => {
    const definition = path.join(project, "hotUpdater.ts");
    await fs.writeFile(definition, DEFINITION);
    const workerRoot = path.join(project, ".hot-updater", "worker");

    await expect(
      buildWorkerFromDefinition({
        definition,
        packageRoot,
        projectRoot: project,
        workerRoot,
      }),
    ).resolves.toBe("./dist/managed.js");

    const code = await fs.readFile(
      path.join(workerRoot, "dist", "managed.js"),
      "utf-8",
    );
    expect(code).toContain("sample notes plugin");
    expect(code).toMatch(/from\s*"cloudflare:workers"/u);
    // A CommonJS dependency can require a built-in on workerd.
    expect(
      code.startsWith(
        'import { createRequire as __hotUpdaterCreateRequire } from "node:module";',
      ),
    ).toBe(true);
    // The CLI's clients for D1's REST API and R2's S3 API stay out.
    expect(code).not.toContain("api.cloudflare.com");
    expect(code).not.toContain("S3Client");
    // None of the machine's paths are deployed, and the entry that built it
    // is gone.
    for (const local of [
      project,
      await fs.realpath(project),
      repositoryRoot,
      await fs.realpath(repositoryRoot),
      os.homedir(),
    ]) {
      expect(code).not.toContain(local);
    }
    await expect(
      fs.access(path.join(workerRoot, "managed.ts")),
    ).rejects.toThrow();
  });

  it("offers the definition every export of @hot-updater/cloudflare", async () => {
    const names = Object.keys(await import("@hot-updater/cloudflare")).sort();
    const definition = path.join(project, "hotUpdater.ts");
    await fs.writeFile(
      definition,
      `import { ${names.join(", ")} } from "@hot-updater/cloudflare";
import { createHotUpdater } from "@hot-updater/server";

export const imported = [${names.join(", ")}];
export default createHotUpdater({
  database: d1Database({ databaseId: "the CLI's" }),
  storage: [r2Storage({ bucketName: "the CLI's" })],
  plugins,
});
`,
    );
    const workerRoot = path.join(project, ".hot-updater", "worker");

    await buildWorkerFromDefinition({
      definition,
      packageRoot,
      projectRoot: project,
      workerRoot,
    });

    // d1Migration is internal: the runtime module has no D1 REST client.
    expect(names).not.toContain("d1Migration");
    expect(names).toEqual(
      expect.arrayContaining(["d1Database", "plugins", "r2Storage"]),
    );
  });

  it("names the definition when it cannot be bundled", async () => {
    const definition = path.join(project, "hotUpdater.ts");
    await fs.writeFile(
      definition,
      `import { notes } from "@acme/missing-plugin";\nexport const hotUpdater = notes;\n`,
    );

    const failure = buildWorkerFromDefinition({
      definition,
      packageRoot,
      projectRoot: project,
      workerRoot: path.join(project, ".hot-updater", "worker"),
    });
    await expect(failure).rejects.toBeInstanceOf(InitError);
    await expect(failure).rejects.toThrow(
      /^Could not bundle hotUpdater\.ts into the Cloudflare Worker: .*Could not resolve "@acme\/missing-plugin"/su,
    );
  });

  it("migrates the plugins' tables and settings rows after the package's migration", async () => {
    const workerRoot = path.join(project, ".hot-updater", "worker");

    await writePluginMigration(workerRoot, [...plugins, notes]);

    const [file] = await fs.readdir(path.join(workerRoot, "migrations"));
    expect(file).toMatch(/^\d{14}_hot-updater\.sql$/u);
    const sql = await fs.readFile(
      path.join(workerRoot, "migrations", file!),
      "utf-8",
    );
    expect(sql).toContain('"notes_notes"');
    expect(sql).toContain("'schema.notes'");
    expect(sql).toContain("'schema.insights'");
  });

  it("migrates only the plugins the server runs", async () => {
    const workerRoot = path.join(project, ".hot-updater", "worker");

    await writePluginMigration(workerRoot, [notes]);

    const [file] = await fs.readdir(path.join(workerRoot, "migrations"));
    const sql = await fs.readFile(
      path.join(workerRoot, "migrations", file!),
      "utf-8",
    );
    expect(sql).toContain("'schema.notes'");
    expect(sql).not.toContain("'schema.insights'");
    expect(sql).not.toContain("'schema.apiKeys'");
  });
});
