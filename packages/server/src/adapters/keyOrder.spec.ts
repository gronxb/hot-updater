import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SqliteValue } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import type { ToolingDatabase } from "@hot-updater/plugin-core";
import { setupKeyOrderTestSuite } from "@hot-updater/test-utils";
import { createClient } from "@libsql/client";
import { drizzle as libsql } from "drizzle-orm/libsql";
import { drizzle as pglite } from "drizzle-orm/pglite";
import { Kysely, SqliteDialect } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterAll } from "vitest";

import { drizzleAdapter } from "./drizzle";
import { kyselyAdapter } from "./kysely";
import { prismaAdapter } from "./prisma";
import { pglitePrisma, prismaPushSql, sqlitePrisma } from "./prismaTestClients";

/**
 * `release_catalog_partitions`' byte order through each ORM route on SQLite
 * and PGlite, on the tables the route itself creates: Kysely's `db migrate`,
 * drizzle-kit over the generated Drizzle schema, and Prisma's DDL for the
 * generated models followed by `db migrate`. The SQL group's
 * `keyOrder.integration.spec.ts` runs the same routes on PostgreSQL and
 * MySQL servers whose default collations are not binary.
 */
// Inside the package, so a generated Drizzle schema resolves `drizzle-orm`.
const directory = mkdtemp(path.join(import.meta.dirname, ".key-order-"));
afterAll(async () => rm(await directory, { recursive: true, force: true }));
let files = 0;

const migrated = async (database: ToolingDatabase) => {
  await (await database.createMigrator!().migrateToLatest()).execute();
  return database.adapter;
};

/** Kysely over `node:sqlite`, as Kysely's SQLite dialect expects. */
const sqliteKysely = (database: DatabaseSync) =>
  new Kysely<object>({
    dialect: new SqliteDialect({
      database: {
        close: () => database.close(),
        prepare: (query) => {
          const statement = database.prepare(query);
          return {
            reader: statement.columns().length > 0,
            all: (parameters) =>
              statement.all(...(parameters as SqliteValue[])),
            run: (parameters) => {
              const result = statement.run(...(parameters as SqliteValue[]));
              return {
                changes: result.changes,
                lastInsertRowid: result.lastInsertRowid,
              };
            },
            iterate: (parameters) =>
              statement.iterate(...(parameters as SqliteValue[])),
          };
        },
      },
    }),
  });

/** The DDL drizzle-kit runs for the generated Drizzle schema. */
const drizzleKitSql = async (provider: "postgresql" | "sqlite") => {
  const kit = await import("drizzle-kit/api");
  const file = path.join(await directory, `${provider}-${(files += 1)}.ts`);
  await writeFile(
    file,
    drizzleAdapter({ db: {}, provider }).generateSchema!("latest").code,
  );
  const imports = (await import(pathToFileURL(file).href)) as Record<
    string,
    unknown
  >;
  return provider === "postgresql"
    ? kit.generateMigration(
        kit.generateDrizzleJson({}),
        kit.generateDrizzleJson(imports),
      )
    : kit.generateSQLiteMigration(
        await kit.generateSQLiteDrizzleJson({}),
        await kit.generateSQLiteDrizzleJson(imports),
      );
};

setupKeyOrderTestSuite({
  name: "kysely db migrate (SQLite)",
  createAdapter: async () => {
    const db = sqliteKysely(new DatabaseSync(":memory:"));
    return {
      adapter: await migrated(kyselyAdapter({ db, provider: "sqlite" })),
      cleanup: () => db.destroy(),
    };
  },
});

setupKeyOrderTestSuite({
  name: "kysely db migrate (PGlite)",
  createAdapter: async () => {
    const client = new PGlite();
    const db = new Kysely<object>({ dialect: new PGliteDialect(client) });
    return {
      adapter: await migrated(kyselyAdapter({ db, provider: "postgresql" })),
      cleanup: async () => {
        await db.destroy();
        await client.close();
      },
    };
  },
});

setupKeyOrderTestSuite({
  name: "drizzle-kit on the generated schema (SQLite)",
  createAdapter: async () => {
    const client = createClient({
      url: `file:${path.join(await directory, `${(files += 1)}.db`)}`,
    });
    for (const statement of await drizzleKitSql("sqlite")) {
      await client.executeMultiple(statement);
    }
    return {
      adapter: await migrated(
        drizzleAdapter({ db: libsql(client), provider: "sqlite" }),
      ),
      cleanup: async () => client.close(),
    };
  },
});

setupKeyOrderTestSuite({
  name: "drizzle-kit on the generated schema (PGlite)",
  createAdapter: async () => {
    const client = new PGlite();
    for (const statement of await drizzleKitSql("postgresql")) {
      await client.exec(statement);
    }
    return {
      adapter: await migrated(
        drizzleAdapter({ db: pglite(client), provider: "postgresql" }),
      ),
      cleanup: () => client.close(),
    };
  },
});

setupKeyOrderTestSuite({
  name: "prisma db push on the generated schema, then db migrate (SQLite)",
  createAdapter: async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(await prismaPushSql("sqlite"));
    return {
      adapter: await migrated(
        prismaAdapter({ prisma: sqlitePrisma(db), provider: "sqlite" }),
      ),
      cleanup: async () => db.close(),
    };
  },
});

setupKeyOrderTestSuite({
  name: "prisma db push on the generated schema, then db migrate (PGlite)",
  createAdapter: async () => {
    const client = new PGlite();
    await client.exec(await prismaPushSql("postgresql"));
    return {
      adapter: await migrated(
        prismaAdapter({ prisma: pglitePrisma(client), provider: "postgresql" }),
      ),
      cleanup: () => client.close(),
    };
  },
});
