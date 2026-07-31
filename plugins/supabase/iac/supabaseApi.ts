import { createClient } from "@supabase/supabase-js";

export interface SupabaseApi {
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
