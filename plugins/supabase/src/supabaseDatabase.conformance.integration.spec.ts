import { PGlite } from "@electric-sql/pglite";
import {
  builtInTarget,
  type PhysicalTable,
} from "@hot-updater/server/database";
import { setupDatabaseAdapterConformanceSuite } from "@hot-updater/test-utils";
import { vi } from "vitest";

import { supabaseDatabase } from "./supabaseDatabase";
import { supabaseSchemaStatements } from "./supabaseSchema";

const state = vi.hoisted(() => ({ db: undefined as PGlite | undefined }));

/**
 * Supabase's client, as PostgREST runs an RPC: one statement, as the service
 * role.
 */
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: { readonly p_statements: unknown }) => {
      try {
        const result = await state.db!.query<{ result: unknown }>(
          `SELECT public.${name}($1::jsonb) AS result`,
          [JSON.stringify(args.p_statements)],
        );
        return { data: result.rows[0]!.result, error: null };
      } catch (error) {
        const { code, message } = error as { code?: string; message: string };
        return { data: null, error: { code, message } };
      }
    },
  }),
}));

/**
 * Supabase's migration with the conformance tables beside Hot Updater's:
 * under the prefix, with row-level security, and in the apply RPC's table
 * list, as a migration for plugin tables adds them.
 */
const migration = (tables: readonly PhysicalTable[]): string[] =>
  supabaseSchemaStatements({
    schema: {
      ...builtInTarget.schema,
      tables: [...builtInTarget.schema.tables, ...tables],
    },
    settings: builtInTarget.settings,
  });

/**
 * The adapter `supabaseDatabase` returns, schema fence included: every read
 * and write goes through the generated apply RPC, run as the service role on
 * a new PGlite per test with Supabase's roles and the migration's settings
 * rows.
 */
setupDatabaseAdapterConformanceSuite({
  name: "supabase apply RPC (PGlite)",
  // The SQL core's default cap: `supabaseDatabase` takes 1,000 ops per write.
  maxOps: 1000,
  createAdapter: async ({ tables }) => {
    const db = new PGlite();
    await db.exec(
      "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;",
    );
    await db.exec(migration(tables).join(";\n"));
    await db.exec(
      "GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; SET ROLE service_role;",
    );
    state.db = db;
    return {
      adapter: supabaseDatabase({
        supabaseUrl: "https://project.supabase.co",
        supabaseServiceRoleKey: "service-role-key",
      }).adapter,
      cleanup: async () => {
        state.db = undefined;
        await db.close();
      },
    };
  },
});
