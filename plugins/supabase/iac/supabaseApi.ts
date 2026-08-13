import type { LegacyBundlePolicyRow } from "@hot-updater/server";
import { createClient } from "@supabase/supabase-js";

export interface SupabaseApi {
  listLegacyBundlePolicies: () => Promise<readonly LegacyBundlePolicyRow[]>;
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
  updateBucket: (
    bucketId: string,
    options: { public: boolean },
  ) => Promise<void>;
}

export const supabaseApi = (
  supabaseUrl: string,
  supabaseServiceRoleKey: string,
): SupabaseApi => {
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

  return {
    listLegacyBundlePolicies: async () => {
      const rows: LegacyBundlePolicyRow[] = [];
      const pageSize = 1000;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await supabase
          .from("bundles")
          .select(
            "id,platform,channel,enabled,should_force_update,message,target_app_version,fingerprint_hash,rollout_cohort_count,target_cohorts",
          )
          .order("id", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (error) {
          if (error.code === "42P01" || error.code === "PGRST205") return [];
          throw error;
        }
        rows.push(...(data as LegacyBundlePolicyRow[]));
        if (data.length < pageSize) return rows;
      }
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
    updateBucket: async (bucketId, options) => {
      const { error } = await supabase.storage.updateBucket(bucketId, options);
      if (error) {
        throw error;
      }
    },
  };
};
