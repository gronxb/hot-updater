import { builtInSettings, builtInTarget } from "@hot-updater/server/database";
import type { SchemaGenerator, ToolingDatabase } from "@hot-updater/server/db";

import {
  supabaseDatabase as engineDatabase,
  type SupabaseDatabaseConfig,
} from "./supabaseDatabase";
import { supabaseSchemaSql } from "./supabaseSchema";

/**
 * Hot Updater's database on Supabase, with the migration `hot-updater db
 * generate` writes to `supabase/migrations`: the built-in tables, the
 * server's plugin tables, the apply RPC that may name them, and their
 * settings rows. `supabase db push` applies it.
 */
export const supabaseDatabase = (
  config: SupabaseDatabaseConfig,
): ToolingDatabase => ({
  ...engineDatabase(config),
  generateSchema: ((version, _name, target = builtInTarget) => {
    if (version !== "latest" && version !== builtInSettings["schema.core"]) {
      throw new Error(`Invalid version ${version}`);
    }
    // Supabase applies migrations in the order of their timestamps.
    const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    return {
      code: supabaseSchemaSql(target),
      path: `supabase/migrations/${timestamp}_hot-updater.sql`,
    };
  }) satisfies SchemaGenerator,
});
