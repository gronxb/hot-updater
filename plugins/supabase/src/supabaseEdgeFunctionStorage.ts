import { createRuntimeStoragePlugin } from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "./types";

export interface SupabaseEdgeFunctionStorageConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  signedUrlExpiresIn?: number;
}

const signedUrlRetryDelays = [100, 250, 500, 1000, 2000] as const;

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function isObjectNotFoundError(error: unknown) {
  return getErrorMessage(error).toLowerCase().includes("object not found");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
          const bucket = supabase.storage.from(bucketName);
          const expiresIn = config.signedUrlExpiresIn ?? 3600;

          let lastError: unknown;
          for (
            let attempt = 0;
            attempt <= signedUrlRetryDelays.length;
            attempt++
          ) {
            let data: { signedUrl?: string } | null = null;
            let error: unknown = null;
            try {
              const response = await bucket.createSignedUrl(key, expiresIn);
              data = response.data;
              error = response.error;
            } catch (thrownError) {
              error = thrownError;
            }
            if (!error && data?.signedUrl) {
              return { fileUrl: data.signedUrl };
            }

            lastError = error ?? new Error("missing signed URL");
            if (error && !isObjectNotFoundError(error)) {
              throw new Error(
                `Failed to generate download URL for "${bucketName}/${key}": ${getErrorMessage(error)}`,
              );
            }

            const retryDelay = signedUrlRetryDelays[attempt];
            if (retryDelay === undefined) {
              break;
            }
            await delay(retryDelay);
          }

          throw new Error(
            `Failed to generate download URL for "${bucketName}/${key}": ${getErrorMessage(lastError)}`,
          );
        },
      };
    },
  });
