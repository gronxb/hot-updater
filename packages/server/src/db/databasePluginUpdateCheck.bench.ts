import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  RELEASE_CATALOG_FALLBACK_POLICY,
  RELEASE_CATALOG_SCHEMA_VERSION,
} from "@hot-updater/core";
import {
  createDatabasePlugin,
  type CompiledReleaseCatalog,
  type ReleaseCatalogRow,
} from "@hot-updater/plugin-core";
import { createDatabasePluginAdapter } from "@hot-updater/plugin-core/internal";
import { bench, describe } from "vitest";

import { createHotUpdater } from "../index";

const CATALOG_ID = "bench";
const CHANNEL_KEY = encodeChannelKey("production");
const SCOPE_KEY = createReleaseCatalogScopeKey({
  channelKey: CHANNEL_KEY,
  platform: "ios",
  strategy: "APP_VERSION",
});
const PAYLOAD = JSON.stringify({
  fallbackPolicy: RELEASE_CATALOG_FALLBACK_POLICY,
  releaseDescriptors: [],
  schemaVersion: RELEASE_CATALOG_SCHEMA_VERSION,
  segments: [],
  strategy: "APP_VERSION",
} satisfies CompiledReleaseCatalog);
const CATALOG: ReleaseCatalogRow = {
  catalog_id: CATALOG_ID,
  byte_size: Buffer.byteLength(PAYLOAD),
  catalog_hash: `sha256:${"0".repeat(64)}`,
  channel_id: "channel-production",
  channel_key: CHANNEL_KEY,
  fingerprint_hash: null,
  generation: 1,
  is_tombstone: false,
  payload: PAYLOAD,
  platform: "ios",
  scope_key: SCOPE_KEY,
  strategy: "APP_VERSION",
  updated_at_ms: 1,
};

class BenchmarkMutationError extends Error {
  readonly name = "BenchmarkMutationError";

  constructor() {
    super("The Release Catalog benchmark plugin is read-only.");
  }
}

const name = "release-catalog-benchmark";
const adapter = createDatabasePluginAdapter(name, {
  async appendBundleEvent() {
    throw new BenchmarkMutationError();
  },
  async count() {
    return 0;
  },
  async create() {
    throw new BenchmarkMutationError();
  },
  async delete() {
    throw new BenchmarkMutationError();
  },
  async deleteChannel() {
    throw new BenchmarkMutationError();
  },
  async findMany() {
    return [];
  },
  async findOne(input) {
    return input.model === "release_catalogs" ? CATALOG : null;
  },
  async insertChannel() {
    throw new BenchmarkMutationError();
  },
  async update() {
    throw new BenchmarkMutationError();
  },
});
const database = createDatabasePlugin({
  name,
  commit: adapter.commit,
  models: adapter.models,
});
const hotUpdater = createHotUpdater({
  database,
  clientAccess: { type: "public" },
});
const url =
  `https://updates.example.com/release-catalogs/app-version/` +
  `ios/${CHANNEL_KEY}/1.0.0`;

describe("database plugin update check benchmark", () => {
  bench(
    "fixed-model plugin paged update check",
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
