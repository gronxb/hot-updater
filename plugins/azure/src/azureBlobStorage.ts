import { Readable } from "node:stream";

import { isTokenCredential, type TokenCredential } from "@azure/core-auth";
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  RestError,
  StorageSharedKeyCredential,
  type UserDelegationKey,
} from "@azure/storage-blob";
import {
  createStorageAdapter,
  createStorageKeyBuilder,
  createStorageUri,
  parseStorageUri,
  type StorageAdapter,
  type StorageAdapterWith,
  type StorageObject,
} from "@hot-updater/plugin-core";

/** The account to connect to: its connection string, or its Blob endpoint and a credential. */
export type AzureBlobConnection =
  | { readonly connectionString: string }
  | {
      /** The Blob service endpoint, such as `https://<account>.blob.core.windows.net`. */
      readonly accountUrl: string;
      /** An account key, or a Microsoft Entra identity such as `DefaultAzureCredential`. */
      readonly credential: StorageSharedKeyCredential | TokenCredential;
    };

export type AzureBlobStorageConfig = AzureBlobConnection & {
  /** The Blob container that keeps the bundles. */
  readonly containerName: string;
  /** Base path where bundles will be stored in the container. */
  readonly basePath?: string;
  /**
   * The URL devices download an object from, such as a CDN's. Without it, a
   * read-only SAS URL that expires in an hour.
   */
  readonly getDownloadUrl?: StorageAdapter["getDownloadUrl"];
};

type AzureBlobStorageOperations =
  | "put"
  | "get"
  | "getDownloadUrl"
  | "exists"
  | "delete"
  | "listObjects"
  | "deleteObjects";

const PROTOCOL = "azblob";

/** Devices download right after the update check that returns the URL. */
const SAS_EXPIRES_IN_MS = 60 * 60 * 1000;

/** A user delegation key signs SAS URLs for up to seven days; it is renewed well before. */
const DELEGATION_KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;

const isNotFound = (error: unknown) =>
  error instanceof RestError && error.statusCode === 404;

const serviceOf = (config: AzureBlobStorageConfig): BlobServiceClient =>
  "connectionString" in config
    ? BlobServiceClient.fromConnectionString(config.connectionString)
    : new BlobServiceClient(config.accountUrl, config.credential);

/**
 * Bundles in an Azure Blob Storage container. Without `getDownloadUrl`,
 * devices download through SAS URLs: signed with the account key when the
 * connection has one, otherwise with a user delegation key, which needs the
 * identity's Storage Blob Delegator role.
 */
export function azureBlobStorage(
  config: AzureBlobStorageConfig,
): StorageAdapterWith<AzureBlobStorageOperations> {
  const { containerName, basePath, getDownloadUrl } = config;
  const service = serviceOf(config);
  const container = service.getContainerClient(containerName);
  const normalizedBasePath = basePath?.replace(/^\/+|\/+$/g, "") ?? "";
  const getStorageKey = createStorageKeyBuilder(normalizedBasePath);

  const getListPrefix = (prefix = "") => {
    const value = [normalizedBasePath, prefix.replace(/^\/+|\/+$/g, "")]
      .filter(Boolean)
      .join("/");
    return value ? `${value}/` : "";
  };

  const getRelativeKey = (key: string) => {
    const basePrefix = `${normalizedBasePath}/`;
    return normalizedBasePath && key.startsWith(basePrefix)
      ? key.slice(basePrefix.length)
      : key;
  };

  /** The URI `put` returns for the key, or null for a key no `put` writes. */
  const getListedStorageUri = (key: string) => {
    try {
      return createStorageUri({
        bucket: containerName,
        key,
        protocol: PROTOCOL,
      });
    } catch {
      return null;
    }
  };

  const parseAndValidate = (storageUri: string) => {
    const parsed = parseStorageUri(storageUri, PROTOCOL);
    if (parsed.bucket !== containerName) {
      throw new Error(
        `Container name mismatch: expected "${containerName}", but found "${parsed.bucket}".`,
      );
    }
    return parsed;
  };

  let delegation:
    | { readonly key: Promise<UserDelegationKey>; readonly renewAt: number }
    | undefined;
  const delegationKey = () => {
    const now = Date.now();
    if (delegation === undefined || delegation.renewAt <= now) {
      const key = service.getUserDelegationKey(
        new Date(now - 5 * 60 * 1000),
        new Date(now + DELEGATION_KEY_LIFETIME_MS),
      );
      // A failed request is asked again next time.
      key.catch(() => {
        delegation = undefined;
      });
      delegation = {
        key,
        renewAt: now + DELEGATION_KEY_LIFETIME_MS - SAS_EXPIRES_IN_MS,
      };
    }
    return delegation.key;
  };

  const signedUrl = async (key: string) => {
    const blob = container.getBlobClient(key);
    const expiresOn = new Date(Date.now() + SAS_EXPIRES_IN_MS);
    const permissions = BlobSASPermissions.parse("r");
    if (blob.credential instanceof StorageSharedKeyCredential) {
      return blob.generateSasUrl({ permissions, expiresOn });
    }
    if (!isTokenCredential(blob.credential)) {
      // A SAS connection string signs every request with its own token,
      // which devices must not receive.
      throw new Error(
        "azureBlobStorage signs download URLs with an account key or a Microsoft Entra credential; a SAS connection string has neither. Pass getDownloadUrl, or connect with the account key.",
      );
    }
    const sas = generateBlobSASQueryParameters(
      { containerName, blobName: key, permissions, expiresOn },
      await delegationKey(),
      blob.accountName,
    );
    return `${blob.url}?${sas.toString()}`;
  };

  return createStorageAdapter({
    name: "azureBlobStorage",
    protocol: PROTOCOL,
    async listObjects(prefix) {
      const objects: StorageObject[] = [];
      for await (const blob of container.listBlobsFlat({
        prefix: getListPrefix(prefix),
      })) {
        const storageUri = getListedStorageUri(blob.name);
        if (storageUri === null) continue;
        objects.push({
          key: getRelativeKey(blob.name),
          lastModifiedAt: blob.properties.lastModified,
          size: blob.properties.contentLength ?? 0,
          storageUri,
        });
      }
      return objects;
    },
    async deleteObjects(relativeKeys) {
      const keys = relativeKeys.map((key) => getStorageKey(key));
      // A batch request takes 256 subrequests.
      for (let offset = 0; offset < keys.length; offset += 256) {
        const batch = keys.slice(offset, offset + 256);
        if (batch.length === 0) continue;
        const response = await container
          .getBlobBatchClient()
          .deleteBlobs(batch.map((key) => container.getBlobClient(key)));
        const failed = response.subResponses.filter(
          ({ status }) => status >= 300 && status !== 404,
        );
        if (failed.length > 0) {
          throw new Error(`Failed to delete ${failed.length} Azure blob(s).`);
        }
      }
    },
    async put({ key, body, contentType }) {
      const storageKey = getStorageKey(key);
      // Bundles fit in memory, as the CLI that uploads them builds them there.
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      await container.getBlockBlobClient(storageKey).uploadData(bytes, {
        blobHTTPHeaders: {
          blobContentType: contentType,
          blobCacheControl: "max-age=31536000",
        },
      });
      return {
        storageUri: createStorageUri({
          bucket: containerName,
          key: storageKey,
          protocol: PROTOCOL,
        }),
      };
    },
    async get({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      try {
        const download = await container.getBlobClient(key).download();
        const body = download.readableStreamBody;
        if (body === undefined) return { response: null };
        const headers = new Headers();
        if (download.contentType) {
          headers.set("content-type", download.contentType);
        }
        if (download.contentLength !== undefined) {
          headers.set("content-length", String(download.contentLength));
        }
        return {
          response: new Response(
            Readable.toWeb(body as Readable) as ReadableStream,
            { headers },
          ),
        };
      } catch (error) {
        if (isNotFound(error)) return { response: null };
        throw error;
      }
    },
    async getDownloadUrl({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      if (getDownloadUrl) return getDownloadUrl({ storageUri });
      return { url: await signedUrl(key) };
    },
    async exists({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      return { exists: await container.getBlobClient(key).exists() };
    },
    async delete({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      await container.getBlobClient(key).deleteIfExists();
      return { deleted: true };
    },
  });
}
