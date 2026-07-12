import { setupDatabaseAdapterTestSuite } from "@hot-updater/test-utils";
import { env } from "cloudflare:test";
import { inject, vi } from "vitest";

import { d1WorkerDatabase } from "../../src/cloudflareWorkerDatabase";
import { d1Database } from "../../src/d1Database";

const state = vi.hoisted<{ db: D1Database | undefined }>(() => ({
  db: undefined,
}));

class D1TestStateError extends Error {
  readonly name = "D1TestStateError";
}

const getDb = (): D1Database => {
  if (state.db === undefined) {
    throw new D1TestStateError();
  }
  return state.db;
};

vi.mock("cloudflare", () => ({
  default: class MockCloudflare {
    readonly d1 = {
      database: {
        query: async (
          _databaseId: string,
          input: { readonly sql: string; readonly params?: readonly string[] },
        ) => {
          const result = await getDb()
            .prepare(input.sql)
            .bind(...(input.params ?? []))
            .all();
          return {
            async *iterPages() {
              yield { result: [{ results: result.results }] };
            },
          };
        },
      },
    };
  },
}));

const reset = async (): Promise<void> => {
  await getDb()
    .prepare(
      "DELETE FROM bundle_patches; DELETE FROM bundles; DELETE FROM channels;",
    )
    .run();
};

setupDatabaseAdapterTestSuite({
  name: "cloudflare d1 http database adapter v2",
  migrate: async () => {
    state.db = env.DB;
    await getDb().prepare(inject("prepareSql")).run();
  },
  createAdapter: () =>
    d1Database({
      accountId: "account-id",
      cloudflareApiToken: "api-token",
      databaseId: "database-id",
    }),
  reset,
  dispose: () => undefined,
});

type TestContext = {
  readonly env: { readonly DB: D1Database };
};

setupDatabaseAdapterTestSuite<TestContext>({
  name: "cloudflare worker d1 database adapter v2",
  context: { env },
  migrate: () => undefined,
  createAdapter: () => d1WorkerDatabase<TestContext>(),
  reset,
  dispose: () => {
    state.db = undefined;
  },
});
