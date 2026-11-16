import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createSqlAdapter,
  createTableStatements,
  type SqlDialect,
  type ToolingDatabase,
} from "@hot-updater/plugin-core";
import {
  releaseCatalogPartitionsTable,
  setupKeyOrderTestSuite,
} from "@hot-updater/test-utils";
import {
  assertDockerComposeAvailable,
  mysqlExecutor,
  pgExecutor,
} from "@hot-updater/test-utils/node";
import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { execa } from "execa";
import { Kysely, MysqlDialect, PostgresDialect } from "kysely";
import { createPool as createMysqlCallbackPool } from "mysql2";
import mysql from "mysql2/promise";
import pg from "pg";
import { afterAll, beforeAll, describe, expect } from "vitest";

import { drizzleAdapter } from "../../adapters/drizzle";
import { kyselyAdapter } from "../../adapters/kysely";
import { prismaAdapter } from "../../adapters/prisma";
import {
  mysqlPrisma,
  pgPrisma,
  prismaPushSql,
} from "../../adapters/prismaTestClients";

assertDockerComposeAvailable(
  "The key order integration tests need Docker Compose and a running Docker daemon.",
);

const compose = [
  "compose",
  "-f",
  path.join(path.dirname(fileURLToPath(import.meta.url)), "docker-compose.yml"),
  "-p",
  "hot-updater-sql-core",
];
const PG = "postgres://postgres:hot_updater@127.0.0.1:55432";
const MYSQL = "mysql://root:hot_updater@127.0.0.1:53306";

const ready = async (connect: () => Promise<unknown>) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await connect();
      return;
    } catch (error) {
      if (attempt > 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
};

let pgAdmin: pg.Pool;
let mysqlAdmin: mysql.Pool;
const closers: (() => Promise<unknown>)[] = [];
const directory = mkdtemp(
  path.join(path.dirname(fileURLToPath(import.meta.url)), ".key-order-"),
);

beforeAll(async () => {
  await execa("docker", [...compose, "up", "-d", "--wait"]);
  pgAdmin = new pg.Pool({ connectionString: `${PG}/hot_updater`, max: 2 });
  mysqlAdmin = mysql.createPool({ uri: MYSQL, connectionLimit: 2 });
  await ready(() => pgAdmin.query("SELECT 1"));
  await ready(() => mysqlAdmin.query("SELECT 1"));
}, 180_000);

afterAll(async () => {
  for (const close of closers.toReversed()) await close();
  await pgAdmin?.end();
  await mysqlAdmin?.end();
  await rm(await directory, { recursive: true, force: true });
  await execa("docker", [...compose, "down", "-v"]);
}, 60_000);

let databases = 0;
const TABLE = releaseCatalogPartitionsTable.name;

/**
 * A new PostgreSQL database whose default collation is ICU's English, which
 * orders `a` before `B` and `_` before letters: a column only orders by
 * bytes if its DDL names `C`.
 */
const pgDatabase = async () => {
  databases += 1;
  const name = `key_order_${process.pid}_${databases}`;
  await pgAdmin.query(
    `CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'en' LOCALE 'C'`,
  );
  const pool = new pg.Pool({ connectionString: `${PG}/${name}`, max: 8 });
  closers.push(async () => {
    await pool.end();
    await pgAdmin.query(`DROP DATABASE IF EXISTS ${name}`);
  });
  return pool;
};

/** A new MySQL database with the server's default collation, utf8mb4_0900_ai_ci. */
const mysqlDatabase = async () => {
  databases += 1;
  const name = `key_order_${process.pid}_${databases}`;
  await mysqlAdmin.query(`CREATE DATABASE ${name}`);
  const uri = `${MYSQL}/${name}`;
  const pool = mysql.createPool({
    uri,
    connectionLimit: 8,
    multipleStatements: true,
  });
  closers.push(async () => {
    await pool.end();
    await mysqlAdmin.query(`DROP DATABASE IF EXISTS ${name}`);
  });
  return { pool, uri };
};

/**
 * That the table's key columns compare by bytes, as the catalog records them:
 * `C` on PostgreSQL, and on MySQL `ascii_bin`, or `varbinary` from Prisma.
 */
const expectBinaryKeys = async (
  dialect: SqlDialect,
  table: string,
  read: (sql: string) => Promise<readonly Record<string, unknown>[]>,
) => {
  const columns = await read(
    dialect === "postgresql"
      ? `SELECT column_name AS c, data_type AS t, collation_name AS k FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}' AND column_name IN ('scope_key', 'epoch', 'lower_key') ORDER BY column_name`
      : `SELECT COLUMN_NAME AS c, DATA_TYPE AS t, COLLATION_NAME AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME IN ('scope_key', 'epoch', 'lower_key') ORDER BY COLUMN_NAME`,
  );
  expect(columns.map(({ c }) => c)).toEqual([
    "epoch",
    "lower_key",
    "scope_key",
  ]);
  for (const { t, k } of columns) {
    if (dialect === "postgresql") expect(k).toBe("C");
    else if (t === "varbinary") expect(k).toBeNull();
    else expect(k).toBe("ascii_bin");
  }
};

/** `db migrate` through the adapter's own migrator, then its fenced adapter. */
const migrated = async (database: ToolingDatabase) => {
  await (await database.createMigrator!().migrateToLatest()).execute();
  return database.adapter;
};

/** The generated Drizzle schema, as drizzle-kit loads it and the DDL it runs. */
const drizzleKitSql = async (provider: "postgresql" | "mysql") => {
  const kit = await import("drizzle-kit/api");
  const file = path.join(await directory, `${provider}-${databases}.ts`);
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
    : kit.generateMySQLMigration(
        await kit.generateMySQLDrizzleJson({}),
        await kit.generateMySQLDrizzleJson(imports),
      );
};

/** Each route's own table creation, on the SQL servers CI runs. */
describe.each([
  ["PostgreSQL", "postgresql"],
  ["MySQL", "mysql"],
] as const)("release_catalog_partitions on %s", (_, dialect: SqlDialect) => {
  const database = async () => {
    if (dialect === "postgresql") {
      const pool = await pgDatabase();
      return {
        executor: pgExecutor(pool),
        kysely: new Kysely<object>({ dialect: new PostgresDialect({ pool }) }),
        drizzle: drizzlePg(pool),
        prisma: pgPrisma(pool),
        exec: async (sql: string) => {
          await pool.query(sql);
        },
        read: async (sql: string) =>
          (await pool.query(sql)).rows as Record<string, unknown>[],
      };
    }
    const { pool, uri } = await mysqlDatabase();
    const callbacks = createMysqlCallbackPool({ uri, connectionLimit: 8 });
    closers.push(() => new Promise((resolve) => callbacks.end(resolve)));
    return {
      executor: mysqlExecutor(pool),
      kysely: new Kysely<object>({
        dialect: new MysqlDialect({ pool: callbacks }),
      }),
      drizzle: drizzleMysql(pool),
      prisma: mysqlPrisma(pool),
      exec: async (sql: string) => {
        await pool.query(sql);
      },
      read: async (sql: string) =>
        (await pool.query(sql))[0] as Record<string, unknown>[],
    };
  };
  const provider = dialect as "postgresql" | "mysql";

  setupKeyOrderTestSuite({
    name: `engine DDL under a table prefix, ${dialect}`,
    createAdapter: async ({ table }) => {
      const { executor, read } = await database();
      const adapter = createSqlAdapter({ executor, tablePrefix: "p_" });
      await adapter.migrations!.apply([table]);
      await expectBinaryKeys(dialect, `p_${table.name}`, read);
      return { adapter };
    },
  });

  setupKeyOrderTestSuite({
    name: `kysely db migrate, ${dialect}`,
    createAdapter: async () => {
      // The database's own closer ends the pool Kysely runs on.
      const { kysely, read } = await database();
      const adapter = await migrated(kyselyAdapter({ db: kysely, provider }));
      await expectBinaryKeys(dialect, TABLE, read);
      return { adapter };
    },
  });

  /**
   * A database a 1.2 prerelease migrated through Kysely: `db migrate` has
   * nothing to run, and the release notes' `CREATE TABLE IF NOT EXISTS`,
   * run twice, creates the table as a fresh migration does.
   */
  setupKeyOrderTestSuite({
    name: `the release notes' CREATE TABLE on a prerelease's database, run twice, ${dialect}`,
    createAdapter: async ({ table }) => {
      const { kysely, exec, read } = await database();
      const database_ = kyselyAdapter({ db: kysely, provider });
      await migrated(database_);
      await exec(
        provider === "mysql"
          ? `DROP TABLE \`${TABLE}\``
          : `DROP TABLE "${TABLE}"`,
      );
      await expect(
        database_.createMigrator!().migrateToLatest(),
      ).resolves.toMatchObject({ operations: [] });
      const [statement] = createTableStatements(dialect, [table]);
      await exec(statement!);
      await exec(statement!);
      await expectBinaryKeys(dialect, TABLE, read);
      return { adapter: database_.adapter };
    },
  });

  setupKeyOrderTestSuite({
    name: `drizzle-kit on the generated schema, ${dialect}`,
    createAdapter: async () => {
      const { drizzle, exec, read } = await database();
      for (const statement of await drizzleKitSql(provider)) {
        await exec(statement);
      }
      const adapter = await migrated(drizzleAdapter({ db: drizzle, provider }));
      await expectBinaryKeys(dialect, TABLE, read);
      return { adapter };
    },
  });

  setupKeyOrderTestSuite({
    name: `prisma db push on the generated schema, then db migrate, ${dialect}`,
    createAdapter: async () => {
      const { prisma, exec, read } = await database();
      await exec(await prismaPushSql(provider));
      const adapter = await migrated(prismaAdapter({ prisma, provider }));
      await expectBinaryKeys(dialect, TABLE, read);
      return { adapter };
    },
  });

  /**
   * A database a 1.2 prerelease migrated: its settings already match, and
   * Prisma creates the new table afterwards, so `db migrate` sets its
   * collations although nothing else is pending, and then has nothing left.
   */
  setupKeyOrderTestSuite({
    name: `prisma db push of the new table on a prerelease's database, then db migrate twice, ${dialect}`,
    createAdapter: async () => {
      const { prisma, exec, read } = await database();
      const pushed = await prismaPushSql(provider);
      await exec(pushed);
      const database_ = prismaAdapter({ prisma, provider });
      await migrated(database_);
      const quoted =
        provider === "mysql"
          ? "`release_catalog_partitions`"
          : '"release_catalog_partitions"';
      await exec(`DROP TABLE ${quoted}`);
      // What `prisma db push` runs for the one model the prerelease lacked.
      const added = pushed
        .split(/;\s*\n/u)
        .filter((statement) => statement.includes(quoted))
        .join(";\n");
      expect(added).toContain("CREATE TABLE");
      await exec(added);
      const migrator = database_.createMigrator!();
      const pending = await migrator.migrateToLatest();
      expect(pending.operations).toEqual([
        expect.objectContaining({ type: "custom" }),
      ]);
      await pending.execute();
      await expect(migrator.migrateToLatest()).resolves.toMatchObject({
        operations: [],
      });
      await expectBinaryKeys(dialect, TABLE, read);
      return { adapter: database_.adapter };
    },
  });
});
