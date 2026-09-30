import fs from "fs/promises";
import path from "path";

import { bundleServer, transformTemplate } from "@hot-updater/cli-tools";
import {
  type PluginTables,
  toolingTargetOf,
} from "@hot-updater/server/database";

import { d1Migration } from "../src/d1Migration";

/**
 * The managed Worker with the project's server definition: an entry that
 * serves the definition's client routes, bundled into the staged Worker. In
 * the Worker, `@hot-updater/cloudflare` is its runtime module, whose
 * database and storage are the Worker's D1 and R2 bindings.
 */
export const buildWorkerFromDefinition = async ({
  definition,
  packageRoot,
  projectRoot = process.cwd(),
  workerRoot,
}: {
  /** The server definition's absolute path. */
  definition: string;
  packageRoot: string;
  /** The project's directory, which the bundle's paths are relative to. */
  projectRoot?: string;
  workerRoot: string;
}) => {
  const runtime = path.join(packageRoot, "dist", "worker", "managed.mjs");
  const entry = path.join(workerRoot, "managed.ts");
  await fs.writeFile(
    entry,
    [
      `import { serveManagedWorker } from ${JSON.stringify(runtime)};`,
      `import * as definition from ${JSON.stringify(definition)};`,
      "",
      // The export the CLI reads: `hotUpdater`, or the default export.
      "export default serveManagedWorker(definition.hotUpdater ?? definition.default);",
      "",
    ].join("\n"),
  );
  try {
    await bundleServer({
      input: entry,
      definition,
      projectRoot,
      outfile: path.join(workerRoot, "dist", "managed.js"),
      format: "esm",
      platform: "neutral",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*"],
      alias: { "@hot-updater/cloudflare": runtime },
      target: "the Cloudflare Worker",
    });
  } finally {
    await fs.rm(entry, { force: true });
  }
  return "./dist/managed.js";
};

/**
 * A D1 migration of the tables and settings rows of core and `plugins`,
 * after the package's own, which holds core's: every statement can run
 * again, so it only adds what the plugins need.
 */
export const writePluginMigration = async (
  workerRoot: string,
  plugins: readonly unknown[],
) => {
  const migration = d1Migration(
    toolingTargetOf(plugins as readonly PluginTables[]),
  );
  await fs.writeFile(path.join(workerRoot, migration.path), migration.code);
};

/**
 * Readies the staged Worker for Wrangler as init deploys it: its bindings
 * to the D1 database and R2 bucket, `main` as its entry when init bundled
 * the server definition, and the migrations, the package's with core's
 * tables and one with the plugins'.
 */
export const prepareWorkerDeployment = async (
  workerRoot: string,
  {
    d1DatabaseId,
    d1DatabaseName,
    main,
    plugins,
    r2BucketName,
  }: {
    d1DatabaseId: string;
    d1DatabaseName: string;
    main: string | undefined;
    /** The plugins the Worker runs, whose tables the migration creates. */
    plugins: readonly unknown[];
    r2BucketName: string;
  },
) => {
  const configPath = path.join(workerRoot, "wrangler.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
  config.d1_databases = [
    {
      binding: "DB",
      database_id: d1DatabaseId,
      database_name: d1DatabaseName,
    },
  ];
  config.r2_buckets = [{ binding: "BUCKET", bucket_name: r2BucketName }];
  config.vars = { BUCKET_NAME: r2BucketName };
  if (main !== undefined) {
    config.main = main;
  }
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const migrations = path.join(workerRoot, "migrations");
  for (const file of await fs.readdir(migrations)) {
    if (file.endsWith(".sql")) {
      const filePath = path.join(migrations, file);
      await fs.writeFile(
        filePath,
        transformTemplate(await fs.readFile(filePath, "utf-8"), {
          BUCKET_NAME: r2BucketName,
        }),
      );
    }
  }
  await writePluginMigration(workerRoot, plugins);
};
