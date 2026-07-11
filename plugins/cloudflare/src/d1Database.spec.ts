import type { Dialect } from "kysely";
import { DummyDriver, SqliteAdapter, SqliteQueryCompiler } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { d1Database } from "./d1Database";
import { d1Database as d1WorkerDatabase } from "./worker";

const createSqliteDialect = (): Dialect => ({
  createAdapter: () => new SqliteAdapter(),
  createDriver: () => new DummyDriver(),
  createIntrospector: () => ({
    getMetadata: async () => ({ tables: [] }),
    getSchemas: async () => [],
    getTables: async () => [],
  }),
  createQueryCompiler: () => new SqliteQueryCompiler(),
});

describe("d1Database official Kysely path", () => {
  it("creates a Kysely-backed SQLite runtime from a supplied dialect", () => {
    const runtime = d1Database({ dialect: createSqliteDialect() });

    expect(runtime.adapterName).toBe("kysely");
    expect(runtime.provider).toBe("sqlite");
    expect(runtime.createMigrator).toBeTypeOf("function");
  });

  it("uses D1-compatible no-transaction mode", () => {
    const runtime = d1Database({ dialect: createSqliteDialect() });

    expect("beginTransaction" in runtime).toBe(false);
  });
});

describe("d1Database Node runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates the default Node runtime from Cloudflare credentials", () => {
    // Given
    const config = {
      accountId: "account-id",
      cloudflareApiToken: "api-token",
      databaseId: "database-id",
    };

    // When
    const runtime = d1Database(config);

    // Then
    expect(runtime.adapterName).toBe("kysely");
    expect(runtime.provider).toBe("sqlite");
    expect(runtime.createMigrator).toBeTypeOf("function");
  });

  it("executes Kysely queries through the Cloudflare D1 REST API", async () => {
    // Given
    const requests: Request[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(
        JSON.stringify({
          errors: [],
          messages: [],
          result: [
            {
              meta: {
                changed_db: false,
                changes: 0,
                duration: 0,
                last_row_id: 0,
                rows_read: 0,
                rows_written: 0,
                size_after: 0,
              },
              results: [],
              success: true,
            },
          ],
          success: true,
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = d1Database({
      accountId: "account-id",
      cloudflareApiToken: "api-token",
      databaseId: "database-id",
    });

    // When
    const bundle = await runtime.bundles.getById({
      bundleId: "01900000-0000-7000-8000-000000000001",
    });

    // Then
    expect(bundle).toBeNull();
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-id/d1/database/database-id/query",
    );
    expect(request?.headers.get("authorization")).toBe("Bearer api-token");
    const body: unknown = await request?.json();
    expect(body).toEqual(
      expect.objectContaining({
        params: ["01900000-0000-7000-8000-000000000001"],
        sql: expect.stringContaining('from "bundles"'),
      }),
    );
    await runtime.close?.();
  });
});

describe("d1Database Worker runtime", () => {
  it("requires an explicit Worker D1 binding", () => {
    // Given
    const openWorkerDatabase = d1WorkerDatabase();

    // When / Then
    expect(() => openWorkerDatabase()).toThrow(
      "d1WorkerDatabase requires env.DB in the hot updater context.",
    );
  });
});
