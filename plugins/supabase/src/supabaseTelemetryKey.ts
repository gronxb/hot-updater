import type { TelemetryKeyCredential } from "@hot-updater/plugin-core";

import {
  TELEMETRY_KEY_ROW_ID,
  createSupabaseError,
  type SupabaseTelemetryClient,
} from "./supabaseTelemetryTypes";

export const getTelemetryKeyCredential = async (
  supabase: SupabaseTelemetryClient,
): Promise<TelemetryKeyCredential | null> => {
  const { data, error } = await supabase
    .from("telemetry_keys")
    .select("key_hash,key_suffix")
    .eq("id", TELEMETRY_KEY_ROW_ID)
    .maybeSingle();

  if (error) {
    throw createSupabaseError("Failed to read telemetry key credential", error);
  }

  return data
    ? {
        keyHash: data.key_hash,
        telemetryKeySuffix: data.key_suffix,
      }
    : null;
};

export const upsertTelemetryKeyCredential = async (
  supabase: SupabaseTelemetryClient,
  credential: TelemetryKeyCredential,
): Promise<void> => {
  const { error } = await supabase.from("telemetry_keys").upsert(
    {
      id: TELEMETRY_KEY_ROW_ID,
      key_hash: credential.keyHash,
      key_suffix: credential.telemetryKeySuffix,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );

  if (error) throw createSupabaseError("Failed to store telemetry key", error);
};
