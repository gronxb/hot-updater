import {
  BlobServiceClient,
  ContainerClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import {
  type BlobDatabasePluginConfig,
  createBlobDatabasePlugin,
} from "@hot-updater/plugin-core";
import mime from "mime";

export interface AzureBlobDatabaseConfig extends BlobDatabasePluginConfig {
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
   * Name of the Azure Blob container where metadata is stored.
   */
  containerName: string;
  /**
   * API base path for CDN invalidation path construction.
   * @default "/api/check-update"
   */
  apiBasePath?: string;
}

function createContainerClient(
  config: AzureBlobDatabaseConfig,
): ContainerClient {
  if (config.connectionString) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      config.connectionString,
    );
    return blobServiceClient.getContainerClient(config.containerName);
  }

  if (!config.accountName || !config.accountKey) {
    throw new Error(
      "Azure Blob Database: either connectionString or both accountName and accountKey are required.",
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

  return blobServiceClient.getContainerClient(config.containerName);
}

async function streamToBuffer(
  readableStream: NodeJS.ReadableStream,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    readableStream.on("data", (data: Buffer) => chunks.push(data));
    readableStream.on("end", () => resolve(Buffer.concat(chunks)));
    readableStream.on("error", reject);
  });
}

async function loadJsonFromAzure<T>(
  containerClient: ContainerClient,
  key: string,
): Promise<T | null> {
  try {
    const blobClient = containerClient.getBlobClient(key);
    const response = await blobClient.download(0);
    if (!response.readableStreamBody) return null;
    const body = await streamToBuffer(response.readableStreamBody);
    return JSON.parse(body.toString("utf-8")) as T;
  } catch (e: any) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

async function uploadJsonToAzure<T>(
  containerClient: ContainerClient,
  key: string,
  data: T,
): Promise<void> {
  const body = JSON.stringify(data);
  const contentType = mime.getType(key) ?? "application/json";
  const blockBlobClient = containerClient.getBlockBlobClient(key);
  await blockBlobClient.upload(body, Buffer.byteLength(body), {
    blobHTTPHeaders: {
      blobContentType: contentType,
      blobCacheControl: "max-age=31536000",
    },
  });
}

async function listObjectsInAzure(
  containerClient: ContainerClient,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  const iter = containerClient.listBlobsFlat({ prefix });
  for await (const blob of iter) {
    keys.push(blob.name);
  }
  return keys;
}

async function deleteObjectInAzure(
  containerClient: ContainerClient,
  key: string,
): Promise<void> {
  const blobClient = containerClient.getBlobClient(key);
  await blobClient.delete();
}

export const azureBlobDatabase = createBlobDatabasePlugin<AzureBlobDatabaseConfig>({
  name: "azureBlobDatabase",
  factory: (config) => {
    const { apiBasePath = "/api/check-update" } = config;
    const containerClient = createContainerClient(config);

    return {
      apiBasePath,
      listObjects: (prefix: string) =>
        listObjectsInAzure(containerClient, prefix),
      loadObject: <T>(key: string) =>
        loadJsonFromAzure<T>(containerClient, key),
      uploadObject: <T>(key: string, data: T) =>
        uploadJsonToAzure(containerClient, key, data),
      deleteObject: (key: string) =>
        deleteObjectInAzure(containerClient, key),
      invalidatePaths: (_paths: string[]) => {
        // Azure CDN invalidation can be added here if needed.
        // For now, this is a no-op. Users can integrate Azure CDN purge
        // via @azure/arm-cdn if cache invalidation is required.
        return Promise.resolve();
      },
    };
  },
});
