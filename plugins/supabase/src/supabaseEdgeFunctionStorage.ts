import { createRuntimeStoragePlugin } from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "./types";

export interface SupabaseEdgeFunctionStorageConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  signedUrlExpiresIn?: number;
}

const parseSupabaseStorageUri = (storageUri: string) => {
  const storageUrl = new URL(storageUri);

  if (storageUrl.protocol !== "supabase-storage:") {
    throw new Error("Invalid Supabase storage URI protocol");
  }

  const bucketName = storageUrl.host;
  const key = storageUrl.pathname.replace(/^\/+/, "");

  if (!bucketName || !key) {
    throw new Error("Invalid Supabase storage URI");
  }

  return {
    bucketName,
    key,
  };
};

export const supabaseEdgeFunctionStorage =
  createRuntimeStoragePlugin<SupabaseEdgeFunctionStorageConfig>({
    name: "supabaseEdgeFunctionStorage",
    supportedProtocol: "supabase-storage",
    factory: (config) => {
      const supabase = createClient<Database>(
        config.supabaseUrl,
        config.supabaseServiceRoleKey,
      );

      return {
        async readText(storageUri) {
          const { bucketName, key } = parseSupabaseStorageUri(storageUri);
          const { data, error } = await supabase.storage
            .from(bucketName)
            .download(key);

          if (error) {
            if (error.message?.includes("not found")) {
              return null;
            }

            throw new Error(`Failed to read storage text: ${error.message}`);
          }

          if (!data) {
            return null;
          }

          return data.text();
        },
        async getDownloadUrl(storageUri) {
          const { bucketName, key } = parseSupabaseStorageUri(storageUri);
          const { data, error } = await supabase.storage
            .from(bucketName)
            .createSignedUrl(key, config.signedUrlExpiresIn ?? 3600);

          if (error) {
            throw new Error(
              `Failed to generate download URL: ${error.message}`,
            );
          }

          if (!data?.signedUrl) {
            throw new Error("Failed to generate download URL");
          }

          return { fileUrl: data.signedUrl };
        },
      };
    },
  });
