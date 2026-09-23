import { createClient } from "@supabase/supabase-js";

import { SUPABASE_SETTINGS_TABLE } from "../src/supabaseInfrastructureNames";

export type SupabaseInfrastructureState = "fresh" | "incompatible" | "v1";

export interface SupabaseApi {
  getInfrastructureState: () => Promise<SupabaseInfrastructureState>;
  listBuckets: () => Promise<
    {
      id: string;
      name: string;
      isPublic: boolean;
      createdAt: string;
    }[]
  >;
  createBucket: (
    bucketName: string,
    options: { public: boolean },
  ) => Promise<{
    name: string;
  }>;
}

export const supabaseApi = (
  supabaseUrl: string,
  supabaseServiceRoleKey: string,
): SupabaseApi => {
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

  return {
    getInfrastructureState: async () => {
      const missing = (code?: string) =>
        code === "42P01" || code === "PGRST205";
      const marker = await supabase
        .from(SUPABASE_SETTINGS_TABLE)
        .select("value")
        .eq("key", "schema.engine")
        .maybeSingle();
      if (!marker.error) {
        return marker.data?.value === "1" ? "v1" : "incompatible";
      }
      if (!missing(marker.error.code)) throw marker.error;
      // A database from before the storage engine keeps its old settings table.
      const legacy = await supabase
        .from("hot_updater_v1_private_settings")
        .select("key")
        .limit(1);
      if (!legacy.error) return "incompatible";
      if (missing(legacy.error.code)) return "fresh";
      throw legacy.error;
    },
    listBuckets: async () => {
      const { data, error } = await supabase.storage.listBuckets();
      if (error) {
        throw error;
      }
      return data.map((file) => ({
        id: file.id,
        name: file.name,
        isPublic: file.public,
        createdAt: file.created_at,
      }));
    },
    createBucket: async (bucketName, options) => {
      const { data, error } = await supabase.storage.createBucket(
        bucketName,
        options,
      );
      if (error) {
        throw error;
      }
      return data;
    },
  };
};
