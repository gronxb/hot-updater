import type { Dialect } from "kysely";
import { DummyDriver, SqliteAdapter, SqliteQueryCompiler } from "kysely";
import { describe, expect, it } from "vitest";

import { d1Database } from "./d1Database";

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
