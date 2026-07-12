import { expect, it } from "vitest";

import { d1WorkerDatabase, type D1Like } from "./cloudflareWorkerDatabase";

type TestContext = {
  readonly env: { readonly DB: D1Like };
};

const db: D1Like = {
  prepare: () => ({
    bind: () => ({
      all: async () => ({ results: [{ id: "production" }] }),
    }),
  }),
};

it("resolves the D1 binding from each request context", async () => {
  const adapter = d1WorkerDatabase<TestContext>();

  await expect(
    adapter.findOne(
      { model: "channels", where: [{ field: "id", value: "production" }] },
      { env: { DB: db } },
    ),
  ).resolves.toEqual({ id: "production" });
});

it("rejects calls without a request D1 binding", async () => {
  const adapter = d1WorkerDatabase<TestContext>();

  await expect(
    adapter.findOne({
      model: "channels",
      where: [{ field: "id", value: "production" }],
    }),
  ).rejects.toThrow("MissingD1BindingError");
});
