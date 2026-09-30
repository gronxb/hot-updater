import fs from "fs/promises";
import path from "path";

import { bundleServer } from "@hot-updater/cli-tools";
import {
  type PluginTables,
  toolingTargetOf,
} from "@hot-updater/server/database";

import { supabaseMigration } from "../src/supabaseMigration";

/** The project's server definition, bundled beside the function's entry. */
const DEFINITION_MODULE = "hotUpdater.mjs";

/**
 * Packages the function's import map vendors, from @hot-updater/supabase's
 * dependencies, and the npm packages it maps; the bundle leaves them as
 * imports, so the definition runs on the function's own server.
 */
const EXTERNAL = [
  "@hot-updater/core",
  "@hot-updater/plugin-core",
  "@hot-updater/plugin-insights",
  "@hot-updater/plugin-api-keys",
  "@hot-updater/server",
  "@supabase/supabase-js",
].flatMap((name) => [name, `${name}/*`]);

/**
 * The managed Edge Function with the project's server definition: the
 * definition and the function's runtime module bundled into `functionDir`,
 * with an entry that loads them. In the function, `@hot-updater/supabase`
 * is the runtime module, whose database and storage use the function's
 * service role and `bucketName`.
 */
export const stageEdgeFunctionFromDefinition = async ({
  bucketName,
  definition,
  functionDir,
  functionName,
  packageRoot,
}: {
  bucketName: string;
  /** The server definition's absolute path. */
  definition: string;
  functionDir: string;
  functionName: string;
  packageRoot: string;
}) => {
  const runtime = path.join(packageRoot, "dist", "managed.mjs");
  const entry = path.join(functionDir, "managed.ts");
  await fs.writeFile(
    entry,
    [
      `import { serveManagedEdgeFunction } from ${JSON.stringify(runtime)};`,
      `import { hotUpdater } from ${JSON.stringify(definition)};`,
      "",
      "serveManagedEdgeFunction(hotUpdater);",
      "",
    ].join("\n"),
  );
  try {
    await bundleServer({
      input: entry,
      outfile: path.join(functionDir, DEFINITION_MODULE),
      format: "esm",
      platform: "neutral",
      conditions: ["deno", "worker", "browser"],
      external: EXTERNAL,
      alias: { "@hot-updater/supabase": runtime },
      define: {
        "HotUpdater.BUCKET_NAME": JSON.stringify(bucketName),
        "HotUpdater.FUNCTION_NAME": JSON.stringify(functionName),
      },
      // The definition reads process.env, which the Edge Runtime may lack.
      banner: "const process = globalThis.process ?? { env: {} };",
      target: "the Supabase Edge Function",
    });
  } finally {
    await fs.rm(entry, { force: true });
  }
  await fs.writeFile(
    path.join(functionDir, "index.ts"),
    `import "./${DEFINITION_MODULE}";\n`,
  );
};

/**
 * A migration of the tables, row-level security, apply RPC, and settings
 * rows of core and `plugins`, after the package's own, which holds core's:
 * every statement can run again, so it only adds what the plugins need.
 */
export const writePluginMigration = async (
  workdir: string,
  plugins: readonly unknown[],
) => {
  const migration = supabaseMigration(
    toolingTargetOf(plugins as readonly PluginTables[]),
  );
  await fs.writeFile(path.join(workdir, migration.path), migration.code);
};
