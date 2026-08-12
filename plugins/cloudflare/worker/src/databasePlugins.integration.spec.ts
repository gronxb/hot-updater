import { setupDatabasePluginTestSuite } from "@hot-updater/test-utils";
import { env } from "cloudflare:test";
import { inject, vi } from "vitest";

import { d1Database } from "../../src/d1Database";
import { d1Database as d1RuntimeDatabase } from "../../src/worker";

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
          const params = input.params ?? [];
          let paramOffset = 0;
          const statements = input.sql
            .split(";")
            .map((sql) => sql.trim())
            .filter(Boolean)
            .map((sql) => {
              const paramCount = sql.match(/\?/g)?.length ?? 0;
              const statement = getDb()
                .prepare(sql)
                .bind(...params.slice(paramOffset, paramOffset + paramCount));
              paramOffset += paramCount;
              return statement;
            });
          const results = await getDb().batch(statements);
          return {
            async *iterPages() {
              yield { result: results };
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
      "DELETE FROM bundle_events; DELETE FROM client_access_keys; DELETE FROM bundle_patches; DELETE FROM bundles;",
    )
    .run();
};

setupDatabasePluginTestSuite({
  name: "cloudflare d1 http fixed-model database plugin",
  migrate: async () => {
    state.db = env.DB;
    await getDb().prepare(inject("prepareSql")).run();
  },
  createPlugin: () =>
    d1Database({
      accountId: "account-id",
      cloudflareApiToken: "api-token",
      databaseId: "database-id",
    }),
  reset,
  dispose: () => undefined,
});

setupDatabasePluginTestSuite({
  name: "cloudflare worker d1 fixed-model database plugin",
  migrate: () => undefined,
  createPlugin: () => d1RuntimeDatabase(env.DB),
  reset,
  dispose: () => {
    state.db = undefined;
  },
});
