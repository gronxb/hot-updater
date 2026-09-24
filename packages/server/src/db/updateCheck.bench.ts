import { encodeChannelKey } from "@hot-updater/core";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { bench, describe } from "vitest";

import { createHotUpdater } from "../index";

const hotUpdater = createHotUpdater({
  database: { name: "bench", adapter: createMemoryAdapter() },
  clientAccess: "public",
});
await hotUpdater.core.deploy([
  {
    bundle: {
      id: "01900000-0000-7000-8000-000000000001",
      platform: "ios",
      gitCommitHash: null,
      manifestStorageUri: "s3://bench/bundles/1/manifest.json",
      manifestFileHash: "manifest-hash",
      assetBaseStorageUri: "s3://bench/assets",
    },
    release: {
      channel: "production",
      enabled: true,
      fingerprintHash: null,
      message: null,
      shouldForceUpdate: false,
      targetAppVersion: "*",
    },
  },
]);
const url =
  `https://updates.example.com/release-catalogs/app-version/` +
  `ios/${encodeChannelKey("production")}/1.0.0`;

describe("update check benchmark", () => {
  bench(
    "catalog update check on the storage engine",
    async () => {
      const response = await hotUpdater.handlers.client(new Request(url));
      if (response.status !== 200) {
        throw new Error(`Expected 200 response, received ${response.status}.`);
      }
      await response.text();
    },
    { iterations: 20, warmupIterations: 5 },
  );
});
