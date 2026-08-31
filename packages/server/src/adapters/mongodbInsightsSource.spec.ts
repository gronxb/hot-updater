import { Long, ObjectId } from "mongodb";
import { afterEach, describe, expect, it } from "vitest";

import {
  createBundleEventRowFixture,
  createBundlePatchRowFixture,
  createBundleRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import { mongoAdapter } from "./mongodb";
import { mongoInsightsSourceShard } from "./mongodbInsightsSource";
import {
  MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
  MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION,
  MONGO_INSIGHTS_SOURCE_STATE_COLLECTION,
} from "./mongodbInsightsSourceSchema";
import { createMongoTestHarness } from "./mongodbTestClient";

describe("MongoDB committed Insights source writes", () => {
  const harnesses: ReturnType<typeof createMongoTestHarness>[] = [];
  const setup = () => {
    const harness = createMongoTestHarness();
    harnesses.push(harness);
    const database = mongoAdapter({
      client: harness.client,
      transactions: true,
    });
    return { database, harness };
  };

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(({ close }) => close()));
  });

  it("commits the raw event, shard clock, and one-ID ledger together", async () => {
    const { database, harness } = setup();
    const event = createBundleEventRowFixture("801", 100);

    await database.models.insights.append(event);

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
      rawId: raw?._id,
      sequence: Long.ONE,
    });
    expect(clock?.value).toEqual(Long.ONE);
  });

  it("rejects an unprepared database without leaving a raw event", async () => {
    const { database, harness } = setup();
    const db = harness.client.db();
    await db.collection(MONGO_INSIGHTS_SOURCE_STATE_COLLECTION).deleteMany({});

    await expect(
      database.models.insights.append(createBundleEventRowFixture("802", 100)),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
    expect(await db.collection("bundle_events").countDocuments()).toBe(0);
    expect(
      await db
        .collection(MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION)
        .countDocuments(),
    ).toBe(0);
  });

  it("rolls back source state when a later mixed mutation fails", async () => {
    const { database, harness } = setup();
    const event = createBundleEventRowFixture("803", 100);
    const bundle = createBundleRowFixture("803");
    const missingReference = createBundlePatchRowFixture("803", "900", "901");

    await expect(
      database.commit({
        changes: [
          { model: "bundles", operation: "insert", row: bundle },
          { model: "insights", operation: "insert", row: event },
          {
            model: "bundlePatches",
            operation: "insert",
            row: missingReference,
          },
        ],
      }),
    ).rejects.toThrow("references a missing bundle");

    const db = harness.client.db();
    expect(await db.collection("bundles").countDocuments()).toBe(0);
    expect(await db.collection("bundle_events").countDocuments()).toBe(0);
    expect(
      await db
        .collection(MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION)
        .countDocuments(),
    ).toBe(0);
    const clock = await db
      .collection<{ _id: number; value: Long }>(
        MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
      )
      .findOne({ _id: mongoInsightsSourceShard(event.id) });
    expect(clock?.value).toEqual(Long.ZERO);
  });

  it("rolls back a duplicate event's raw row and clock increment", async () => {
    const { database, harness } = setup();
    const event = createBundleEventRowFixture("804", 100);
    await database.models.insights.append(event);

    await expect(database.models.insights.append(event)).rejects.toThrow(
      "duplicate id",
    );

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
