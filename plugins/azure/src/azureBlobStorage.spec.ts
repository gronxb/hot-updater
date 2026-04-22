import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AZURE_BLOB_PROTOCOL, azureBlobStorage } from "./azureBlobStorage";

const mockUpload = vi.fn();
const mockDelete = vi.fn();
const mockListBlobsFlat = vi.fn();
const mockGetBlockBlobClient = vi.fn();
const mockGetBlobClient = vi.fn();

const createMockContainerClient = () => ({
  getBlockBlobClient: mockGetBlockBlobClient,
  getBlobClient: mockGetBlobClient,
  listBlobsFlat: mockListBlobsFlat,
});

vi.mock("@azure/storage-blob", () => {
  return {
    BlobServiceClient: class {
      static fromConnectionString() {
        return {
          getContainerClient: () => createMockContainerClient(),
        };
      }
      constructor() {
        return {
          getContainerClient: () => createMockContainerClient(),
        };
      }
    },
    ContainerClient: class {},
    StorageSharedKeyCredential: class {
      accountName: string;
      accountKey: string;
      constructor(accountName: string, accountKey: string) {
        this.accountName = accountName;
        this.accountKey = accountKey;
      }
    },
    BlobSASPermissions: {
      parse: vi.fn(() => "r"),
    },
    generateBlobSASQueryParameters: vi.fn(
      () => ({ toString: () => "sv=2024-01-01&sig=mock-sas-token" }),
    ),
  };
});

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(() => Buffer.from("bundle-content")),
  },
}));

describe("azureBlobStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBlockBlobClient.mockReturnValue({
      upload: mockUpload,
      url: "https://testaccount.blob.core.windows.net/bundles/test-key/bundle.js",
      delete: mockDelete,
    });
    mockGetBlobClient.mockReturnValue({
      delete: mockDelete,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("upload", () => {
    it("uploads a file and returns an azure-blob:// storage URI", async () => {
      mockUpload.mockResolvedValue({});

      const storage = azureBlobStorage({
        connectionString: "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=abc123;EndpointSuffix=core.windows.net",
        containerName: "bundles",
      })();

      const result = await storage.upload("test-key", "/tmp/bundle.js");

      expect(mockGetBlockBlobClient).toHaveBeenCalledWith("test-key/bundle.js");
      expect(mockUpload).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.any(Number),
        expect.objectContaining({
          blobHTTPHeaders: expect.objectContaining({
            blobCacheControl: "max-age=31536000",
          }),
        }),
      );
      expect(result.storageUri).toBe(
        `${AZURE_BLOB_PROTOCOL}://bundles/test-key/bundle.js`,
      );
    });

    it("uploads with basePath prepended to key", async () => {
      mockUpload.mockResolvedValue({});

      const storage = azureBlobStorage({
        connectionString: "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=abc123;EndpointSuffix=core.windows.net",
        containerName: "bundles",
        basePath: "releases",
      })();

      const result = await storage.upload("v1", "/tmp/bundle.js");

      expect(mockGetBlockBlobClient).toHaveBeenCalledWith(
        "releases/v1/bundle.js",
      );
      expect(result.storageUri).toBe(
        `${AZURE_BLOB_PROTOCOL}://bundles/releases/v1/bundle.js`,
      );
    });
  });

  describe("delete", () => {
    it("deletes all blobs matching the prefix from the storage URI", async () => {
      const blobs = [{ name: "test-key/bundle.js" }, { name: "test-key/assets/logo.png" }];
      mockListBlobsFlat.mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const blob of blobs) {
            yield blob;
          }
        },
      });
      mockGetBlockBlobClient.mockReturnValue({ delete: mockDelete });
      mockDelete.mockResolvedValue({});

      const storage = azureBlobStorage({
        connectionString: "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=abc123;EndpointSuffix=core.windows.net",
        containerName: "bundles",
      })();

      await storage.delete(`${AZURE_BLOB_PROTOCOL}://bundles/test-key`);

      expect(mockListBlobsFlat).toHaveBeenCalledWith({ prefix: "test-key" });
      expect(mockDelete).toHaveBeenCalledTimes(2);
    });

    it("throws when no blobs are found for the URI", async () => {
      mockListBlobsFlat.mockReturnValue({
        [Symbol.asyncIterator]: async function* () {},
      });

      const storage = azureBlobStorage({
        connectionString: "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=abc123;EndpointSuffix=core.windows.net",
        containerName: "bundles",
      })();

      await expect(
        storage.delete(`${AZURE_BLOB_PROTOCOL}://bundles/nonexistent`),
      ).rejects.toThrow("Bundle Not Found");
    });

    it("throws on container name mismatch", async () => {
      const storage = azureBlobStorage({
        connectionString: "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=abc123;EndpointSuffix=core.windows.net",
        containerName: "bundles",
      })();

      await expect(
        storage.delete(`${AZURE_BLOB_PROTOCOL}://other-container/key`),
      ).rejects.toThrow("Container name mismatch");
    });
  });

  describe("getDownloadUrl", () => {
    it("generates a SAS token URL with accountName/accountKey auth", async () => {
      const { generateBlobSASQueryParameters } = await import(
        "@azure/storage-blob"
      );

      const storage = azureBlobStorage({
        accountName: "testaccount",
        accountKey: "dGVzdGtleQ==",
        containerName: "bundles",
      })();

      const result = await storage.getDownloadUrl(
        `${AZURE_BLOB_PROTOCOL}://bundles/releases/bundle.js`,
      );

      expect(generateBlobSASQueryParameters).toHaveBeenCalledWith(
        expect.objectContaining({
          containerName: "bundles",
          blobName: "releases/bundle.js",
          permissions: "r",
        }),
        expect.any(Object),
      );
      expect(result.fileUrl).toContain("sv=2024-01-01&sig=mock-sas-token");
    });

    it("returns a CDN URL when cdnDomain is configured", async () => {
      const storage = azureBlobStorage({
        accountName: "testaccount",
        accountKey: "dGVzdGtleQ==",
        containerName: "bundles",
        cdnDomain: "https://cdn.example.com",
      })();

      const result = await storage.getDownloadUrl(
        `${AZURE_BLOB_PROTOCOL}://bundles/releases/bundle.js`,
      );

      expect(result.fileUrl).toBe(
        "https://cdn.example.com/releases/bundle.js",
      );
    });

    it("strips trailing slash from cdnDomain", async () => {
      const storage = azureBlobStorage({
        accountName: "testaccount",
        accountKey: "dGVzdGtleQ==",
        containerName: "bundles",
        cdnDomain: "https://cdn.example.com/",
      })();

      const result = await storage.getDownloadUrl(
        `${AZURE_BLOB_PROTOCOL}://bundles/releases/bundle.js`,
      );

      expect(result.fileUrl).toBe(
        "https://cdn.example.com/releases/bundle.js",
      );
    });

    it("throws on invalid protocol", async () => {
      const storage = azureBlobStorage({
        accountName: "testaccount",
        accountKey: "dGVzdGtleQ==",
        containerName: "bundles",
      })();

      await expect(
        storage.getDownloadUrl("s3://bucket/key"),
      ).rejects.toThrow("Invalid Azure Blob storage URI protocol");
    });

    it("throws when using connectionString without accountName/accountKey", async () => {
      const storage = azureBlobStorage({
        connectionString: "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=abc123;EndpointSuffix=core.windows.net",
        containerName: "bundles",
      })();

      await expect(
        storage.getDownloadUrl(
          `${AZURE_BLOB_PROTOCOL}://bundles/releases/bundle.js`,
        ),
      ).rejects.toThrow("SAS token generation requires accountName and accountKey");
    });
  });
});
