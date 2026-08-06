import {
  AnalyticsSchemaNotReadyError,
  parseBundleEventPersistenceRow,
  type AnalyticsPersistence,
  type AnalyticsScanInput,
  type BundleEventPersistenceRow,
} from "@hot-updater/analytics/provider";
import type { SupabaseClient } from "@supabase/supabase-js";

import { throwSupabaseError } from "./supabaseResult";
import type { Database } from "./types";

const orderedQuery = (
  client: SupabaseClient<Database>,
  input: AnalyticsScanInput,
) =>
  client
    .from("bundle_events")
    .select("*")
    .lt("received_at_ms", input.beforeReceivedAtMs)
    .order("received_at_ms", { ascending: true })
    .order("id", { ascending: true })
    .limit(input.limit);

function compareRows(
  left: BundleEventPersistenceRow,
  right: BundleEventPersistenceRow,
): number {
  const timestampOrder = left.received_at_ms - right.received_at_ms;
  if (timestampOrder !== 0) return timestampOrder;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export const createSupabaseAnalyticsPersistence = (
  client: SupabaseClient<Database>,
): AnalyticsPersistence => {
  const assertReady = async (): Promise<void> => {
    const { data, error } = await client
      .from("private_hot_updater_settings")
      .select("value")
      .eq("key", "schema.analytics")
      .maybeSingle();
    throwSupabaseError("read Analytics schema marker", error);
    const marker = data?.value ?? null;
    if (marker !== "2") {
      throw new AnalyticsSchemaNotReadyError({
        componentVersion: marker,
        fingerprint: null,
        legacyVersion: null,
      });
    }
  };
  return {
    async append(row) {
      await assertReady();
      const { error } = await client.from("bundle_events").insert(row);
      throwSupabaseError("append bundle event", error);
    },
    async scan(input) {
      await assertReady();
      if (input.after === undefined) {
        const { data, error } = await orderedQuery(client, input);
        throwSupabaseError("scan bundle events", error);
        return (data ?? []).map(parseBundleEventPersistenceRow);
      }
      const cursor = input.after;
      const [later, tied] = await Promise.all([
        orderedQuery(client, input).gt("received_at_ms", cursor.receivedAtMs),
        orderedQuery(client, input)
          .eq("received_at_ms", cursor.receivedAtMs)
          .gt("id", cursor.id),
      ]);
      throwSupabaseError("scan bundle events", later.error);
      throwSupabaseError("scan bundle events", tied.error);
      return [...(later.data ?? []), ...(tied.data ?? [])]
        .map(parseBundleEventPersistenceRow)
        .sort(compareRows)
        .slice(0, input.limit);
    },
  };
};
