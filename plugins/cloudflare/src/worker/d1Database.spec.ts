import { toInsightsInstallationRow } from "@hot-updater/plugin-core";
import { expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../../packages/test-utils/src/databaseTestFixtures";
import { d1Database, type D1Like } from "./d1Database";

const database: D1Like = {
  prepare: () => ({
    bind: () => ({
      all: async () => ({
        results: [{ id: "channel-production", name: "production" }],
      }),
    }),
  }),
  batch: async (statements) =>
    Promise.all(statements.map((item) => item.all())),
};

it("uses the D1 binding supplied at the Worker composition boundary", async () => {
  const plugin = d1Database(database);

  expect(plugin.name).toBe("d1Database");
  expect(Object.keys(plugin.models).sort()).toEqual([
    "apiKeys",
    "bundlePatches",
    "bundles",
    "channels",
    "insights",
    "releaseCatalogs",
    "releases",
  ]);
  await expect(plugin.models.channels.list({})).resolves.toEqual({
    channels: [{ id: "channel-production", name: "production" }],
  });
});

it("does not report a failed D1 query as empty Insights history", async () => {
  const plugin = d1Database({
    ...database,
    prepare: () => ({
      bind: () => ({ all: async () => ({ success: false, results: [] }) }),
    }),
  });
  await expect(
    plugin.models.insights.listEvents({
      filter: { kind: "all" },
      beforeReceivedAtMs: 100,
      limit: 10,
    }),
  ).rejects.toThrow(
    "D1 did not successfully execute every requested statement",
  );
});

it("rejects an incomplete Insights batch response", async () => {
  const plugin = d1Database({
    ...database,
    batch: async () => [{ success: true, results: [] }],
  });
  const event = createBundleEventRowFixture("1", 1);
  await expect(
    plugin.models.insights.record({
      event,
      installation: toInsightsInstallationRow(event),
    }),
  ).rejects.toThrow(
    "D1 did not successfully execute every requested statement",
  );
});
