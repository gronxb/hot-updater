import { DummyDriver, SqliteAdapter, SqliteQueryCompiler } from "kysely";
import { describe, expect, it } from "vitest";

import { d1Database } from "./d1Database";

const getRuntimeMetadata = (runtime: object) => ({
  adapterName: "adapterName" in runtime ? runtime.adapterName : undefined,
  provider: "provider" in runtime ? runtime.provider : undefined,
  createMigrator:
    "createMigrator" in runtime ? runtime.createMigrator : undefined,
});

describe("d1Database official path", () => {
  it("creates a Kysely-backed SQLite runtime from a supplied dialect", () => {
    const runtime = d1Database({
      dialect: {
        createAdapter: () => new SqliteAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: () => ({
          getMetadata: async () => ({ tables: [] }),
          getSchemas: async () => [],
          getTables: async () => [],
        }),
        createQueryCompiler: () => new SqliteQueryCompiler(),
      },
    });
    const metadata = getRuntimeMetadata(runtime);

    expect(metadata.adapterName).toBe("kysely");
    expect(metadata.provider).toBe("sqlite");
    expect(metadata.createMigrator).toBeTypeOf("function");
  });
});
