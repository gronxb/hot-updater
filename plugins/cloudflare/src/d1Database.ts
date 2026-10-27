import { coreSettings, coreTarget } from "@hot-updater/plugin-core";
import type {
  SchemaGenerator,
  ToolingDatabase,
} from "@hot-updater/plugin-core";

import { createD1Database } from "./d1Executor";
import { type D1RestConfig, d1RestRunner } from "./d1Rest";
import { d1SchemaSql } from "./d1Schema";

export { D1ExecutionError } from "./d1Executor";

export type D1DatabaseConfig = D1RestConfig;

/**
 * Hot Updater's database on D1 through the Cloudflare REST API, for the CLI
 * and console. `hot-updater db generate` writes a D1 migration of the built-in
 * tables and the server's plugin tables to `migrations`, and
 * `hot-updater db migrate` applies them through the API. The managed
 * database migrates with the Worker's migrations when `hot-updater init` runs
 * again.
 */
export const d1Database = (config: D1DatabaseConfig): ToolingDatabase => ({
  ...createD1Database(d1RestRunner(config)),
  generateSchema: ((version, _name, target = coreTarget) => {
    if (version !== "latest" && version !== coreSettings["schema.core"]) {
      throw new Error(`Invalid version ${version}`);
    }
    // Wrangler applies migrations in the order of their leading numbers.
    const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    return {
      code: d1SchemaSql(target),
      path: `migrations/${timestamp}_hot-updater.sql`,
    };
  }) satisfies SchemaGenerator,
});
