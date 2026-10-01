import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  loadManagedServerDefinition,
  managedServerDefinitionOf,
} from "@hot-updater/cli-tools";
import { createHotUpdater } from "@hot-updater/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";

import { plugins } from "../src/plugins";
import { d1Database } from "../src/worker/d1Database";
import { getConfigScaffold } from "./configTemplate";
import {
  buildWorkerFromDefinition,
  prepareWorkerDeployment,
} from "./managedWorker";

/*
 * The managed Worker as init deploys it: the project's server definition
 * bundled into the staged Worker, whose migrations Wrangler applies to D1
 * and which workerd runs with its bindings, as `wrangler dev` runs it. The
 * database starts as rc.20's init left it, so each deploy is an upgrade.
 */

const packageRoot = path.resolve(import.meta.dirname, "..");
const wranglerBin = path.join(packageRoot, "node_modules", ".bin", "wrangler");
const DATABASE_ID = "11111111-1111-4111-8111-111111111111";
const DATABASE_NAME = "hot-updater-db";
const BUCKET_NAME = "bundles";
const BUNDLE_ID = "00000000-0000-0000-0000-000000000001";

/** A plugin of the project's own, with a table, which the app reads and writes. */
const NOTES_PLUGIN = `import { definePlugin, defineTable } from "@hot-updater/plugin-core";
import { digest } from "cjs-digest";

export const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {
    notes: defineTable(
      { id: { type: "string", maxLength: 64 }, text: { type: "string" } },
      { key: ["id"] },
    ),
  },
  init: ({ db }) => ({
    api: {},
    endpoints: [
      {
        method: "POST",
        path: "/notes/:id",
        access: "client",
        handler: async (request, params) => {
          const { text } = (await request.json()) as { text: string };
          await db.transaction(async (tx) => {
            tx.create("notes", { id: params.id!, text });
          });
          return new Response(null, { status: 201 });
        },
      },
      {
        method: "GET",
        path: "/notes/:id",
        access: "client",
        handler: async (_request, params) => {
          const note = await db.findOne("notes", { id: params.id! });
          return note === null
            ? Response.json({ error: "Not found" }, { status: 404 })
            : Response.json({ text: note.text, digest: digest(note.text) });
        },
      },
    ],
  }),
});
`;

/** The definition init writes, with the project's plugin, running `serverPlugins`. */
const definition = (serverPlugins: string) => {
  const text = getConfigScaffold("bare")
    .definition.text.replace(
      'import { createHotUpdater } from "@hot-updater/server";',
      'import { createHotUpdater } from "@hot-updater/server";\n\nimport { notes } from "./notes";',
    )
    .replace("  plugins,\n", `  plugins: ${serverPlugins},\n`);
  expect(text).toContain(`plugins: ${serverPlugins},`);
  return text;
};

/** What init leaves in .env.hotupdater, which the definition reads. */
const ENV_FILE = `HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID=account-id
HOT_UPDATER_CLOUDFLARE_API_TOKEN=api-token
HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID=${DATABASE_ID}
HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME=${BUCKET_NAME}
HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID=access-key-id
HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY=secret-access-key
`;

const openPort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const wranglerEnv = () => ({
  ...process.env,
  CI: "1",
  NO_COLOR: "1",
  WRANGLER_SEND_METRICS: "false",
});

const wrangler = (cwd: string, args: readonly string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(wranglerBin, args, {
      cwd,
      env: wranglerEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logs: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `wrangler ${args.join(" ")} exited ${code}:\n${logs.join("")}`,
            ),
          ),
    );
  });

let root: string;
let project: string;
let state: string;
let running: ChildProcess | undefined;

/** Applies the Worker's migrations to the local D1 as init applies them to the remote one. */
const migrate = (workerRoot: string) =>
  wrangler(workerRoot, [
    "d1",
    "migrations",
    "apply",
    DATABASE_NAME,
    "--local",
    "--persist-to",
    state,
  ]);

/** The Worker's D1 database, outside the Worker. */
const withDatabase = async <T>(
  workerRoot: string,
  use: (db: D1Database) => Promise<T>,
) => {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: path.join(workerRoot, "wrangler.json"),
    persist: { path: path.join(state, "v3") },
  });
  try {
    return await use(proxy.env.DB);
  } finally {
    await proxy.dispose();
  }
};

/** A copy of the package's Worker, as init stages it. */
const stageWorker = async (name: string) => {
  const workerRoot = path.join(root, name, "worker");
  await fs.cp(path.join(packageRoot, "worker"), workerRoot, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.wrangler`),
  });
  return workerRoot;
};

/**
 * Stages, migrates, and serves the Worker init deploys for the project's
 * definition with `serverPlugins`, whose plugins it reads as init does.
 */
const deploy = async (name: string, serverPlugins: string) => {
  const definitionPath = path.join(project, "hotUpdater.ts");
  await fs.writeFile(definitionPath, definition(serverPlugins));
  const loaded = await loadManagedServerDefinition(
    { path: definitionPath, edited: true },
    (hotUpdater) =>
      managedServerDefinitionOf(hotUpdater, {
        provider: "Cloudflare",
        database: "d1Database",
        storage: "r2",
        resources: {
          database: { accountId: "account-id", databaseId: DATABASE_ID },
          storage: { accountId: "account-id", bucketName: BUCKET_NAME },
        },
      }).plugins,
    { cwd: project },
  );
  const workerRoot = await stageWorker(name);
  const main = await buildWorkerFromDefinition({
    definition: definitionPath,
    packageRoot,
    projectRoot: project,
    workerRoot,
  });
  await prepareWorkerDeployment(workerRoot, {
    d1DatabaseId: DATABASE_ID,
    d1DatabaseName: DATABASE_NAME,
    main,
    plugins: loaded,
    r2BucketName: BUCKET_NAME,
  });
  await migrate(workerRoot);
  return { workerRoot, url: await serve(workerRoot) };
};

/** The script `wrangler deploy` uploads for the staged Worker. */
const uploadedScript = async (workerRoot: string) => {
  const outdir = path.join(workerRoot, "..", "upload");
  await wrangler(workerRoot, ["deploy", "--dry-run", "--outdir", outdir]);
  const scripts = (await fs.readdir(outdir)).filter((file) =>
    /\.m?js$/u.test(file),
  );
  return (
    await Promise.all(
      scripts.map((file) => fs.readFile(path.join(outdir, file), "utf-8")),
    )
  ).join("\n");
};

/**
 * The compatibility date workerd runs the Worker on: the one init deploys
 * it with, or the newest this machine's workerd supports, when it is older
 * than Cloudflare's.
 */
const localCompatibilityDate = async (workerRoot: string) => {
  const { compatibility_date: deployed } = JSON.parse(
    await fs.readFile(path.join(workerRoot, "wrangler.json"), "utf-8"),
  ) as { compatibility_date: string };
  const { supportedCompatibilityDate } = createRequire(
    createRequire(import.meta.url).resolve("wrangler/package.json"),
  )("miniflare") as { supportedCompatibilityDate: string };
  return deployed < supportedCompatibilityDate
    ? deployed
    : supportedCompatibilityDate;
};

const serve = async (workerRoot: string) => {
  const port = await openPort();
  const child = spawn(
    wranglerBin,
    [
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      state,
      "--compatibility-date",
      await localCompatibilityDate(workerRoot),
      "--var",
      "STORAGE_DOWNLOAD_URL_SIGNING_KEY:test-signing-key",
      "--log-level",
      "error",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: workerRoot,
      detached: true,
      env: wranglerEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  running = child;
  const logs: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  const url = `http://127.0.0.1:${port}`;
  for (
    let attempt = 0;
    attempt < 120 && child.exitCode === null;
    attempt += 1
  ) {
    const ready = await fetch(`${url}/version`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return url;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`wrangler dev never served /version:\n${logs.join("")}`);
};

const stop = async () => {
  const child = running;
  running = undefined;
  if (child?.pid === undefined || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  process.kill(-child.pid, "SIGTERM");
  await exited;
};

const countRows = (db: D1Database, table: string) =>
  db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<number>("n");

const appliedMigrations = async (db: D1Database) =>
  (
    await db
      .prepare(`SELECT "name" FROM "d1_migrations" ORDER BY "id"`)
      .all<{ name: string }>()
  ).results.map(({ name }) => name);

let apiKey = "";
let seededEvents = 0;

describe.sequential("the managed Worker init deploys", () => {
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-worker-"));
    state = path.join(root, "state");
    project = path.join(root, "project");

    // The project: its plugin, a CommonJS dependency that requires a Node.js
    // built-in, and the packages its definition imports.
    await fs.mkdir(path.join(project, "node_modules", "@hot-updater"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(project, "package.json"),
      JSON.stringify({ name: "app", type: "module" }),
    );
    await fs.writeFile(path.join(project, ".env.hotupdater"), ENV_FILE);
    await fs.writeFile(path.join(project, "notes.ts"), NOTES_PLUGIN);
    await fs.mkdir(path.join(project, "node_modules", "cjs-digest"));
    await fs.writeFile(
      path.join(project, "node_modules", "cjs-digest", "package.json"),
      JSON.stringify({ name: "cjs-digest", main: "index.js" }),
    );
    await fs.writeFile(
      path.join(project, "node_modules", "cjs-digest", "index.js"),
      `const crypto = require("node:crypto");
exports.digest = (text) => crypto.createHash("sha256").update(text).digest("hex");
`,
    );
    await fs.symlink(
      packageRoot,
      path.join(project, "node_modules", "@hot-updater", "cloudflare"),
    );
    await fs.symlink(
      path.join(packageRoot, "node_modules", "@hot-updater", "server"),
      path.join(project, "node_modules", "@hot-updater", "server"),
    );
    await fs.symlink(
      path.join(packageRoot, "node_modules", "@hot-updater", "plugin-core"),
      path.join(project, "node_modules", "@hot-updater", "plugin-core"),
    );

    // The database as rc.20's init left it: its migration, an app's API
    // key, a release, and an installation's Insights.
    const rc20 = path.join(root, "rc.20");
    await fs.mkdir(path.join(rc20, "migrations"), { recursive: true });
    await fs.copyFile(
      path.join(
        import.meta.dirname,
        "__fixtures__",
        "rc.20",
        "0001_hot-updater_1.0.0.sql",
      ),
      path.join(rc20, "migrations", "0001_hot-updater_1.0.0.sql"),
    );
    await fs.writeFile(
      path.join(rc20, "wrangler.json"),
      JSON.stringify({
        name: "hot-updater",
        compatibility_date: "2026-08-13",
        d1_databases: [
          {
            binding: "DB",
            database_id: DATABASE_ID,
            database_name: DATABASE_NAME,
          },
        ],
      }),
    );
    await migrate(rc20);
    ({ apiKey, seededEvents } = await withDatabase(rc20, async (db) => {
      const hotUpdater = createHotUpdater({
        database: d1Database(db),
        plugins,
      });
      const { apiKey } = await hotUpdater.api.apiKeys.create({
        name: "rc.20 app",
      });
      await hotUpdater.core.deploy([
        {
          bundle: {
            id: BUNDLE_ID,
            platform: "ios",
            gitCommitHash: null,
            manifestStorageUri: `r2://${BUCKET_NAME}/${BUNDLE_ID}/manifest.json`,
            manifestFileHash: "manifest-hash",
            assetBaseStorageUri: `r2://${BUCKET_NAME}/assets`,
          },
          release: {
            channel: "production",
            enabled: true,
            fingerprintHash: null,
            message: "rc.20",
            shouldForceUpdate: false,
            targetAppVersion: "1.0",
          },
        },
      ]);
      const reported = await hotUpdater.handlers.client(
        new Request("https://worker.example.com/events", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey },
          body: JSON.stringify(installationEvent),
        }),
      );
      expect(reported.status).toBe(204);
      return {
        apiKey,
        seededEvents: (await countRows(db, "bundle_event_heads")) ?? 0,
      };
    }));
    expect(seededEvents).toBe(1);
  }, 240_000);

  afterAll(async () => {
    await stop();
    if (root !== undefined) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("serves the project's plugin, on its table, beside rc.20's data", async () => {
    const { url, workerRoot } = await deploy(
      "with-notes",
      "[...plugins, notes]",
    );
    try {
      const headers = { "x-api-key": apiKey };

      // rc.20's key and release.
      const catalog = await fetch(
        `${url}/release-catalogs/app-version/ios/cHJvZHVjdGlvbg/1.0.0`,
        { headers },
      );
      expect(catalog.status).toBe(200);
      await expect(catalog.json()).resolves.toMatchObject({
        releases: [{ bundleId: BUNDLE_ID }],
      });

      // The project's plugin, on the table its migration made, and its
      // CommonJS dependency's Node.js built-in in workerd.
      expect((await fetch(`${url}/notes/welcome`)).status).toBe(401);
      const written = await fetch(`${url}/notes/welcome`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      expect(written.status).toBe(201);
      const note = await fetch(`${url}/notes/welcome`, { headers });
      expect(note.status).toBe(200);
      await expect(note.json()).resolves.toEqual({
        text: "hello",
        digest: createHash("sha256").update("hello").digest("hex"),
      });

      // Insights, which rc.20's migration made the tables of.
      const reported = await fetch(`${url}/events`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(installationEvent),
      });
      expect(reported.status).toBe(204);
    } finally {
      await stop();
    }

    // What Wrangler uploads carries none of the machine's paths.
    const script = await uploadedScript(workerRoot);
    expect(script).toContain("/notes/:id");
    for (const local of [
      root,
      await fs.realpath(root),
      path.resolve(packageRoot, "../.."),
      os.homedir(),
    ]) {
      expect(script).not.toContain(local);
    }

    // Wrangler kept rc.20's migration, which it had applied, and applied
    // the one with the plugins' tables.
    await withDatabase(workerRoot, async (db) => {
      await expect(appliedMigrations(db)).resolves.toEqual([
        "0001_hot-updater_1.0.0.sql",
        expect.stringMatching(/^\d{14}_hot-updater\.sql$/u),
      ]);
    });
  }, 240_000);

  it("keeps Insights' data when the definition drops insights()", async () => {
    const { url, workerRoot } = await deploy(
      "without-insights",
      '[...plugins.filter(({ id }) => id !== "insights"), notes]',
    );
    try {
      const headers = { "x-api-key": apiKey };
      expect(
        (
          await fetch(
            `${url}/release-catalogs/app-version/ios/cHJvZHVjdGlvbg/1.0.0`,
            { headers },
          )
        ).status,
      ).toBe(200);
      await expect(
        (await fetch(`${url}/notes/welcome`, { headers })).json(),
      ).resolves.toMatchObject({ text: "hello" });
      // The Worker no longer serves Insights' endpoint.
      expect(
        (
          await fetch(`${url}/events`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(installationEvent),
          })
        ).status,
      ).toBe(404);
    } finally {
      await stop();
    }

    // Its tables and rows stay, for a definition that adds it back.
    await withDatabase(workerRoot, async (db) => {
      await expect(appliedMigrations(db)).resolves.toHaveLength(3);
      await expect(countRows(db, "bundle_event_heads")).resolves.toBe(
        seededEvents,
      );
      await expect(
        db
          .prepare(
            `SELECT "value" FROM "private_hot_updater_settings" WHERE "key" = 'schema.insights'`,
          )
          .first("value"),
      ).resolves.toBeTruthy();
    });
  }, 240_000);
});

/** An installation's report of the bundle it runs, which Insights records. */
const installationEvent = {
  type: "UNCHANGED",
  installId: "cloudflare-installation",
  toBundleId: BUNDLE_ID,
  platform: "ios",
  appVersion: "1.0.0",
  channel: "production",
  cohort: "default",
  fingerprintHash: null,
  fromBundleId: null,
  fromReleaseId: null,
  toReleaseId: null,
  updateStrategy: null,
};
