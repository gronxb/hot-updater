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

it("declares the Free plan's 50 queries per request on the binding, and no cap over REST", async () => {
  const { d1Database: restDatabase } = await import("../d1Database");
  // No statement runs: the cap is declared, not measured.
  const unused = (): never => {
    throw new Error("not called");
  };
  const binding = d1Database({ batch: unused, prepare: unused });
  expect(binding.adapter.maxQueriesPerRequest).toBe(50);
  const rest = restDatabase({
    accountId: "account",
    cloudflareApiToken: "token",
    databaseId: "database",
  });
  expect(rest.adapter.maxQueriesPerRequest).toBeUndefined();
  // The cap reaches core's writer through the engine's fence and wrappers.
  const { createEngine } = await import("@hot-updater/plugin-core");
  expect(createEngine(binding).core.queryBudget).toBe(50);
  expect(createEngine(rest).core.queryBudget).toBeUndefined();
});
