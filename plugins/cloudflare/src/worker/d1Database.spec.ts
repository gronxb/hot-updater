import { DatabaseSync } from "node:sqlite";

import { createHotUpdater } from "@hot-updater/server";
import {
  createBundleFixture,
  createBundleRowFixture,
  createReleaseCatalogTestStorage,
} from "@hot-updater/test-utils";
import { createD1TestDatabase } from "@hot-updater/test-utils/node";
import { expect, it } from "vitest";

import { d1SchemaStatements } from "../d1Schema";
import { type D1Like, d1Database } from "./d1Database";

it("reads through the binding's statements on the primary, and writes each change as one batch", async () => {
  const database = createD1TestDatabase(
    new DatabaseSync(":memory:"),
    d1SchemaStatements(),
  );
  const calls = { all: 0, batch: 0, withSession: 0 };
  // D1's Sessions API reads from replicas; the binding is never asked for
  // a session, so every read runs on the primary and sees every write.
  const binding: D1Like & { withSession(): never } = {
    withSession: () => {
      calls.withSession += 1;
      throw new Error("withSession reads from read replicas.");
    },
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
  };
  const core = createHotUpdater({
    database: d1Database(binding),
    storage: createReleaseCatalogTestStorage(),
    clientAccess: "public",
  }).core;
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
  expect(calls.withSession).toBe(0);
});
