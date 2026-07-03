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
    .from("ingest_keys")
    .select("active,key_hash,key_suffix")
    .eq("id", TELEMETRY_KEY_ROW_ID)
    .maybeSingle();

  if (error) {
    throw createSupabaseError("Failed to read telemetry key credential", error);
  }

  return data
    ? {
        active: data.active,
        keyHash: data.key_hash,
        telemetryKeySuffix: data.key_suffix,
      }
    : null;
};

export const upsertTelemetryKeyCredential = async (
  supabase: SupabaseTelemetryClient,
  credential: TelemetryKeyCredential,
): Promise<void> => {
  const now = new Date().toISOString();
  const { error } = await supabase.from("ingest_keys").upsert(
    {
      active: credential.active,
      created_at: now,
      id: TELEMETRY_KEY_ROW_ID,
      key_hash: credential.keyHash,
      key_suffix: credential.telemetryKeySuffix,
      updated_at: now,
    },
    { onConflict: "id" },
  );

  if (error) throw createSupabaseError("Failed to store telemetry key", error);
};

export const setTelemetryKeyActive = async (
  supabase: SupabaseTelemetryClient,
  active: boolean,
): Promise<void> => {
  const { error } = await supabase
    .from("ingest_keys")
    .update({
      active,
      updated_at: new Date().toISOString(),
    })
    .eq("id", TELEMETRY_KEY_ROW_ID);

  if (error) {
    throw createSupabaseError("Failed to update telemetry key state", error);
  }
};
