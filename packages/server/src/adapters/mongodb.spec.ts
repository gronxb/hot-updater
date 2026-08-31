import { createDatabaseClient } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { setupDatabasePluginTestSuite } from "../../../test-utils/src/setupDatabasePluginTestSuite";
import { mongoAdapter } from "./mongodb";
import { createMongoBundleWhere } from "./mongodbQuery";
import { createMongoTestHarness } from "./mongodbTestClient";

const harness = createMongoTestHarness();

setupDatabasePluginTestSuite({
  name: "mongoAdapter v2",
  migrate: () => undefined,
  createPlugin: () =>
    mongoAdapter({ client: harness.client, transactions: true }),
  reset: () => harness.reset(),
  dispose: () => harness.close(),
});

describe("mongoAdapter capabilities", () => {
  it("requires the transaction-capable adapter", () => {
    const plugin = mongoAdapter({ client: harness.client, transactions: true });
    expect(plugin.name).toBe("mongodb");
    expect(plugin.adapterName).toBe("mongodb");
    expect(plugin.provider).toBe("mongodb");
    expect(Reflect.has(plugin, "transaction")).toBe(false);
    expect(() =>
      mongoAdapter({
        client: harness.client,
        transactions: false,
      } as never),
    ).toThrow("requires replica-set or sharded-cluster transactions");
  });

  it("recovers a tombstoned bundle when an aggregate delete is retried", async () => {
    harness.reset();
    const client = createDatabaseClient(
      mongoAdapter({ client: harness.client, transactions: true }),
    );
    const bundle = {
      id: "bundle-retry",
      platform: "ios" as const,
      fileHash: "bundle-retry-hash",
      gitCommitHash: null,
      storageUri: "storage://bundle-retry",
      archiveByteSize: 3_000_000_001,
    };
    await client.insertBundle(bundle);

    harness.failNextBundleTombstone();
    await expect(client.deleteBundleById(bundle.id)).rejects.toThrow(
      "injected tombstone failure",
    );
    await expect(client.deleteBundleById(bundle.id)).resolves.toBeUndefined();
    await expect(client.insertBundle(bundle)).resolves.toBeUndefined();
    await expect(client.getBundleById(bundle.id)).resolves.toMatchObject({
      id: bundle.id,
      fileHash: bundle.fileHash,
      storageUri: bundle.storageUri,
    });
  });
});

describe("MongoDB low-level predicate translation", () => {
  it("composes connectors left to right", () => {
    expect(
      createMongoBundleWhere([
        { field: "id", value: "first" },
        { field: "id", value: "second", connector: "OR" },
        { field: "platform", value: "ios", connector: "AND" },
      ]),
    ).toEqual({
      $and: [
        {
          $or: [
            { $expr: { $eq: ["$id", { $literal: "first" }] } },
            { $expr: { $eq: ["$id", { $literal: "second" }] } },
          ],
        },
        { $expr: { $eq: ["$platform", { $literal: "ios" }] } },
      ],
    });
  });

  it("escapes insensitive string patterns", () => {
    expect(
      createMongoBundleWhere([
        {
          field: "storage_uri",
          operator: "contains",
          value: "release.*",
          mode: "insensitive",
        },
      ]),
    ).toEqual({
      $expr: {
        $regexMatch: {
          input: { $ifNull: ["$storage_uri", ""] },
          regex: { $literal: "release\\.\\*" },
          options: "i",
        },
      },
    });
  });

  it("preserves empty set semantics", () => {
    expect(
      createMongoBundleWhere([{ field: "id", operator: "in", value: [] }]),
    ).toEqual({ $expr: { $in: ["$id", { $literal: [] }] } });
    expect(
      createMongoBundleWhere([{ field: "id", operator: "not_in", value: [] }]),
    ).toEqual({
      $expr: { $not: [{ $in: ["$id", { $literal: [] }] }] },
    });
  });
});
