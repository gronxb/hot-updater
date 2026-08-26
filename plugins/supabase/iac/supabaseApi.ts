import { createClient } from "@supabase/supabase-js";

import { SUPABASE_V1_TABLE_NAMES } from "../src/supabaseInfrastructureNames";

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
      const marker = await supabase
        .from(SUPABASE_V1_TABLE_NAMES.settings)
        .select("value")
        .eq("key", "schema.core")
        .maybeSingle();
      if (!marker.error) {
        return marker.data?.value === "1.0.0" ? "v1" : "incompatible";
      }
      if (marker.error.code === "42P01" || marker.error.code === "PGRST205") {
        return "fresh";
      }
      throw marker.error;
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
