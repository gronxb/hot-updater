import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/protocol";
import {
  createMemoryKeyValueStore,
  setupKeyOrderTestSuite,
} from "@hot-updater/test-utils";
import { pgliteExecutor, sqliteExecutor } from "@hot-updater/test-utils/node";
import { describe, expect, it } from "vitest";

import { createMemoryAdapter } from "../../database/memoryAdapter";
import {
  compileReleaseCatalogTiling,
  releaseCatalogLookupKey,
} from "../../releaseCatalogTiling";
import { createKvAdapter } from "./kv/kvAdapter";
import { createSqlAdapter } from "./sql/sqlAdapter";

/**
 * `release_catalog_partitions`' byte order on the stores this package
 * implements: the memory adapter, the SQL core's own DDL on SQLite and
 * PGlite, and the key-value kit's sort keys, each under a table prefix.
 */
setupKeyOrderTestSuite({
  name: "memory",
  createAdapter: async () => ({
    adapter: createMemoryAdapter({ tablePrefix: "p_" }),
  }),
});

setupKeyOrderTestSuite({
  name: "sql (SQLite)",
  createAdapter: async ({ table }) => {
    const db = new DatabaseSync(":memory:");
    const adapter = createSqlAdapter({
      executor: sqliteExecutor(db),
      tablePrefix: "p_",
    });
    await adapter.migrations?.apply([table]);
    return { adapter, cleanup: async () => db.close() };
  },
});

setupKeyOrderTestSuite({
  name: "sql (PGlite)",
  createAdapter: async ({ table }) => {
    const db = new PGlite();
    const adapter = createSqlAdapter({
      executor: pgliteExecutor(db),
      tablePrefix: "p_",
    });
    await adapter.migrations?.apply([table]);
    return { adapter, cleanup: () => db.close() };
  },
});

setupKeyOrderTestSuite({
  name: "key-value (in-memory store)",
  // DynamoDB's sort key: 1,024 bytes for the scope key, the epoch, the lower
  // key and their separators.
  maxScopeKeyBytes: 1024 - 36 - 256 - 3,
  createAdapter: async () => ({
    adapter: createKvAdapter({
      store: createMemoryKeyValueStore(),
      tablePrefix: "p_",
    }),
  }),
});

/**
 * MySQL's `ascii_bin` pads with spaces: a key with a byte at or below 0x20
 * after a common prefix sorts out of byte order there (`"a\x1f"` before
 * `"a"`, and `"a "` equals `"a"`). Every key a partition row can hold stays
 * within printable ASCII above the space, so its order is the bytes' order
 * on every database.
 */
describe("release_catalog_partitions keys", () => {
  const printable = /^[\x21-\x7e]*$/u;
  const versions = [
    "0.0.0",
    "1.0.0",
    "1.2.3",
    "10.20.30",
    "9007199254740991.0.0",
    "1.0.0-0",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha-beta.0.x-y-z",
    "1.0.0-rc.9007199254740991",
    "2.0.0-RC.Z.--",
  ];

  it("holds lower keys and lookup keys in printable ASCII above the space", async () => {
    const targets = [
      ...versions,
      "*",
      "1.x",
      "1.2.x",
      ">=1.0.0 <2.0.0",
      "~1.2.3",
      "^1.0.0-beta.2",
      ">1.0.0-rc.1 <=3.0.0",
      "1.0.0 - 2.0.0",
      "<1.0.0 || >=2.0.0-a.b",
    ];
    const rows = await compileReleaseCatalogTiling({
      releases: targets.map((targetAppVersion, at) => ({
        bundleId: `00000000-0000-7001-8000-${String(at).padStart(12, "0")}`,
        channelId: "channel-production",
        createdAtMs: at,
        enabled: true,
        fingerprintHash: null,
        id: `00000000-0000-7000-8000-${String(at).padStart(12, "0")}`,
        kind: "BUNDLE",
        message: null,
        operation: "DEPLOY",
        platform: "ios",
        revision: 1,
        rolloutCohortCount: 1000,
        shouldForceUpdate: false,
        sourceReleaseId: null,
        strategy: "APP_VERSION",
        targetAppVersion,
        targetCohorts: [],
        updatedAtMs: at,
      })),
    });
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThan(targets.length);
    for (const { lowerKey } of rows!) {
      expect(lowerKey).toMatch(printable);
    }
    for (const version of versions) {
      expect(releaseCatalogLookupKey(version)).toMatch(printable);
    }
  });

  it("holds scope keys and epochs in printable ASCII above the space", () => {
    for (const channel of [
      "production",
      "pr 12",
      "beta channel",
      "한국어 채널",
    ]) {
      expect(
        createReleaseCatalogScopeKey({
          platform: "android",
          channelKey: encodeChannelKey(channel),
          strategy: "APP_VERSION",
        }),
      ).toMatch(printable);
    }
    expect(crypto.randomUUID()).toMatch(printable);
  });
});
