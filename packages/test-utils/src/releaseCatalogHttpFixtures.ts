import type { ArtifactInfo } from "@hot-updater/core";
import type { BundleRow, StoragePlugin } from "@hot-updater/plugin-core";

import { createBundleRowFixture } from "./databaseTestFixtures";

export const releaseCatalogDownloadUrl = (uri: string) =>
  `https://storage.example.com/${encodeURIComponent(uri)}`;

const targetId = createBundleRowFixture("302").id;
export const RELEASE_CATALOG_MANIFEST_URIS = {
  small: `storage://test-bucket/small/bundles/${targetId}/manifest.json`,
  large: `storage://test-bucket/large/bundles/${targetId}/manifest.json`,
};
export const RELEASE_CATALOG_DOWNLOAD_HASH = "a".repeat(64);

const manifestAssets = {
  "index.ios.bundle": {
    fileHash: "target-hbc-hash",
    downloadFileHash: RELEASE_CATALOG_DOWNLOAD_HASH,
    downloadByteSize: 1_000,
  },
};

export const releaseCatalogArtifact = (bundle: BundleRow): ArtifactInfo => ({
  artifactProtocolVersion: 1,
  manifestUrl: releaseCatalogDownloadUrl(bundle.manifest_storage_uri),
  manifestFileHash: bundle.manifest_file_hash,
  assets: {
    "index.ios.bundle": {
      fileHash: "target-hbc-hash",
      file: {
        compression: "br",
        url: releaseCatalogDownloadUrl(
          `${bundle.asset_base_storage_uri}/sha256/aa/${RELEASE_CATALOG_DOWNLOAD_HASH}.br`,
        ),
      },
    },
  },
});

/** Install these storage objects in the test server, independently of its DB. */
export const RELEASE_CATALOG_STORAGE_FIXTURES: Readonly<
  Record<string, string>
> = Object.fromEntries(
  Object.entries(RELEASE_CATALOG_MANIFEST_URIS).map(([size, uri]) => [
    uri,
    JSON.stringify({
      bundleId: targetId,
      assets: manifestAssets,
      archive: {
        downloadFileHash: "b".repeat(64),
        downloadByteSize: size === "small" ? 1 : 10_000,
        tarByteSize: 20_000,
      },
    }),
  ]),
);

/** Storage boundary shared by provider and separately spawned server tests. */
export const createReleaseCatalogTestStorage = (): StoragePlugin => ({
  name: "catalog-test-storage",
  protocol: "storage",
  async get({ storageUri }) {
    const suffix = /^storage:\/\/bundles\/([^/]+)\/manifest\.json$/.exec(
      storageUri,
    )?.[1];
    const body =
      RELEASE_CATALOG_STORAGE_FIXTURES[storageUri] ??
      (suffix === undefined
        ? undefined
        : JSON.stringify({
            bundleId: createBundleRowFixture(suffix).id,
            assets: manifestAssets,
          }));
    return { response: body === undefined ? null : new Response(body) };
  },
  async getDownloadUrl({ storageUri }) {
    return { url: releaseCatalogDownloadUrl(storageUri) };
  },
});
