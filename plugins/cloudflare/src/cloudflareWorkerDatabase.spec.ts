import { databaseAnalyticsSupport } from "@hot-updater/plugin-core";
import { expect, it } from "vitest";

import { d1WorkerDatabase, type D1Like } from "./cloudflareWorkerDatabase";

type TestContext = {
  readonly env: { readonly DB: D1Like };
};

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
  const adapter = d1WorkerDatabase<TestContext>();

  // Then
  expect(adapter[databaseAnalyticsSupport]).toBe(true);
});

it("resolves the D1 binding from each request context", async () => {
  const adapter = d1WorkerDatabase<TestContext>();

  await expect(adapter.getChannels?.({ env: { DB: db } })).resolves.toEqual([
    "production",
  ]);
});

it("rejects calls without a request D1 binding", async () => {
  const adapter = d1WorkerDatabase<TestContext>();

  await expect(adapter.getChannels?.()).rejects.toThrow(
    "MissingD1BindingError",
  );
});
