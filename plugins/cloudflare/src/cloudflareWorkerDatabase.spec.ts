import { expect, it } from "vitest";

import { d1WorkerDatabase, type D1Like } from "./cloudflareWorkerDatabase";

const db: D1Like = {
  batch: async () => [],
  prepare: () => ({
    bind: () => ({
      all: async () => ({
        results: [{ channel: "production" }],
      }),
    }),
  }),
};

it("uses the configured D1 binding without request context", async () => {
  const plugin = d1WorkerDatabase(db);

  const channels = plugin.getChannels?.();

  await expect(channels).resolves.toEqual(["production"]);
});
