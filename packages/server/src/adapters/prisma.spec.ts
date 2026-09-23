import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import {
  setupDatabasePluginTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import {
  createBundleRowFixture,
  createChannelRowFixture,
  createReleaseRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import { legacyFacadeSchema } from "../database/legacyFacade";
import { classifySqlError } from "../database/sql/sqlAdapter";
import { isMultiIndex, quoteSql } from "../database/sql/sqlSchema";
import { HotUpdaterSchemaMigrationRequiredError } from "../db/schemaReadiness";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import { createHotUpdater } from "../index";
import { prismaAdapter } from "./prisma";
import {
  prismaExecutor,
  type PrismaTransactionalClient,
} from "./prismaExecutor";
import { pglitePrisma, prismaPushSql, sqlitePrisma } from "./prismaTestClients";

/** Every data table; the settings rows stay across tests. */
const dataTables = legacyFacadeSchema.tables.flatMap((table) => [
  table.name,
  ...table.indexes
    .filter((index) => isMultiIndex(table, index))
    .map((index) => `${table.name}__${index.name}`),
]);

/** Prisma's tables, as `prisma db push` creates them, then `hot-updater db migrate`. */
const backends = {
  postgresql: async () => {
    const db = new PGlite();
    await db.exec(await prismaPushSql("postgresql"));
    const prisma = pglitePrisma(db);
    return {
      prisma,
      exec: (sql: string) => db.exec(sql).then(() => undefined),
      close: () => db.close(),
    };
  },
  sqlite: async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(await prismaPushSql("sqlite"));
    return {
      prisma: sqlitePrisma(db),
      exec: async (sql: string) => db.exec(sql),
      close: async () => db.close(),
    };
  },
} as const;

const migrate = async (plugin: DatabaseAdapterWithCapabilities) =>
  (await plugin.createMigrator!().migrateToLatest()).execute();

for (const provider of ["postgresql", "sqlite"] as const) {
  let backend: Awaited<ReturnType<(typeof backends)[typeof provider]>>;
  setupDatabasePluginTestSuite({
    createHttpClient: (options) =>
      startHttpTestServer(
        createHotUpdater({ ...options, clientAccess: { type: "public" } })
          .handlers,
      ),
    name: `prismaAdapter (${provider})`,
    migrate: async () => {
      backend = await backends[provider]();
      await migrate(prismaAdapter({ prisma: backend.prisma, provider }));
    },
    createPlugin: () => prismaAdapter({ prisma: backend.prisma, provider }),
    reset: async () => {
      const quote = (name: string) => quoteSql(provider, name);
      await backend.exec(
        provider === "postgresql"
          ? `TRUNCATE ${dataTables.map(quote).join(", ")}`
          : dataTables.map((name) => `DELETE FROM ${quote(name)};`).join(""),
      );
    },
    dispose: () => backend.close(),
  });
}

describe("prismaAdapter migrations", () => {
  it("sets the collations Prisma cannot declare, writes the settings, and serves behind the fence", async () => {
    const { prisma, close } = await backends.postgresql();
    const plugin = prismaAdapter({ prisma, provider: "postgresql" });
    await expect(plugin.models.channels.list({})).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );

    const migrator = plugin.createMigrator!();
    const pending = await migrator.migrateToLatest();
    expect(pending.operations.map(({ type }) => type)).toEqual([
      "custom",
      "custom",
    ]);
    expect(pending.getSQL?.()).toContain(
      'ALTER TABLE "releases" ALTER COLUMN "id" TYPE varchar(36) COLLATE "C"',
    );
    await pending.execute();
    await expect(migrator.migrateToLatest()).resolves.toMatchObject({
      operations: [],
    });
    const collations = (await prisma.$queryRawUnsafe(
      "SELECT column_name, collation_name FROM information_schema.columns WHERE table_name = 'releases' AND column_name IN ('scope_key', 'revision') ORDER BY column_name",
    )) as { column_name: string; collation_name: string | null }[];
    expect(collations).toEqual([
      { column_name: "revision", collation_name: null },
      { column_name: "scope_key", collation_name: "C" },
    ]);

    const channel = createChannelRowFixture("production");
    const bundle = createBundleRowFixture("1");
    const release = createReleaseRowFixture("1", bundle, channel);
    await plugin.models.channels.insert({
      row: channel,
      onConflict: "returnExisting",
    });
    await expect(
      plugin.commit({
        changes: [
          { model: "bundles", operation: "insert", row: bundle },
          { model: "releases", operation: "insert", row: release },
        ],
      }),
    ).resolves.toEqual({ committed: true });
    await expect(plugin.models.releases.findById(release.id)).resolves.toEqual(
      release,
    );
    await close();
  });

  it("asks for Prisma's tables first", async () => {
    const db = new PGlite();
    await expect(
      prismaAdapter({ prisma: pglitePrisma(db), provider: "postgresql" })
        .createMigrator!().migrateToLatest(),
    ).rejects.toThrow("prisma db push");
    await db.close();
  });

  it("refuses SQL Server", () => {
    expect(() =>
      prismaAdapter({ prisma: {}, provider: "mssql" as never }),
    ).toThrow("SQL Server is not supported");
  });
});

describe("prismaAdapter schema", () => {
  const models = (provider: "mysql" | "postgresql" | "sqlite") =>
    prismaAdapter({ prisma: {}, provider }).generateSchema!("latest").code;

  it("maps engine columns to fields that start with a letter, with keys and named indexes but no relations", () => {
    const code = models("postgresql");
    expect(code).toContain('hu_v BigInt @default(0) @map("_v")');
    expect(code).toContain("model private_hot_updater_settings {");
    expect(code).toContain(
      '@@index([platform, id], map: "bundles_byPlatform")',
    );
    expect(code).not.toContain("@relation");
  });

  it("stores MySQL's ASCII keys as VarBinary, within InnoDB's key limit", () => {
    const code = models("mysql");
    expect(code).toMatch(/scope_key Bytes @db\.VarBinary\(2048\)/u);
    expect(code).toMatch(/id String @db\.VarChar\(36\)/u);
  });
});

describe("prismaExecutor", () => {
  it("carries the database's code from Prisma's error, so the SQL core can classify it", async () => {
    const db = new PGlite();
    await db.exec("CREATE TABLE t (id text PRIMARY KEY)");
    const executor = prismaExecutor(pglitePrisma(db), "postgresql");
    const insert = { sql: "INSERT INTO t (id) VALUES ($1)", params: ["a"] };
    await executor.execute(insert);
    const error = await executor
      .execute(insert)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "23505", cause: { code: "P2010" } });
    expect(classifySqlError(error)).toBe("constraint");
    await db.close();

    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
    const sqliteExecutor = prismaExecutor(sqlitePrisma(sqlite), "sqlite");
    const row = { sql: "INSERT INTO t (id) VALUES (?)", params: ["a"] };
    await sqliteExecutor.execute(row);
    expect(
      classifySqlError(
        await sqliteExecutor.execute(row).catch((caught: unknown) => caught),
      ),
    ).toBe("constraint");
  });

  it("retries a transaction Prisma reports as a write conflict", async () => {
    const conflict = Object.assign(new Error("write conflict"), {
      code: "P2034",
    });
    const client = {
      $queryRawUnsafe: async () => [],
      $executeRawUnsafe: async () => 0,
      $transaction: async () => {
        throw conflict;
      },
    } satisfies PrismaTransactionalClient;
    const error = await prismaExecutor(client, "postgresql")
      .transaction(async () => undefined)
      .catch((caught: unknown) => caught);
    expect(classifySqlError(error)).toBe("retry");
  });

  it("takes SQLite's write lock with a transaction's first statement, and reads bytes as text", async () => {
    const statements: string[] = [];
    const tx = {
      $queryRawUnsafe: async () => [
        { scope_key: new TextEncoder().encode("key"), revision: 1 },
      ],
      $executeRawUnsafe: async (sql: string) => {
        statements.push(sql);
        return 0;
      },
    };
    const client = {
      ...tx,
      $transaction: async <T>(fn: (runner: typeof tx) => Promise<T>) => fn(tx),
    } satisfies PrismaTransactionalClient;
    const rows = await prismaExecutor(client, "sqlite").transaction(
      async (connection) =>
        (await connection.execute({ sql: "SELECT 1", params: [] })).rows,
    );
    expect(statements).toEqual([
      'UPDATE "private_hot_updater_settings" SET "_v" = "_v" WHERE 0 = 1',
    ]);
    expect(rows).toEqual([{ scope_key: "key", revision: 1 }]);
  });
});
