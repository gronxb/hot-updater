import { coreSettings, coreTarget } from "@hot-updater/plugin-core";
import type {
  SchemaGenerator,
  ToolingDatabase,
} from "@hot-updater/plugin-core";

import {
  supabaseDatabase as engineDatabase,
  type SupabaseDatabaseConfig,
} from "./supabaseDatabase";
import { supabaseSchemaSql } from "./supabaseSchema";

/**
 * The resource this database reaches, without credentials, under the key
 * `hot-updater doctor` reads to tell the database `hot-updater init` saved
 * from another (a convention CLAUDE.md documents).
 */
const DATABASE_TARGET = Symbol.for("@hot-updater/database-target");

/** `target` under {@link DATABASE_TARGET}, to spread into the database. */
const marked = (target: string) => ({ [DATABASE_TARGET]: target });

/**
 * Hot Updater's database on Supabase, with the migration `hot-updater db
 * generate` writes to `supabase/migrations`: core's tables, the server's
 * plugin tables, the apply RPC that may name them, and their settings rows.
 * `supabase db push` applies it.
 */
export const supabaseDatabase = (
  config: SupabaseDatabaseConfig,
): ToolingDatabase => ({
  ...engineDatabase(config),
  ...marked(`supabase/${new URL(config.supabaseUrl).hostname}`),
  generateSchema: ((version, _name, target = coreTarget) => {
    if (version !== "latest" && version !== coreSettings["schema.core"]) {
      throw new Error(`Invalid version ${version}`);
    }
    const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    return {
      code: supabaseSchemaSql(target),
      path: `supabase/migrations/${timestamp}_hot-updater.sql`,
    };
  }) satisfies SchemaGenerator,
});
