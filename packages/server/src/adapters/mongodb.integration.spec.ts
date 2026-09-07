import net from "node:net";
import path from "node:path";

import {
  toInsightsInstallationRow,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import { execa } from "execa";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { mongoAdapter } from "./mongodb";

const availablePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate MongoDB test port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

describe("MongoDB native Insights transactions", () => {
  let client: MongoClient;
  let composeEnvironment: Record<string, string>;
  const composeFile = path.resolve(
    import.meta.dirname,
    "../../../../examples-server/hono-mongodb/docker-compose.yml",
  );
  const compose = (args: string[]) =>
    execa("docker", ["compose", "-f", composeFile, ...args], {
      env: composeEnvironment,
    });
  const insights = () => mongoAdapter({ client }).models.insights;
  const record = (event: BundleEventRow) =>
    insights().record({
      event,
      installation: toInsightsInstallationRow(event),
    });

  beforeAll(async () => {
    const port = await availablePort();
    composeEnvironment = {
      COMPOSE_PROJECT_NAME: `hot-updater-insights-${process.pid}`,
      HOT_UPDATER_E2E_MONGODB_PORT: String(port),
    };
    await compose(["up", "-d", "--wait"]);
    client = new MongoClient(
      `mongodb://127.0.0.1:${port}/insights_native?replicaSet=rs0&directConnection=true`,
    );
    await client.connect();
    const adapter = mongoAdapter({ client });
    await (await adapter.createMigrator!().migrateToLatest()).execute();
  }, 120_000);

  beforeEach(async () => {
    await client.db().collection("bundle_events").deleteMany({});
    await client.db().collection("bundle_installations").deleteMany({});
  });

  afterAll(async () => {
    await client?.close();
    if (composeEnvironment) await compose(["down", "-v", "--remove-orphans"]);
  }, 60_000);

  it("rolls back both canonical changes after a native installation validation error", async () => {
    const previous = {
      ...createBundleEventRowFixture("801", 100),
      user_id: "original",
    };
    await record(previous);
    await client.db().command({
      collMod: "bundle_installations",
      validator: { user_id: { $ne: "reject" } },
    });
    const failed = {
      ...createBundleEventRowFixture("802", 200),
      install_id: previous.install_id,
      user_id: "reject",
    };
    try {
      await expect(record(failed)).rejects.toThrow();
      expect(
        await client.db().collection("bundle_events").countDocuments({}),
      ).toBe(1);
      await expect(
        insights().findInstallations({ installId: previous.install_id }),
      ).resolves.toEqual([toInsightsInstallationRow(previous)]);
    } finally {
      await client
        .db()
        .command({ collMod: "bundle_installations", validator: {} });
    }
    await record(failed);
    await record(failed);
    expect(
      await client.db().collection("bundle_events").countDocuments({}),
    ).toBe(2);
    await expect(
      insights().findInstallations({ installId: previous.install_id }),
    ).resolves.toEqual([toInsightsInstallationRow(failed)]);
  });

  it("retries native conflicts without dropping events or letting duplicate IDs rewrite state", async () => {
    const events = Array.from({ length: 12 }, (_, index) => ({
      ...createBundleEventRowFixture(String(810 + index), 100),
      install_id: "concurrent-installation",
      user_id: index === 11 ? null : "old-user",
    }));
    await Promise.all(events.map(record));
    const winner = events.at(-1)!;
    await Promise.all(Array.from({ length: 4 }, () => record(winner)));
    const conflictingDuplicate = {
      ...events[0]!,
      install_id: "different-installation",
      received_at_ms: 1000,
    };
    await record(conflictingDuplicate);
    expect(
      await client.db().collection("bundle_events").countDocuments({}),
    ).toBe(12);
    await expect(
      insights().findInstallations({ installId: winner.install_id }),
    ).resolves.toEqual([toInsightsInstallationRow(winner)]);
    await expect(
      insights().findInstallations({
        installId: conflictingDuplicate.install_id,
      }),
    ).resolves.toEqual([]);
    await expect(
      insights().findInstallations({ userId: "old-user", limit: 10 }),
    ).resolves.toEqual([]);
  });

  it("accepts concurrent retries of a previously unseen event ID exactly once", async () => {
    const event = createBundleEventRowFixture("825", 100);
    await Promise.all(Array.from({ length: 12 }, () => record(event)));
    expect(
      await client.db().collection("bundle_events").countDocuments({}),
    ).toBe(1);
    await expect(
      insights().findInstallations({ installId: event.install_id }),
    ).resolves.toEqual([toInsightsInstallationRow(event)]);
  });

  it("uses raw recovery predicates consistently in native counts and indexed lists", async () => {
    const applied = createBundleEventRowFixture("831", 100);
    const recovered: BundleEventRow = {
      ...createBundleEventRowFixture("832", 200),
      type: "RECOVERED",
      update_strategy: "appVersion",
      install_id: applied.install_id,
      from_bundle_id: applied.to_bundle_id,
      to_bundle_id: applied.from_bundle_id!,
    };
    await record(applied);
    await record(recovered);
    const filter = {
      type: "RECOVERED" as const,
      platform: "ios" as const,
      channel: "production",
      fromBundleId: applied.to_bundle_id,
    };
    await expect(
      insights().countEvents({ filter, sinceMs: 200, beforeReceivedAtMs: 201 }),
    ).resolves.toBe(1);
    await expect(
      insights().listEvents({
        filter: { kind: "bundle", ...filter },
        sinceMs: 200,
        beforeReceivedAtMs: 201,
        limit: 10,
      }),
    ).resolves.toEqual([recovered]);
    await expect(
      insights().countEvents({ filter, sinceMs: 100, beforeReceivedAtMs: 200 }),
    ).resolves.toBe(0);
    await expect(
      insights().countInstallations({
        platform: "ios",
        channel: "production",
        bundleId: applied.to_bundle_id,
        sinceMs: 0,
      }),
    ).resolves.toBe(0);
    const explanation = await client
      .db()
      .collection("bundle_events")
      .find({
        type: "RECOVERED",
        platform: "ios",
        channel: "production",
        from_bundle_id: applied.to_bundle_id,
        received_at_ms: { $gte: 200, $lt: 201 },
      })
      .collation({ locale: "simple" })
      .sort({ received_at_ms: -1, id: -1 })
      .hint("bundle_events_from_bundle_idx")
      .explain("executionStats");
    expect(explanation.executionStats.nReturned).toBe(1);
    expect(explanation.executionStats.totalKeysExamined).toBeLessThanOrEqual(2);
  });
});
