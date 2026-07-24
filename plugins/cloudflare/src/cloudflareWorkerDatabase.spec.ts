import { databaseAnalyticsSupport } from "@hot-updater/plugin-core";
import { expect, it } from "vitest";

import { d1WorkerDatabase, type D1Like } from "./cloudflareWorkerDatabase";

const db: D1Like = {
  prepare: () => ({
    bind: () => ({
      all: async () => ({
        results: [{ channel: "production" }],
      }),
    }),
  }),
};

it("advertises Analytics support", () => {
  // Given / When
  const plugin = d1WorkerDatabase(db);

  // Then
  expect(plugin[databaseAnalyticsSupport]).toBe(true);
});

it("uses the configured D1 binding without request context", async () => {
  // Given
  const plugin = d1WorkerDatabase(db);

  // When
  const channels = plugin.getChannels?.();

  // Then
  await expect(channels).resolves.toEqual(["production"]);
});
