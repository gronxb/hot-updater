import type { StorageOperationContext } from "@hot-updater/plugin-core/storage";
import {
  createStoragePlugin,
  StoragePluginError,
  type StoragePlugin,
  type StoragePluginImplementation,
} from "@hot-updater/plugin-core/storage";

import {
  createObjectKey,
  hasTaggedConfig,
  resolveSupabaseStorageConfig,
  type SupabaseStorageConfig,
} from "./config";
import {
  createStorageUri,
  parseStorageUri,
  readObjectInfo,
  readSignedUrl,
} from "./object";
import {
  assertActive,
  createSupabaseStorageClient,
  encodeMetadata,
  encodePath,
  requireSuccess,
  type SupabaseStorageClient,
} from "./transport";

type AllowedTarget = "node" | "worker" | "edge";

const createImplementation = (
  getClient: (context: StorageOperationContext) => SupabaseStorageClient,
): StoragePluginImplementation => ({
  async put(input: Parameters<StoragePlugin["put"]>[0]) {
    const client = getClient(input.context);
    await assertActive(input.signal, input.body);
    const key = createObjectKey(client.config.basePath, input.key);
    const response = await client.request(
      `object/${encodePath(client.config.bucketName)}/${encodePath(key)}`,
      {
        body: input.body,
        duplex: input.body instanceof ReadableStream ? "half" : undefined,
        headers: {
          "cache-control": "max-age=31536000",
          "content-length": String(input.contentLength),
          "content-type": input.contentType ?? "application/octet-stream",
          "x-metadata": encodeMetadata(input.metadata ?? {}),
          "x-upsert": "false",
        },
        method: "POST",
        signal: input.signal,
      },
    );
    if (response.status === 409) {
      return {
        kind: "already-exists",
        storageUri: createStorageUri(client, key),
      };
    }
    await requireSuccess(response);
    return { kind: "stored", storageUri: createStorageUri(client, key) };
  },
  async head(input: Parameters<StoragePlugin["head"]>[0]) {
    const client = getClient(input.context);
    const key = parseStorageUri(input.storageUri, client);
    const metadata = await readObjectInfo(client, key, input.signal);
    return metadata === undefined
      ? { kind: "not-found" }
      : { kind: "found", metadata, storageUri: input.storageUri };
  },
  async get(input: Parameters<StoragePlugin["get"]>[0]) {
    const client = getClient(input.context);
    const key = parseStorageUri(input.storageUri, client);
    const metadata = await readObjectInfo(client, key, input.signal);
    if (metadata === undefined) {
      return { kind: "not-found" };
    }
    const range = input.range;
    const response = await client.request(
      `object/${encodePath(client.config.bucketName)}/${encodePath(key)}`,
      {
        headers:
          range === undefined
            ? {}
            : { range: `bytes=${range.start}-${range.end ?? ""}` },
        method: "GET",
        signal: input.signal,
      },
    );
    if (response.status === 404) {
      return { kind: "not-found" };
    }
    await requireSuccess(response);
    if (response.body === null) {
      throw new StoragePluginError(
        "provider",
        "Supabase Storage returned an empty response body.",
      );
    }
    let returnedRange:
      | Readonly<{ start: number; end: number; totalLength: number }>
      | undefined;
    if (range !== undefined) {
      const match = response.headers
        .get("content-range")
        ?.match(/^bytes (\d+)-(\d+)\/(\d+)$/u);
      const expectedEnd = Math.min(
        range.end ?? metadata.contentLength - 1,
        metadata.contentLength - 1,
      );
      if (
        response.status !== 206 ||
        match?.[1] === undefined ||
        match[2] === undefined ||
        match[3] === undefined ||
        Number(match[1]) !== range.start ||
        Number(match[2]) !== expectedEnd ||
        Number(match[3]) !== metadata.contentLength
      ) {
        await response.body.cancel().then(undefined, () => undefined);
        throw new StoragePluginError(
          "provider",
          "Supabase Storage returned an invalid byte range.",
        );
      }
      returnedRange = {
        start: range.start,
        end: expectedEnd,
        totalLength: metadata.contentLength,
      };
    }
    return {
      body: response.body,
      kind: "found",
      metadata,
      ...(returnedRange === undefined ? {} : { range: returnedRange }),
      storageUri: input.storageUri,
    };
  },
  async delete(input: Parameters<StoragePlugin["delete"]>[0]) {
    const client = getClient(input.context);
    await assertActive(input.signal);
    const key = parseStorageUri(input.storageUri, client);
    const response = await requireSuccess(
      await client.request(`object/${encodePath(client.config.bucketName)}`, {
        body: JSON.stringify({ prefixes: [key] }),
        headers: { "content-type": "application/json" },
        method: "DELETE",
        signal: input.signal,
      }),
    );
    const removed: unknown = await response.json().catch(() => undefined);
    if (!Array.isArray(removed)) {
      throw new StoragePluginError(
        "provider",
        "Supabase Storage returned an invalid remove response.",
      );
    }
    return removed.length === 0 ? { kind: "not-found" } : { kind: "deleted" };
  },
  async issueDownload(
    input: Parameters<NonNullable<StoragePlugin["issueDownload"]>>[0],
  ) {
    const client = getClient(input.context);
    await assertActive(input.signal);
    const key = parseStorageUri(input.storageUri, client);
    if (client.config.delivery === "public") {
      return {
        kind: "issued",
        downloadUrl: `${client.config.baseUrl}/storage/v1/object/public/${encodePath(client.config.bucketName)}/${encodePath(key)}`,
      };
    }
    const expiresInSeconds =
      input.expiresInSeconds ?? client.config.signedUrlExpiresIn;
    const response = await requireSuccess(
      await client.request(
        `object/sign/${encodePath(client.config.bucketName)}/${encodePath(key)}`,
        {
          body: JSON.stringify({ expiresIn: expiresInSeconds }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: input.signal,
        },
      ),
    );
    return {
      kind: "issued",
      downloadUrl: await readSignedUrl(response, client),
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    };
  },
  async onUnmount() {},
});

export const createSupabaseStorage = (
  config: SupabaseStorageConfig,
  allowedTargets: readonly AllowedTarget[],
): StoragePlugin => {
  let literalClient: SupabaseStorageClient | undefined;
  const getClient = (
    context: StorageOperationContext,
  ): SupabaseStorageClient => {
    if (
      context.target === "functions" ||
      !allowedTargets.includes(context.target)
    ) {
      throw new StoragePluginError(
        "invalid-input",
        `Supabase storage does not support context.target "${context.target}".`,
      );
    }
    if (hasTaggedConfig(config)) {
      return createSupabaseStorageClient(
        resolveSupabaseStorageConfig(config, context),
      );
    }
    literalClient ??= createSupabaseStorageClient(
      resolveSupabaseStorageConfig(config, context),
    );
    return literalClient;
  };

  return createStoragePlugin({
    name: "supabaseStorage",
    protocol: "supabase-storage",
    plugin: () => createImplementation(getClient),
  });
};
