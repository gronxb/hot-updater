import type {
  SqlExecutor,
  SqlResult,
  SqlStatement,
} from "@hot-updater/server/database";
import type { SupabaseClient } from "@supabase/supabase-js";

import { SUPABASE_APPLY_FUNCTION } from "./supabaseInfrastructureNames";

/**
 * The apply RPC binds one jsonb array, so each placeholder becomes a typed
 * read of it, `($1->>k)::bigint`, and a null becomes `NULL`. No value is
 * ever written into the SQL.
 */
export const toApplyStatement = ({ sql, params }: SqlStatement) => {
  const values: unknown[] = [];
  const text = sql.replace(/\$(\d+)/gu, (_, position: string) => {
    const value = params[Number(position) - 1];
    if (value === null || value === undefined) return "NULL";
    values.push(value);
    const read = `($1->>${values.length - 1})`;
    if (typeof value === "boolean") return `${read}::boolean`;
    if (typeof value === "number") {
      return `${read}::${Number.isInteger(value) ? "bigint" : "double precision"}`;
    }
    return read;
  });
  return { sql: text, params: values };
};

/** PostgREST's code for a missing function or table reads as a missing table. */
const withCode = (error: { code?: string; message: string }) =>
  Object.assign(new Error(error.message, { cause: error }), {
    code:
      error.code === "PGRST202" || error.code === "PGRST205"
        ? "42P01"
        : error.code,
  });

/**
 * The SQL core's executor over Supabase: every statement goes through the
 * apply RPC, and a write is one RPC call, so one transaction.
 */
export const supabaseExecutor = (client: SupabaseClient): SqlExecutor => {
  const apply = async (statements: readonly SqlStatement[]) => {
    const { data, error } = await client.rpc(SUPABASE_APPLY_FUNCTION, {
      p_statements: statements.map(toApplyStatement),
    });
    if (error) throw withCode(error);
    return data as SqlResult[];
  };
  return {
    dialect: "postgresql",
    execute: async (statement) => (await apply([statement]))[0]!,
    batch: apply,
    transaction: () => {
      throw new Error("Supabase writes are batches through the apply RPC.");
    },
  };
};
