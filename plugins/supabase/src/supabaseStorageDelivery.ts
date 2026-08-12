import { parseStorageUri } from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";

import {
  resolveSupabaseServiceRoleKey,
  type SupabaseServiceRoleConfig,
} from "./supabaseConfig";
import type { Database } from "./types";

export type SupabaseStorageDeliveryConfig = SupabaseServiceRoleConfig & {
  bucketName: string;
  signedUrlExpiresIn?: number;
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const supabaseStorageDelivery = (
  config: SupabaseStorageDeliveryConfig,
) => {
  const bucket = createClient<Database>(
    config.supabaseUrl,
    resolveSupabaseServiceRoleKey(config),
  ).storage.from(config.bucketName);

  return {
    async resolveUrl(storageUri: string): Promise<string | null> {
      const parsed = parseStorageUri(storageUri, "supabase-storage");
      if (parsed.bucket !== config.bucketName) {
        throw new Error(
          `Bucket name mismatch: expected "${config.bucketName}", but found "${parsed.bucket}".`,
        );
      }

      try {
        const { data, error } = await bucket.createSignedUrl(
          parsed.key,
          config.signedUrlExpiresIn ?? 3600,
        );
        if (error || !data?.signedUrl) {
          throw error ?? new Error("missing signed URL");
        }
        return data.signedUrl;
      } catch (error) {
        throw new Error(
          `Failed to generate download URL for "${parsed.key}": ${getErrorMessage(error)}`,
        );
      }
    },
  };
};
