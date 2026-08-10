import type {
  ManagedAccessKeyRecord,
  ManagedAccessKeyStore,
} from "@hot-updater/better-auth/managed";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  resolveSupabaseServiceRoleKey,
  type SupabaseServiceRoleConfig,
} from "./supabaseConfig";
import { throwSupabaseError } from "./supabaseResult";
import type { Database, SupabaseManagedAccessKeyRow } from "./types";

const parseTimestamp = (value: unknown, field: string): number => {
  const timestamp = typeof value === "string" ? Number(value) : value;
  if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)) {
    throw new TypeError(`Invalid managed access-key ${field}.`);
  }
  return timestamp;
};

const parseRecord = (
  row: SupabaseManagedAccessKeyRow,
): ManagedAccessKeyRecord => {
  if (
    typeof row.id !== "string" ||
    typeof row.hash !== "string" ||
    typeof row.name !== "string" ||
    typeof row.prefix !== "string" ||
    row.role !== "client" ||
    typeof row.enabled !== "boolean" ||
    (row.revoked_at_ms !== null &&
      typeof row.revoked_at_ms !== "number" &&
      typeof row.revoked_at_ms !== "string")
  ) {
    throw new TypeError("Invalid managed access-key row.");
  }
  return {
    createdAt: parseTimestamp(row.created_at_ms, "createdAt"),
    enabled: row.enabled,
    hash: row.hash,
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    revokedAt:
      row.revoked_at_ms === null
        ? null
        : parseTimestamp(row.revoked_at_ms, "revokedAt"),
    role: row.role,
  };
};

export const createSupabaseManagedAccessKeyStoreFromClient = (
  supabase: SupabaseClient<Database>,
): ManagedAccessKeyStore => ({
  async create(record) {
    const { data, error } = await supabase
      .from("managed_access_keys")
      .upsert(
        {
          created_at_ms: record.createdAt,
          enabled: record.enabled,
          hash: record.hash,
          id: record.id,
          name: record.name,
          prefix: record.prefix,
          revoked_at_ms: record.revokedAt,
          role: record.role,
        },
        { ignoreDuplicates: true, onConflict: "hash" },
      )
      .select("id");
    throwSupabaseError("create managed access key", error);
    return data === null || data.length === 0 ? "existing" : "created";
  },
  async findByHash(hash) {
    const { data, error } = await supabase
      .from("managed_access_keys")
      .select("*")
      .eq("hash", hash)
      .maybeSingle();
    throwSupabaseError("find managed access key", error);
    return data === null ? null : parseRecord(data);
  },
  async list() {
    const { data, error } = await supabase
      .from("managed_access_keys")
      .select("*")
      .order("created_at_ms", { ascending: false })
      .order("id", { ascending: true });
    throwSupabaseError("list managed access keys", error);
    return (data ?? []).map(parseRecord);
  },
  async revoke({ id, revokedAt }) {
    const { data, error } = await supabase
      .from("managed_access_keys")
      .update({ enabled: false, revoked_at_ms: revokedAt })
      .eq("id", id)
      .eq("enabled", true)
      .select("*")
      .maybeSingle();
    throwSupabaseError("revoke managed access key", error);
    if (data !== null) return parseRecord(data);

    const { data: existing, error: findError } = await supabase
      .from("managed_access_keys")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    throwSupabaseError("find revoked managed access key", findError);
    return existing === null ? null : parseRecord(existing);
  },
});

export const createSupabaseManagedAccessKeyStore = (
  config: SupabaseServiceRoleConfig,
): ManagedAccessKeyStore =>
  createSupabaseManagedAccessKeyStoreFromClient(
    createClient<Database>(
      config.supabaseUrl,
      resolveSupabaseServiceRoleKey(config),
    ),
  );
