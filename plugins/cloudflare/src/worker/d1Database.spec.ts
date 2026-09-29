import { expect, it } from "vitest";

import {
  createBundleRowFixture,
  createChannelRowFixture,
} from "../../../../packages/test-utils/src/databaseTestFixtures";
import { createD1TestDatabase } from "../d1TestDatabase";
import { d1Database } from "./d1Database";

it("reads through the binding's statements and writes each change as one batch", async () => {
  const database = createD1TestDatabase();
  const calls = { all: 0, batch: 0 };
  const plugin = d1Database({
    prepare: (sql) => ({
      bind: (...params) => ({
        sql,
        params,
        all: async () => {
          calls.all += 1;
          return database.run(sql, params);
        },
      }),
    }),
    batch: async (statements) => {
      calls.batch += 1;
      return database.batch(
        statements as unknown as { sql: string; params: readonly unknown[] }[],
      );
    },
  });
  const channel = createChannelRowFixture("production");
  const bundle = createBundleRowFixture("1");
  await plugin.models.channels.insert({
    row: channel,
    onConflict: "returnExisting",
  });
  await plugin.commit({
    changes: [{ model: "bundles", operation: "insert", row: bundle }],
  });
  await expect(plugin.models.bundles.findById(bundle.id)).resolves.toEqual(
    bundle,
  );
  expect(calls.batch).toBe(2);
  expect(calls.all).toBeGreaterThan(0);
});
