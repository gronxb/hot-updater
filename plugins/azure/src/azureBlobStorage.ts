import fs from "fs/promises";
import path from "path";

import {
  BlobSASPermissions,
  BlobServiceClient,
  ContainerClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import {
  createStorageKeyBuilder,
  createStoragePlugin,
  getContentType,
  parseStorageUri,
} from "@hot-updater/plugin-core";

export interface AzureBlobStorageConfig {
  /**
   * Azure Storage connection string. If provided, takes precedence over
   * accountName/accountKey.
   */
  connectionString?: string;
  /**
   * Azure Storage account name. Required when connectionString is not provided.
   */
  accountName?: string;
  /**
   * Azure Storage account key. Required when connectionString is not provided.
   */
  accountKey?: string;
  /**
   * Name of the Azure Blob container where bundles are stored.
   */
  containerName: string;
  /**
   * Base path where bundles will be stored in the container.
   */
  basePath?: string;
  /**
   * Optional CDN domain for asset delivery (e.g. "https://cdn.example.com").
   * When set, getDownloadUrl returns a CDN URL instead of a SAS token URL.
   */
  cdnDomain?: string;
  /**
   * SAS token expiry in seconds. Defaults to 3600 (1 hour).
   */
  sasExpirySeconds?: number;
}

function createContainerClient(
  config: AzureBlobStorageConfig,
): {
  containerClient: ContainerClient;
  sharedKeyCredential: StorageSharedKeyCredential | null;
} {
  if (config.connectionString) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      config.connectionString,
    );
    return {
      containerClient: blobServiceClient.getContainerClient(
        config.containerName,
      ),
      sharedKeyCredential: null,
    };
  }

  if (!config.accountName || !config.accountKey) {
    throw new Error(
      "Azure Blob Storage: either connectionString or both accountName and accountKey are required.",
    );
  }

  const sharedKeyCredential = new StorageSharedKeyCredential(
    config.accountName,
    config.accountKey,
  );
  const blobServiceClient = new BlobServiceClient(
    `https://${config.accountName}.blob.core.windows.net`,
    sharedKeyCredential,
  );

  return {
    containerClient: blobServiceClient.getContainerClient(
      config.containerName,
    ),
    sharedKeyCredential,
  };
}

export const AZURE_BLOB_PROTOCOL = "azure-blob";

export const azureBlobStorage = createStoragePlugin<AzureBlobStorageConfig>({
  name: "azureBlobStorage",
  supportedProtocol: AZURE_BLOB_PROTOCOL,
  factory: (config) => {
    const { containerClient, sharedKeyCredential } =
      createContainerClient(config);
    const getStorageKey = createStorageKeyBuilder(config.basePath);
    const sasExpirySeconds = config.sasExpirySeconds ?? 3600;

    return {
      async upload(key, filePath) {
        const Body = await fs.readFile(filePath);
        const contentType = getContentType(filePath);
        const filename = path.basename(filePath);
        const blobKey = getStorageKey(key, filename);

        const blockBlobClient = containerClient.getBlockBlobClient(blobKey);
        await blockBlobClient.upload(Body, Body.length, {
          blobHTTPHeaders: {
            blobContentType: contentType,
            blobCacheControl: "max-age=31536000",
          },
        });

        return {
          storageUri: `${AZURE_BLOB_PROTOCOL}://${config.containerName}/${blobKey}`,
        };
      },

      async delete(storageUri) {
        const { bucket, key } = parseStorageUri(
          storageUri,
          AZURE_BLOB_PROTOCOL,
        );
        if (bucket !== config.containerName) {
          throw new Error(
            `Container name mismatch: expected "${config.containerName}", but found "${bucket}".`,
          );
        }

        const iter = containerClient.listBlobsFlat({ prefix: key });
        const blobsToDelete: string[] = [];
        for await (const blob of iter) {
          blobsToDelete.push(blob.name);
        }

        if (blobsToDelete.length === 0) {
          throw new Error("Bundle Not Found");
        }

        await Promise.all(
          blobsToDelete.map((name) =>
            containerClient.getBlockBlobClient(name).delete(),
          ),
        );
      },

      async getDownloadUrl(storageUri: string) {
        const u = new URL(storageUri);
        if (u.protocol.replace(":", "") !== AZURE_BLOB_PROTOCOL) {
          throw new Error(
            `Invalid Azure Blob storage URI protocol: ${u.protocol}`,
          );
        }
        const container = u.host;
        const key = u.pathname.slice(1);
        if (!container || !key) {
          throw new Error(
            "Invalid Azure Blob storage URI: missing container or key",
          );
        }

        if (config.cdnDomain) {
          const cdnBase = config.cdnDomain.replace(/\/$/, "");
          return { fileUrl: `${cdnBase}/${key}` };
        }

        if (!sharedKeyCredential) {
          throw new Error(
            "SAS token generation requires accountName and accountKey (not connectionString).",
          );
        }

        const startsOn = new Date();
        const expiresOn = new Date(
          startsOn.getTime() + sasExpirySeconds * 1000,
        );

        const sasToken = generateBlobSASQueryParameters(
          {
            containerName: config.containerName,
            blobName: key,
            permissions: BlobSASPermissions.parse("r"),
            startsOn,
            expiresOn,
          },
          sharedKeyCredential,
        ).toString();

        const blobClient = containerClient.getBlockBlobClient(key);
        return { fileUrl: `${blobClient.url}?${sasToken}` };
      },
    };
  },
});
