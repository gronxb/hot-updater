import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type InsightsEventPage,
  type InsightsEventPageInput,
} from "@hot-updater/plugin-core";
import {
  assertInsightsEventRow,
  compareInsightsEventRows,
  createInsightsEventPageCursor,
  readInsightsEventPageCursor,
} from "@hot-updater/plugin-core/internal";
import type { SupabaseClient } from "@supabase/supabase-js";

import { SUPABASE_V1_FUNCTION_NAMES } from "./supabaseInfrastructureNames";
import { throwSupabaseError } from "./supabaseResult";
import type { Database } from "./types";

const canonicalUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const missingPageFunction = new RegExp(
  `^function (?:public\\.)?${SUPABASE_V1_FUNCTION_NAMES.insightsEventPage}\\(`,
);

export const createSupabaseInsightsEventPage =
  (supabase: Pick<SupabaseClient<Database>, "rpc">) =>
  async (input: InsightsEventPageInput): Promise<InsightsEventPage> => {
    const cursor = readInsightsEventPageCursor(input);
    if (
      (input.scope.kind === "bundle" &&
        !canonicalUuid.test(input.scope.bundleId)) ||
      (cursor !== undefined && !canonicalUuid.test(cursor.id))
    ) {
      throw new DatabasePluginInputError("invalid-query");
    }
    const { data, error } = await supabase.rpc(
      SUPABASE_V1_FUNCTION_NAMES.insightsEventPage,
      {
        p_scope: input.scope.kind,
        p_scope_id:
          input.scope.kind === "all"
            ? null
            : input.scope.kind === "bundle"
              ? input.scope.bundleId
              : input.scope.installId,
        p_before_received_at_ms: input.beforeReceivedAtMs,
        p_limit: input.limit,
        p_cursor_received_at_ms: cursor?.receivedAtMs ?? null,
        p_cursor_id: cursor?.id ?? null,
      },
    );
    if (
      error?.code === "PGRST202" ||
      (error?.code === "42883" && missingPageFunction.test(error.message)) ||
      (error?.code === "P0001" && error.message === "INSIGHTS_QUERY_NOT_READY")
    ) {
      throw new InsightsQueryNotReadyError();
    }
    throwSupabaseError("page Insights events", error);
    if (
      typeof data !== "object" ||
      data === null ||
      !Array.isArray(data.rows) ||
      data.rows.length > input.limit ||
      typeof data.hasMore !== "boolean" ||
      (data.hasMore && data.rows.length !== input.limit)
    ) {
      throw new DatabasePluginInputError("invalid-result");
    }
    const rows = data.rows;
    for (const [index, row] of rows.entries()) {
      assertInsightsEventRow(row);
      const previous = rows[index - 1];
      if (
        !canonicalUuid.test(row.id) ||
        row.received_at_ms >= input.beforeReceivedAtMs ||
        (cursor !== undefined &&
          (row.received_at_ms > cursor.receivedAtMs ||
            (row.received_at_ms === cursor.receivedAtMs &&
              row.id >= cursor.id))) ||
        (previous !== undefined &&
          compareInsightsEventRows(previous, row) >= 0) ||
        (input.scope.kind === "installation" &&
          (row.install_id !== input.scope.installId ||
            (row.type !== "UPDATE_APPLIED" && row.type !== "RECOVERED"))) ||
        (input.scope.kind === "bundle" &&
          !(
            (row.type === "UPDATE_APPLIED" &&
              row.to_bundle_id === input.scope.bundleId) ||
            (row.type === "RECOVERED" &&
              row.from_bundle_id === input.scope.bundleId)
          ))
      ) {
        throw new DatabasePluginInputError("invalid-result");
      }
    }
    const last = rows.at(-1);
    return {
      rows,
      nextCursor:
        data.hasMore && last
          ? createInsightsEventPageCursor(input, {
              receivedAtMs: last.received_at_ms,
              id: last.id,
            })
          : null,
    };
  };
