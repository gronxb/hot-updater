import {
  isConfigReference,
  resolveConfigReference,
  type ConfigReference,
} from "@hot-updater/core/config";
import type { StorageOperationContext } from "@hot-updater/plugin-core/storage";
import { StoragePluginError } from "@hot-updater/plugin-core/storage";

export type SupabaseStorageConfig = Readonly<{
  supabaseUrl: string | ConfigReference;
  supabaseServiceRoleKey?: string | ConfigReference;
  supabaseAnonKey?: string | ConfigReference;
  bucketName: string | ConfigReference;
  basePath?: string | ConfigReference;
  delivery?: "signed" | "public";
  signedUrlExpiresIn?: number;
}>;

export type ResolvedSupabaseStorageConfig = Readonly<{
  baseUrl: string;
  key: string;
  bucketName: string;
  basePath: string;
  delivery: "signed" | "public";
  signedUrlExpiresIn: number;
}>;

export const hasTaggedConfig = (config: SupabaseStorageConfig): boolean =>
  [
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    config.supabaseAnonKey,
    config.bucketName,
    config.basePath,
  ].some(isConfigReference);

const resolveString = (
  value: string | ConfigReference,
  context: StorageOperationContext,
): string => resolveConfigReference<string>(value, context);

const normalizeBasePath = (value: string): string =>
  value.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");

export const resolveSupabaseStorageConfig = (
  config: SupabaseStorageConfig,
  context: StorageOperationContext,
): ResolvedSupabaseStorageConfig => {
  const rawUrl = resolveString(config.supabaseUrl, context);
  if (!URL.canParse(rawUrl)) {
    throw new StoragePluginError(
      "invalid-input",
      "Supabase URL must be an absolute URL.",
    );
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new StoragePluginError(
      "invalid-input",
      "Supabase URL must use HTTP or HTTPS.",
    );
  }
  const keyConfig = config.supabaseServiceRoleKey ?? config.supabaseAnonKey;
  if (keyConfig === undefined) {
    throw new StoragePluginError(
      "invalid-input",
      "Supabase service role key is required.",
    );
  }
  const key = resolveString(keyConfig, context);
  const bucketName = resolveString(config.bucketName, context);
  if (key.length === 0 || bucketName.length === 0 || bucketName.includes("/")) {
    throw new StoragePluginError(
      "invalid-input",
      "Supabase key and bucket name must be non-empty.",
    );
  }
  const signedUrlExpiresIn = config.signedUrlExpiresIn ?? 3600;
  if (!Number.isSafeInteger(signedUrlExpiresIn) || signedUrlExpiresIn < 0) {
    throw new StoragePluginError(
      "invalid-input",
      "signedUrlExpiresIn must be a non-negative safe integer.",
    );
  }

  return Object.freeze({
    baseUrl: url.href.replace(/\/+$/u, ""),
    key,
    bucketName,
    basePath:
      config.basePath === undefined
        ? ""
        : normalizeBasePath(resolveString(config.basePath, context)),
    delivery: config.delivery ?? "signed",
    signedUrlExpiresIn,
  });
};

export const createObjectKey = (basePath: string, key: string): string => {
  const normalizedKey = normalizeBasePath(key);
  if (normalizedKey.length === 0) {
    throw new StoragePluginError("invalid-input", "Storage key is empty.");
  }
  return [basePath, normalizedKey].filter(Boolean).join("/");
};
