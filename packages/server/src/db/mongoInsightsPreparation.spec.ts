import type { MongoClient } from "mongodb";
import { describe, expect, it, vi } from "vitest";

import { createBundleEventRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { mongoAdapter } from "../adapters/mongodb";
import { createMongoTestHarness } from "../adapters/mongodbTestClient";
import { createMongoInsightsPreparation } from "./mongoInsightsPreparation";
import { createMongoInsightsSource } from "./mongoInsightsSource";

describe("MongoDB Insights event write fence", () => {
  it("loads generic DB tooling without loading the optional MongoDB peer", async () => {
    vi.resetModules();
    const loadMongo = vi.fn(() => {
      throw new Error("MongoDB peer is not installed");
    });
    vi.doMock("mongodb", loadMongo);
    try {
      const db = await import("./index");
      expect(typeof db.createMongoInsightsPreparation).toBe("function");
      expect(typeof db.createMongoInsightsSource).toBe("function");
      expect(loadMongo).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("mongodb");
      vi.resetModules();
    }
  });

  it.each([
    { id: "old-unordered-event" },
    { id: "10000000-0000-0000-0000-00000000000A" },
    { id: "10000000-0000-4000-8000-000000000010" },
    { install_id: "invalid\ud800" },
    { received_at_ms: 1.5 },
    { received_at_ms: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid event appends before I/O: %j", async (change) => {
    const harness = createMongoTestHarness();
    const database = mongoAdapter({
      client: harness.client,
      transactions: true,
    });
    const event = { ...createBundleEventRowFixture("10", 50), ...change };
    try {
      await expect(
        database.models.insights.append(event),
      ).rejects.toMatchObject({ code: "invalid-data" });
      expect(harness.getOperationCount()).toBe(0);
      expect(
        await harness.client.db().collection("bundle_events").countDocuments(),
      ).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("validates maintenance acknowledgement and hard budgets before making requests", async () => {
    const collection = vi.fn(() => ({}));
    const createCollection = vi.fn();
    const listCollections = vi.fn();
    const db = vi.fn(() => ({ collection, createCollection, listCollections }));
    const client = { db } as unknown as MongoClient;
    const tools = createMongoInsightsPreparation(client);
    expect(db).toHaveBeenCalledWith(undefined, {
      readPreference: "primary",
      readConcern: { level: "local" },
      writeConcern: { w: "majority" },
    });
    await expect(
      tools.prepare({ writersDrained: false } as never),
    ).rejects.toMatchObject({ code: "invalid-query" });
    for (const input of [
      { maxItems: 1, maxRequests: 4 },
      { maxItems: 201, maxRequests: 4 },
      { maxItems: 2, maxRequests: 3 },
      { maxItems: 2.5, maxRequests: 4 },
    ])
      await expect(tools.runStep(input)).rejects.toMatchObject({
        code: "invalid-query",
      });
    expect(createCollection).not.toHaveBeenCalled();
    expect(listCollections).not.toHaveBeenCalled();
  });

  it("rejects invalid source preparation, step, and page budgets before I/O", async () => {
    const collection = vi.fn(() => ({}));
    const db = vi.fn(() => ({ collection }));
    const client = { db } as unknown as MongoClient;
    const source = createMongoInsightsSource(client);
    await expect(
      source.prepare({ writersDrained: false } as never),
    ).rejects.toMatchObject({ code: "invalid-query" });
    for (const input of [
      { maxItems: 1, maxRequests: 13 },
      { maxItems: 201, maxRequests: 13 },
      { maxItems: 2, maxRequests: 12 },
      { maxItems: 2, maxRequests: 1001 },
    ])
      await expect(source.runStep(input)).rejects.toMatchObject({
        code: "invalid-query",
      });
    await expect(
      source.readPage({
        sourceGeneration: "not-a-generation",
        shard: 0,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    expect(collection).toHaveBeenCalledTimes(6);
  });
});
