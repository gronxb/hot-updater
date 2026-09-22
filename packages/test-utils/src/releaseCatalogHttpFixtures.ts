import type { StoragePlugin } from "@hot-updater/plugin-core";

export const releaseCatalogDownloadUrl = (uri: string) =>
  `https://storage.example.com/${encodeURIComponent(uri)}`;

export const RELEASE_CATALOG_MANIFEST_URI =
  "storage://test-bucket/302/manifest.json";
export const RELEASE_CATALOG_DOWNLOAD_HASH = "a".repeat(64);

/** Install these storage objects in the test server, independently of its DB. */
export const RELEASE_CATALOG_STORAGE_FIXTURES: Readonly<
  Record<string, string>
> = {
  [RELEASE_CATALOG_MANIFEST_URI]: JSON.stringify({
    bundleId: "00000000-0000-7000-8000-000000000302",
    assets: {
      "index.ios.bundle": {
        fileHash: "target-hbc-hash",
        downloadFileHash: RELEASE_CATALOG_DOWNLOAD_HASH,
        downloadByteSize: 1_000,
      },
    },
  }),
};

/** Storage boundary shared by provider and separately spawned server tests. */
export const createReleaseCatalogTestStorage = (): StoragePlugin => ({
  name: "catalog-test-storage",
  protocol: "storage",
  async get({ storageUri }) {
    const body = RELEASE_CATALOG_STORAGE_FIXTURES[storageUri];
    return { response: body === undefined ? null : new Response(body) };
  },
  async getDownloadUrl({ storageUri }) {
    return { url: releaseCatalogDownloadUrl(storageUri) };
  },
});
