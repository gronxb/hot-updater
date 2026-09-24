import { PGlite } from "@electric-sql/pglite";
import { builtInSchema, createSqlAdapter } from "@hot-updater/server/database";
import {
  createMeasuredDatabase,
  targetBaseCandidateKey,
} from "@hot-updater/server/db";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";
import {
  postgresRowsExamined,
  setupReadBudgetTestSuite,
} from "@hot-updater/test-utils";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseExecutor } from "./supabaseExecutor";
import { SUPABASE_TABLE_PREFIX, supabaseSchemaSql } from "./supabaseSchema";

/**
 * `supabaseDatabase()`'s composition without its schema fence: the SQL core
 * over the Supabase executor, whose every statement goes through the
 * generated apply RPC, here on PGlite with Supabase's roles, as the service
 * role. Reads are explained on the same session, outside the RPC.
 */
setupReadBudgetTestSuite({
  name: "supabase apply RPC (PGlite)",
  server: {
    createMeasuredDatabase,
    builtInSchema,
    plugins: [insights(), apiKeys()],
    targetBaseCandidateKey,
  },
  createAdapter: async () => {
    const db = new PGlite();
    await db.exec(
      "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;",
    );
    await db.exec(supabaseSchemaSql());
    await db.exec(
      "GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; SET ROLE service_role;",
    );
    /** Supabase's client as PostgREST runs an RPC: one statement. */
    const client = {
      rpc: async (name: string, args: { readonly p_statements: unknown }) => {
        try {
          const result = await db.query<{ result: unknown }>(
            `SELECT public.${name}($1::jsonb) AS result`,
            [JSON.stringify(args.p_statements)],
          );
          return { data: result.rows[0]!.result, error: null };
        } catch (error) {
          const { code, message } = error as { code?: string; message: string };
          return { data: null, error: { code, message } };
        }
      },
    } as unknown as SupabaseClient;
    const reads = postgresRowsExamined(
      async (sql, params) =>
        (await db.query<Record<string, unknown>>(sql, [...params])).rows,
    );
    return {
      adapter: createSqlAdapter({
        executor: reads.wrap(supabaseExecutor(client)),
        tablePrefix: SUPABASE_TABLE_PREFIX,
      }),
      examined: reads.examined,
      cleanup: () => db.close(),
    };
  },
});
