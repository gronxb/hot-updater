import { expect, it } from "vitest";

import { d1WorkerDatabase, type D1Like } from "./cloudflareWorkerDatabase";

const db: D1Like = {
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

it("uses the configured D1 binding without request context", async () => {
  const plugin = d1WorkerDatabase(db);

  const channels = plugin.models.channels.list({});

  await expect(channels).resolves.toEqual({
    channels: [{ id: "channel-production", name: "production" }],
  });
  expect(plugin.name).toBe("d1WorkerDatabase");
  expect("bundles" in plugin).toBe(false);
});
