import fs from "fs/promises";
import path from "path";

import { bundleServer } from "@hot-updater/cli-tools";
import {
  type PluginTables,
  toolingTargetOf,
} from "@hot-updater/server/database";

import { d1Migration } from "../src/d1Database";

/**
 * The managed Worker with the project's server definition: an entry that
 * serves the definition's client routes, bundled into the staged Worker. In
 * the Worker, `@hot-updater/cloudflare` is its runtime module, whose
 * database and storage are the Worker's D1 and R2 bindings.
 */
export const buildWorkerFromDefinition = async ({
  definition,
  packageRoot,
  workerRoot,
}: {
  /** The server definition's absolute path. */
  definition: string;
  packageRoot: string;
  workerRoot: string;
}) => {
  const runtime = path.join(packageRoot, "dist", "worker", "managed.mjs");
  const entry = path.join(workerRoot, "managed.ts");
  await fs.writeFile(
    entry,
    [
      `import { serveManagedWorker } from ${JSON.stringify(runtime)};`,
      `import { hotUpdater } from ${JSON.stringify(definition)};`,
      "",
      "export default serveManagedWorker(hotUpdater);",
      "",
    ].join("\n"),
  );
  await bundleServer({
    input: entry,
    outfile: path.join(workerRoot, "dist", "managed.js"),
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*"],
    alias: { "@hot-updater/cloudflare": runtime },
    target: "the Cloudflare Worker",
  });
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
