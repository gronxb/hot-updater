import type { StoragePlugin } from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

export interface SupabaseEdgeFunctionStorageConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  signedUrlExpiresIn?: number;
}

export const supabaseEdgeFunctionStorage = (
  config: SupabaseEdgeFunctionStorageConfig,
) => {
  const supabase = createClient<Database>(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
  );

  return (): StoragePlugin => {
    return {
      name: "supabaseEdgeFunctionStorage",
      supportedProtocol: "supabase-storage",
      async upload() {
        throw new Error(
          "supabaseEdgeFunctionStorage does not support upload() in the edge runtime.",
        );
      },
      async delete(storageUri) {
        const storageUrl = new URL(storageUri);

        if (storageUrl.protocol !== "supabase-storage:") {
          throw new Error("Invalid Supabase storage URI protocol");
        }

        const bucketName = storageUrl.host;
        const key = storageUrl.pathname.replace(/^\/+/, "");

        if (!bucketName || !key) {
          throw new Error("Invalid Supabase storage URI");
        }

        const { error } = await supabase.storage.from(bucketName).remove([key]);

        if (error) {
          throw new Error(`Failed to delete bundle: ${error.message}`);
        }
      },
      async getDownloadUrl(storageUri) {
        const storageUrl = new URL(storageUri);

        if (storageUrl.protocol !== "supabase-storage:") {
          throw new Error("Invalid Supabase storage URI protocol");
        }

        const bucketName = storageUrl.host;
        const key = storageUrl.pathname.replace(/^\/+/, "");

        if (!bucketName || !key) {
          throw new Error("Invalid Supabase storage URI");
        }

        const { data, error } = await supabase.storage
          .from(bucketName)
          .createSignedUrl(key, config.signedUrlExpiresIn ?? 3600);

        if (error) {
          throw new Error(`Failed to generate download URL: ${error.message}`);
        }

        if (!data?.signedUrl) {
          throw new Error("Failed to generate download URL");
        }

        return { fileUrl: data.signedUrl };
      },
    };
  };
};
