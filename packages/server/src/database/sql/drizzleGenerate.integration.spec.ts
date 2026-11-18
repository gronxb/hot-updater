import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { toolingTargetOf } from "@hot-updater/plugin-core";
import { assertDockerComposeAvailable } from "@hot-updater/test-utils/node";
import { createClient } from "@libsql/client";
import { drizzle as libsql } from "drizzle-orm/libsql";
import { drizzle as mysql2 } from "drizzle-orm/mysql2";
import { drizzle as nodePostgres } from "drizzle-orm/node-postgres";
import { execa } from "execa";
import mysql from "mysql2/promise";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { drizzleAdapter, type DrizzleProvider } from "../../adapters/drizzle";
import { composeUp } from "../../docker.testFixtures";
import { apiKeys, insights, remoteConfig } from "../../plugins";

assertDockerComposeAvailable(
  "drizzle-kit migration tests need Docker Compose and a running Docker daemon.",
);

const compose = [
  "compose",
  "-f",
  path.join(import.meta.dirname, "docker-compose.yml"),
  "-p",
  "hot-updater-drizzle-generate",
];
const POSTGRES = "postgres://postgres:hot_updater@127.0.0.1:15432";
const MYSQL = "mysql://root:hot_updater@127.0.0.1:13306";

/** The plugins a managed server runs, so every official table is applied. */
const target = toolingTargetOf([apiKeys(), insights(), remoteConfig()]);

/** drizzle-kit's CLI, run as `npx drizzle-kit` runs it. */
const drizzleKit = path.join(
  path.dirname(createRequire(import.meta.url).resolve("drizzle-kit/api")),
  "bin.cjs",
);

// Inside the package, so the schema files resolve drizzle-orm.
const directory = mkdtemp(path.join(import.meta.dirname, ".drizzle-generate-"));
let admin: pg.Pool;

beforeAll(async () => {
  await composeUp({ compose, services: ["postgres", "mysql"] });
  admin = new pg.Pool({ connectionString: `${POSTGRES}/hot_updater` });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await admin.query("SELECT 1");
      break;
    } catch (error) {
      if (attempt > 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await rm(await directory, { recursive: true, force: true });
  await execa("docker", [...compose, "down", "-v"]);
}, 60_000);

/** The tables 1.2 adds; the statements that create them and their indexes are all an upgrade needs. */
const NEW_TABLES = ["native_builds", "ios_devices", "ios_device_account"];
/** The index 1.2 adds to a table 1.1 created. */
const NEW_INDEX = "bundle_events__byBundle__key";

/**
 * The documented edit of the migration `drizzle-kit generate` writes after
 * upgrading from 1.1: keep the statements that create the new tables, their
 * indexes, and the new index; delete every other statement.
 */
const keepNewTables = (sql: string) =>
  sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => {
      const name = /^CREATE (?:UNIQUE )?(?:TABLE|INDEX) ["`](\w+)["`]/u.exec(
        statement,
      )?.[1];
      const on = /^CREATE (?:UNIQUE )?INDEX ["`]\w+["`] ON ["`](\w+)["`]/u.exec(
        statement,
      )?.[1];
      return (
        (name !== undefined && NEW_TABLES.includes(name)) ||
        (on !== undefined && NEW_TABLES.includes(on)) ||
        name === NEW_INDEX
      );
    })
    .join("\n--> statement-breakpoint\n");

let projects = 0;

/** A server project that applies Hot Updater's tables with drizzle-kit generate and migrate. */
const project = async (dialect: DrizzleProvider) => {
  const cwd = path.join(await directory, `${dialect}-${(projects += 1)}`);
  await execa("mkdir", ["-p", cwd]);
  const name = `drizzle_generate_${projects}`;
  let url: string;
  let database: ReturnType<typeof drizzleAdapter>;
  let sql: (statement: string) => Promise<Record<string, unknown>[]>;
  let close: () => Promise<void>;
  if (dialect === "postgresql") {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    url = `${POSTGRES}/${name}`;
    const pool = new pg.Pool({ connectionString: url });
    database = drizzleAdapter({ db: nodePostgres(pool), provider: dialect });
    sql = async (statement) => (await pool.query(statement)).rows;
    close = () => pool.end();
  } else if (dialect === "mysql") {
    const connection = await mysql.createConnection({ uri: MYSQL });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await connection.query(`DROP DATABASE IF EXISTS ${name}`);
        await connection.query(`CREATE DATABASE ${name}`);
        break;
      } catch (error) {
        if (attempt > 60) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    await connection.end();
    url = `${MYSQL}/${name}`;
    const pool = mysql.createPool({ uri: url });
    database = drizzleAdapter({ db: mysql2(pool), provider: dialect });
    sql = async (statement) =>
      (await pool.query(statement))[0] as Record<string, unknown>[];
    close = () => pool.end();
  } else {
    url = `file:${path.join(cwd, "database.db")}`;
    const client = createClient({ url });
    database = drizzleAdapter({ db: libsql(client), provider: dialect });
    sql = async (statement) =>
      (await client.execute(statement)).rows as unknown as Record<
        string,
        unknown
      >[];
    close = async () => client.close();
  }
  await writeFile(
    path.join(cwd, "drizzle.config.ts"),
    `export default ${JSON.stringify({
      schema: "./hot-updater-schema.ts",
      out: "./drizzle",
      dialect,
      dbCredentials: { url },
    })};\n`,
  );
  const schemaFile = path.join(cwd, "hot-updater-schema.ts");
  const kit = async (...args: string[]) => {
    const { exitCode, all } = await execa("node", [drizzleKit, ...args], {
      cwd,
      input: "",
      all: true,
      reject: false,
    });
    return { exitCode, output: all };
  };
  return {
    database,
    sql,
    close,
    kit,
    /** `hot-updater db generate`: this release's schema file. */
    generate: () =>
      writeFile(
        schemaFile,
        database.generateSchema!("latest", undefined, target).code,
      ),
    /** The schema file 1.1.16's `hot-updater db generate` wrote. */
    generate1116: () =>
      copyFile(
        path.join(
          import.meta.dirname,
          `__testfixtures__/drizzle-1.1.16.${dialect}.ts`,
        ),
        schemaFile,
      ),
    /** The migration file drizzle-kit generate wrote last, edited by `edit`. */
    editLatestMigration: async (edit: (sql: string) => string) => {
      const files = (await readdir(path.join(cwd, "drizzle")))
        .filter((file) => file.endsWith(".sql"))
        .sort();
      const file = path.join(cwd, "drizzle", files.at(-1)!);
      await writeFile(file, edit(await readFile(file, "utf8")));
    },
    /** `hot-updater db migrate`. */
    migrate: async () => {
      const result = await database.createMigrator!(target).migrateToLatest();
      await result.execute();
      return result.operations;
    },
  };
};

/** Each existing table and index, by the storage it keeps: a rebuild changes it. */
const storage = {
  postgresql:
    "SELECT c.relname AS name, c.relfilenode::text AS at FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'i')",
  sqlite:
    "SELECT name, rootpage AS at FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE '__drizzle%'",
} as const;

/**
 * Upgrading a 1.1.16 database whose schema drizzle-kit generate and migrate
 * applied: the migration generate writes re-declares every existing table,
 * so the documented edit keeps only what 1.2 adds. Applied as edited, the
 * upgrade rebuilds no existing table or index, and the next generate has
 * nothing to write.
 */
describe.each(["postgresql", "sqlite"] as const)(
  "drizzle-kit generate and migrate from a 1.1.16 %s database",
  (dialect) => {
    it("adds only the new tables and indexes with the documented edit, then has nothing to write", async () => {
      const db = await project(dialect);
      await db.generate1116();
      expect((await db.kit("generate")).exitCode).toBe(0);
      expect((await db.kit("migrate")).output).toContain(
        "migrations applied successfully",
      );
      await db.sql(
        "INSERT INTO private_hot_updater_settings (key, value, _v) VALUES ('schema.engine', '1', 0), ('schema.core', '1.0.0', 0), ('schema.apiKeys', '1.0.0', 0), ('schema.insights', '1.0.0', 0), ('schema.remoteConfig', '1.0.0', 0)",
      );
      await db.sql(
        "INSERT INTO channels (id, name, _refs_releases_channel_id, _v) VALUES ('channel:production', 'production', 0, 0)",
      );
      const before = new Map(
        (await db.sql(storage[dialect])).map(({ name, at }) => [
          String(name),
          String(at),
        ]),
      );

      await db.generate();
      expect((await db.kit("generate")).exitCode).toBe(0);
      await db.editLatestMigration(keepNewTables);
      const migrated = await db.kit("migrate");
      expect(migrated.output).toContain("migrations applied successfully");
      await db.migrate();

      const after = new Map(
        (await db.sql(storage[dialect])).map(({ name, at }) => [
          String(name),
          String(at),
        ]),
      );
      expect(
        [...before].filter(([name, at]) => after.get(name) !== at),
      ).toEqual([]);
      expect(
        [...after.keys()].filter((name) => !before.has(name)).sort(),
      ).toEqual(expect.arrayContaining([...NEW_TABLES, NEW_INDEX].sort()));
      expect((await db.kit("generate")).output).toContain(
        "No schema changes, nothing to migrate",
      );
      await expect(db.migrate()).resolves.toEqual([]);
      await expect(db.sql("SELECT name FROM channels")).resolves.toEqual([
        expect.objectContaining({ name: "production" }),
      ]);
      if (dialect === "postgresql") {
        await expect(
          db.sql(
            `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('text', 'character varying') AND table_name <> 'private_hot_updater_settings' AND collation_name IS DISTINCT FROM 'C'`,
          ),
        ).resolves.toEqual([{ n: 0 }]);
      }
      await db.close();
    }, 180_000);
  },
);

describe("drizzle-kit on a MySQL database 1.1.16 left", () => {
  it("never created Hot Updater's tables, and the documented step applies them from what it left", async () => {
    const db = await project("mysql");
    await db.generate1116();
    // 1.1.16's composite key names exceed MySQL's 64 characters: the push
    // stops after the first tables, before the settings table.
    expect((await db.kit("push", "--force")).output).toContain("is too long");
    const left = (
      await db.sql(
        "SELECT TABLE_NAME AS t FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME",
      )
    ).map(({ t }) => String(t));
    expect(left).toEqual(["api_keys", "bundle_event_heads", "bundle_events"]);
    for (const table of left) {
      await expect(
        db.sql(`SELECT count(*) AS n FROM \`${table}\``),
      ).resolves.toEqual([{ n: 0 }]);
    }

    // Generate writes CREATE TABLE without IF NOT EXISTS, so migrate stops
    // at the first table 1.1.16 left, having created nothing; the documented
    // step drops what it left first.
    await db.generate();
    expect((await db.kit("generate")).exitCode).toBe(0);
    expect((await db.kit("migrate")).exitCode).toBe(1);
    await expect(
      db.sql(
        "SELECT TABLE_NAME AS t FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> '__drizzle_migrations' ORDER BY TABLE_NAME",
      ),
    ).resolves.toEqual(left.map((t) => ({ t })));
    for (const table of left) await db.sql(`DROP TABLE \`${table}\``);
    expect((await db.kit("migrate")).output).toContain(
      "migrations applied successfully",
    );
    await db.migrate();
    expect((await db.kit("generate")).output).toContain(
      "No schema changes, nothing to migrate",
    );
    await expect(db.migrate()).resolves.toEqual([]);
    await db.close();
  }, 180_000);
});
