import { expect, it } from "vitest";

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
    "analytics",
    "bundlePatches",
    "bundles",
    "channels",
    "clientAccessKeys",
  ]);
  await expect(plugin.models.channels.list({})).resolves.toEqual({
    channels: [{ id: "channel-production", name: "production" }],
  });
});
