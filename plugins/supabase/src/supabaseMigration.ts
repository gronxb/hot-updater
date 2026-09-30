import { coreSettings, coreTarget } from "@hot-updater/server/database";
import type {
  SchemaGenerator,
  ToolingDatabase,
  ToolingTarget,
} from "@hot-updater/server/db";

import {
  supabaseDatabase as engineDatabase,
  type SupabaseDatabaseConfig,
} from "./supabaseDatabase";
import { supabaseSchemaSql } from "./supabaseSchema";

/**
 * A Supabase migration of `target`'s tables, the apply RPC that may name
 * them, and their settings rows. It is named after the time, since Supabase
 * applies migrations in the order of their timestamps, and every statement
 * can run again.
 */
export const supabaseMigration = (target: ToolingTarget = coreTarget) => {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return {
    code: supabaseSchemaSql(target),
    path: `supabase/migrations/${timestamp}_hot-updater.sql`,
  };
};

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
  generateSchema: ((version, _name, target = coreTarget) => {
    if (version !== "latest" && version !== coreSettings["schema.core"]) {
      throw new Error(`Invalid version ${version}`);
    }
    return supabaseMigration(target);
  }) satisfies SchemaGenerator,
});
