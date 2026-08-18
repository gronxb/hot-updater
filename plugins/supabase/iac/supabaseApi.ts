import { createClient } from "@supabase/supabase-js";

export type SupabaseInfrastructureState = "fresh" | "v0" | "v1";

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
    getInfrastructureState: async () => {
      const catalog = await supabase
        .from("release_catalogs")
        .select("scope_key")
        .limit(1);
      if (!catalog.error) return "v1";
      if (catalog.error.code !== "42P01" && catalog.error.code !== "PGRST205") {
        throw catalog.error;
      }

      const bundles = await supabase
        .from("bundles")
        .select("target_app_version")
        .limit(1);
      if (!bundles.error) return "v0";
      if (bundles.error.code === "42P01" || bundles.error.code === "PGRST205") {
        return "fresh";
      }
      throw bundles.error;
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
