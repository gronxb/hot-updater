import { createDatabaseCoreApi } from "@hot-updater/server/db";
import { expect, it } from "vitest";

import {
  createBundleFixture,
  createBundleRowFixture,
} from "../../../../packages/test-utils/src/databaseTestFixtures";
import { createD1TestDatabase } from "../d1TestDatabase";
import { d1Database } from "./d1Database";

it("reads through the binding's statements and writes each change as one batch", async () => {
  const database = createD1TestDatabase();
  const calls = { all: 0, batch: 0 };
  const core = createDatabaseCoreApi(
    d1Database({
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
          statements as unknown as {
            sql: string;
            params: readonly unknown[];
          }[],
        );
      },
    }),
  );
  const bundle = createBundleFixture("1");
  await core.ensureChannel("production");
  await core.deploy([
    {
      bundle,
      release: {
        channel: "production",
        enabled: true,
        fingerprintHash: null,
        message: null,
        shouldForceUpdate: false,
        targetAppVersion: "1.0.0",
      },
    },
  ]);
  await expect(core.getBundle(bundle.id)).resolves.toEqual({
    bundle: createBundleRowFixture("1"),
    patches: [],
    childCount: 0,
  });
  expect(calls.batch).toBe(2);
  expect(calls.all).toBeGreaterThan(0);
});
