import { StoragePluginError } from "@hot-updater/plugin-core/storage";

import type { ResolvedSupabaseStorageConfig } from "./config";
import { toSupabaseStorageError } from "./errors";

export type SupabaseStorageClient = Readonly<{
  config: ResolvedSupabaseStorageConfig;
  request(
    path: string,
    init: RequestInit & Readonly<{ duplex?: "half" }>,
  ): Promise<Response>;
}>;

export const encodePath = (value: string): string =>
  value
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

const cancelBody = async (
  body: Uint8Array | ReadableStream<Uint8Array>,
): Promise<void> => {
  if (body instanceof ReadableStream && !body.locked) {
    await body.cancel().then(undefined, () => undefined);
  }
};

export const assertActive = async (
  signal: AbortSignal | undefined,
  body?: Uint8Array | ReadableStream<Uint8Array>,
): Promise<void> => {
  if (signal?.aborted !== true) {
    return;
  }
  if (body !== undefined) {
    await cancelBody(body);
  }
  throw new StoragePluginError("aborted", "Storage operation was aborted.");
};

export const createSupabaseStorageClient = (
  config: ResolvedSupabaseStorageConfig,
): SupabaseStorageClient =>
  Object.freeze({
    config,
    async request(path, init) {
      try {
        return await fetch(`${config.baseUrl}/storage/v1/${path}`, {
          ...init,
          headers: {
            apikey: config.key,
            authorization: `Bearer ${config.key}`,
            ...init.headers,
          },
        });
      } catch (error) {
        if (init.signal?.aborted === true) {
          throw new StoragePluginError(
            "aborted",
            "Storage operation was aborted.",
            { cause: error },
          );
        }
        throw error;
      }
    },
  });

export const requireSuccess = async (response: Response): Promise<Response> => {
  if (!response.ok) {
    throw await toSupabaseStorageError(response);
  }
  return response;
};

export const encodeMetadata = (
  metadata: Readonly<Record<string, string>>,
): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};
