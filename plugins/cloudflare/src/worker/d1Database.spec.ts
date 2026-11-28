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

/**
 * A binding over SQLite whose next statements fail with `failures`, in
 * order: a read's `all()` when `on` is "read", a write's `batch()` when
 * "write".
 */
const failingBinding = (on: "read" | "write", failures: Error[]) => {
  const database = createD1TestDatabase(
    new DatabaseSync(":memory:"),
    d1SchemaStatements(),
  );
  const calls = { reads: 0, batches: 0 };
  const binding: D1Like = {
    prepare: (sql) => ({
      bind: (...params) => ({
        sql,
        params,
        all: async () => {
          calls.reads += 1;
          const failure = on === "read" ? failures.shift() : undefined;
          if (failure) throw failure;
          return database.run(sql, params);
        },
      }),
    }),
    batch: async (statements) => {
      calls.batches += 1;
      const failure = on === "write" ? failures.shift() : undefined;
      if (failure) throw failure;
      return database.batch(
        statements as unknown as {
          sql: string;
          params: readonly unknown[];
        }[],
      );
    },
  };
  return { binding, calls };
};

const deployedCore = async (binding: D1Like) => {
  const core = createHotUpdater({
    database: d1Database(binding),
    storage: createReleaseCatalogTestStorage(),
    clientAccess: "public",
  }).core;
  await core.ensureChannel("production");
  await core.deploy([
    {
      bundle: createBundleFixture("1"),
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
  return core;
};

// What workerd's binding throws when D1 answers a statement with an error.
const d1Error = (message: string) => new Error(`D1_ERROR: ${message}`);

// The errors Cloudflare's D1 guide says to retry ("Retry the operation").
it.each([
  "Network connection lost.",
  "Internal error in D1 DB storage caused object to be reset.",
  "Internal error while starting up D1 DB storage caused object to be reset.",
  "D1 DB reset because its code was updated.",
  "Cannot resolve D1 DB due to transient issue on remote node.",
  "Replica disconnected from primary.",
])("retries a read that D1 failed with %j", async (message) => {
  const failures: Error[] = [];
  const { binding, calls } = failingBinding("read", failures);
  const core = await deployedCore(binding);
  const before = calls.reads;
  failures.push(d1Error(message), d1Error(message));

  await expect(core.getBundle(createBundleFixture("1").id)).resolves.toEqual(
    expect.objectContaining({ bundle: createBundleRowFixture("1") }),
  );
  expect(failures).toEqual([]);
  expect(calls.reads - before).toBeGreaterThanOrEqual(3);
});

it("gives up on a read after three attempts and throws D1's error", async () => {
  const failures: Error[] = [];
  const { binding, calls } = failingBinding("read", failures);
  const core = await deployedCore(binding);
  const before = calls.reads;
  const errors = Array.from({ length: 4 }, () =>
    d1Error("Network connection lost."),
  );
  failures.push(...errors);

  await expect(core.getBundle(createBundleFixture("1").id)).rejects.toBe(
    errors[2],
  );
  expect(calls.reads - before).toBe(3);
});

it("doesn't retry a read that failed for another reason", async () => {
  const failures: Error[] = [];
  const { binding, calls } = failingBinding("read", failures);
  const core = await deployedCore(binding);
  const before = calls.reads;
  const error = d1Error("no such column: nope: SQLITE_ERROR");
  failures.push(error);

  await expect(core.getBundle(createBundleFixture("1").id)).rejects.toBe(error);
  expect(calls.reads - before).toBe(1);
});

it("doesn't retry a write, which may have committed", async () => {
  const failures: Error[] = [];
  const { binding, calls } = failingBinding("write", failures);
  const core = await deployedCore(binding);
  const before = calls.batches;
  failures.push(d1Error("Network connection lost."));

  // The engine reports a write whose batch failed as of unknown outcome.
  await expect(core.ensureChannel("beta")).rejects.toThrow();
  expect(calls.batches - before).toBe(1);
});
