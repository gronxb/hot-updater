import { expect, it } from "vitest";

import { d1Database, type D1Like } from "./d1Database";

const database: D1Like = {
  prepare: () => ({
    bind: () => ({
      all: async () => ({
        results: [{ channel: "production" }],
      }),
    }),
  }),
  batch: async (statements) =>
    Promise.all(statements.map((item) => item.all())),
};

it("uses the D1 binding supplied at the Worker composition boundary", async () => {
  const plugin = d1Database(database);

  expect(plugin.name).toBe("d1Database");
  await expect(plugin.getChannels?.()).resolves.toEqual(["production"]);
});
