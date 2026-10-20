import { describe, expect, it } from "vitest";

import { azureBlobStorage } from "./azureBlobStorage";

describe("azureBlobStorage", () => {
  it("connects on first use, so a config loads without the connection string", async () => {
    const storage = azureBlobStorage({
      connectionString: undefined as never,
      containerName: "bundles",
    });

    await expect(
      storage.exists({ storageUri: "azure-blob://bundles/key" }),
    ).rejects.toThrow();
  });
});

describe("azureBlobStorage download URLs", () => {
  it("refuses to hand devices a SAS connection string's own token", async () => {
    const storage = azureBlobStorage({
      connectionString:
        "BlobEndpoint=https://account.blob.core.windows.net;SharedAccessSignature=sv=2024-11-04&ss=b&srt=sco&sp=rwdlac&se=2099-01-01T00:00:00Z&sig=c2lnbmF0dXJl",
      containerName: "hot-updater",
    });
    await expect(
      storage.getDownloadUrl({
        storageUri: "azblob://hot-updater/bundles/manifest.json",
      }),
    ).rejects.toThrow("a SAS connection string has neither");
  });

  it("serves the configured download URL without signing", async () => {
    const storage = azureBlobStorage({
      connectionString:
        "BlobEndpoint=https://account.blob.core.windows.net;SharedAccessSignature=sv=2024-11-04&sig=c2lnbmF0dXJl",
      containerName: "hot-updater",
      getDownloadUrl: async ({ storageUri }) => ({
        url: `https://cdn.example.com/${new URL(storageUri).pathname}`,
      }),
    });
    await expect(
      storage.getDownloadUrl({
        storageUri: "azblob://hot-updater/bundles/manifest.json",
      }),
    ).resolves.toEqual({
      url: "https://cdn.example.com//bundles/manifest.json",
    });
  });
});
