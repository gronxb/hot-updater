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
  const adapter = d1WorkerDatabase(db);

  // Then
  expect(adapter[databaseAnalyticsSupport]).toBe(true);
});

it("uses the configured D1 binding without request context", async () => {
  // Given
  const adapter = d1WorkerDatabase(db);

  // When
  const channels = adapter.getChannels?.();

  // Then
  await expect(channels).resolves.toEqual(["production"]);
});
