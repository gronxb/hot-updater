import {
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_EVENT_MAX_BYTES,
} from "@hot-updater/plugin-core/internal";
import { BSON, Long, ObjectId } from "mongodb";
import { afterEach, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { createMongoInsightsModel } from "./mongodbInsightsModel";
import { mongoInsightsSourceShard } from "./mongodbInsightsSource";
import {
  MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
  MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION,
  MONGO_INSIGHTS_SOURCE_STATE_COLLECTION,
} from "./mongodbInsightsSourceSchema";
import { createMongoTestHarness } from "./mongodbTestClient";

describe("MongoDB committed Insights source writes", () => {
  const databaseNamespace = "00000000-0000-7000-8000-000000000099";
  const harnesses: ReturnType<typeof createMongoTestHarness>[] = [];
  const setup = () => {
    const harness = createMongoTestHarness();
    harnesses.push(harness);
    return {
      harness,
      model: createMongoInsightsModel(harness.client, databaseNamespace),
    };
  };

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(({ close }) => close()));
  });

  it("commits the raw event, shard clock, and one-ID ledger together", async () => {
    const { model, harness } = setup();
    const event = createBundleEventRowFixture("801", 100);

    await model.append(event);

    const db = harness.client.db();
    const [raw] = await db.collection("bundle_events").find({}).toArray();
    const [ledger] = await db
      .collection(MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION)
      .find({})
      .toArray();
    const clock = await db
      .collection<{ _id: number; value: Long }>(
        MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
      )
      .findOne({ _id: mongoInsightsSourceShard(event.id) });
    expect(raw).toMatchObject(event);
    expect(raw?._id).toBeInstanceOf(ObjectId);
    expect(ledger).toMatchObject({
      _id: event.id,
      rawId: BSON.EJSON.stringify(raw?._id, { relaxed: false }),
      sequence: Long.ONE,
    });
    expect(clock?.value).toEqual(Long.ONE);
  });

  it("rejects internal appends until the atomic source writer is ready", async () => {
    const { model, harness } = setup();
    const db = harness.client.db();
    await db.collection(MONGO_INSIGHTS_SOURCE_STATE_COLLECTION).deleteMany({});

    const event = createBundleEventRowFixture("802", 100);
    await expect(model.append(event)).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    expect(await db.collection("bundle_events").findOne({ id: event.id })).toBe(
      null,
    );
    expect(
      await db
        .collection(MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION)
        .countDocuments(),
    ).toBe(0);
  });

  it("rejects an oversized raw event before I/O", async () => {
    const { model, harness } = setup();
    const text = "한".repeat(1024);
    const oversized = {
      ...createBundleEventRowFixture("803", 100),
      type: "UPDATE_APPLIED" as const,
      install_id: text,
      user_id: text,
      username: text,
      from_bundle_id: text,
      from_release_id: text,
      to_bundle_id: text,
      to_release_id: text,
      app_version: text,
      channel: text,
      cohort: text,
      fingerprint_hash: text,
      sdk_version: text,
      update_strategy: "appVersion" as const,
    };
    expect(getCanonicalInsightsJsonByteLength(oversized)).toBeGreaterThan(
      INSIGHTS_EVENT_MAX_BYTES,
    );
    const operations = harness.getOperationCount();
    await expect(model.append(oversized)).rejects.toMatchObject({
      code: "invalid-data",
    });
    expect(harness.getOperationCount()).toBe(operations);
    expect(
      await harness.client.db().collection("bundle_events").countDocuments(),
    ).toBe(0);
  });

  it("rolls back a duplicate event's raw row and clock increment", async () => {
    const { model, harness } = setup();
    const event = createBundleEventRowFixture("804", 100);
    await model.append(event);

    await expect(model.append(event)).rejects.toThrow("duplicate id");

    const db = harness.client.db();
    expect(await db.collection("bundle_events").countDocuments()).toBe(1);
    expect(
      await db
        .collection(MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION)
        .countDocuments(),
    ).toBe(1);
    const clock = await db
      .collection<{ _id: number; value: Long }>(
        MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
      )
      .findOne({ _id: mongoInsightsSourceShard(event.id) });
    expect(clock?.value).toEqual(Long.ONE);
  });
});
