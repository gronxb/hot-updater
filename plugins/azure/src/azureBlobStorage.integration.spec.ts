import { BlobServiceClient } from "@azure/storage-blob";
import { setupStorageAdapterTestSuite } from "@hot-updater/test-utils";
import { afterAll, beforeAll } from "vitest";

import { startAzurite } from "../test-utils/azureEmulators";
import { azureBlobStorage } from "./azureBlobStorage";

const CONTAINER = "hot-updater-conformance";

let azurite: Awaited<ReturnType<typeof startAzurite>> | undefined;

const containerClient = () =>
  BlobServiceClient.fromConnectionString(
    azurite!.connectionString,
  ).getContainerClient(CONTAINER);

beforeAll(async () => {
  azurite = await startAzurite();
  await containerClient().createIfNotExists();
}, 180_000);

afterAll(async () => {
  await azurite?.stop();
});

/** azureBlobStorage on Azurite, each case below a base path of its own. */
setupStorageAdapterTestSuite({
  name: "azureBlobStorage (Azurite)",
  createStorage: async () => {
    const basePath = `conformance/${crypto.randomUUID()}`;
    return {
      storage: azureBlobStorage({
        basePath,
        connectionString: azurite!.connectionString,
        containerName: CONTAINER,
      }),
      basePath,
      cleanup: async () => {
        for await (const blob of containerClient().listBlobsFlat({
          prefix: `${basePath}/`,
        })) {
          await containerClient().deleteBlob(blob.name);
        }
      },
    };
  },
  operations: [
    "put",
    "get",
    "getDownloadUrl",
    "exists",
    "delete",
    "listObjects",
    "deleteObjects",
  ],
  // Azurite answers the SAS URLs.
  fetchDownloadUrls: true,
});
