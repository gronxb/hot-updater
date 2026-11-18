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

/** The tables 1.2 adds. */
const NEW_TABLES = ["native_builds", "ios_devices", "ios_device_account"];
/** The index 1.2 adds to a table 1.1 created. */
const NEW_INDEX = "bundle_events__byBundle__key";

/**
 * The table or index a generated statement creates, changes, copies or
 * drops: an index statement's index, any other statement's table, SQLite's
 * `__new_<table>` copies counted as `<table>`.
 */
const objectOf = (statement: string) => {
  const name =
    /^CREATE (?:UNIQUE )?INDEX ["`](\w+)["`]/u.exec(statement)?.[1] ??
    /^(?:CREATE|ALTER|DROP) TABLE ["`](\w+)["`]/u.exec(statement)?.[1] ??
    /^INSERT INTO ["`](\w+)["`]/u.exec(statement)?.[1];
  return name?.replace(/^__new_/u, "");
};

/**
 * The documented edit of the migration `drizzle-kit generate` writes after
 * upgrading: delete each statement on a Hot Updater table or index the
 * database already has; keep everything else, the new tables and indexes and
 * the app's own changes among it.
 */
const dropExisting = (existing: ReadonlySet<string>) => (sql: string) =>
  sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => {
      const name = objectOf(statement);
      return name === undefined || !existing.has(name);
    })
    .join("\n--> statement-breakpoint\n");

/** A table of the app's own that the upgrade's migration also creates. */
const APP_TABLE = {
  postgresql: `import { pgTable, varchar } from "drizzle-orm/pg-core";\nexport const todos = pgTable("todos", { id: varchar("id", { length: 36 }).primaryKey() });\n`,
  sqlite: `import { sqliteTable, text } from "drizzle-orm/sqlite-core";\nexport const todos = sqliteTable("todos", { id: text("id").primaryKey() });\n`,
  mysql: `import { mysqlTable, varchar } from "drizzle-orm/mysql-core";\nexport const todos = mysqlTable("todos", { id: varchar("id", { length: 36 }).primaryKey() });\n`,
} as const;

let projects = 0;

/** A server project that applies Hot Updater's tables with drizzle-kit generate and migrate. */
const project = async (
  dialect: DrizzleProvider,
  target = toolingTargetOf([apiKeys(), insights(), remoteConfig()]),
) => {
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
      schema: ["./hot-updater-schema.ts", "./app-schema.ts"],
      out: "./drizzle",
      dialect,
      dbCredentials: { url },
    })};\n`,
  );
  const schemaFile = path.join(cwd, "hot-updater-schema.ts");
  await writeFile(path.join(cwd, "app-schema.ts"), "export {};\n");
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
    /** The schema file 1.1.16's `hot-updater db generate` wrote, `fixture` naming its plugins. */
    generate1116: (fixture: string = dialect) =>
      copyFile(
        path.join(
          import.meta.dirname,
          `__testfixtures__/drizzle-1.1.16.${fixture}.ts`,
        ),
        schemaFile,
      ),
    /** The app adds a table of its own in the same upgrade. */
    addAppTable: () =>
      writeFile(path.join(cwd, "app-schema.ts"), APP_TABLE[dialect]),
    /** Every table and index the database has. */
    objects: async () =>
      new Set(
        (
          await sql(
            dialect === "postgresql"
              ? "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' UNION SELECT indexname FROM pg_indexes WHERE schemaname = 'public'"
              : dialect === "mysql"
                ? "SELECT TABLE_NAME AS t FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() UNION SELECT INDEX_NAME FROM information_schema.statistics WHERE TABLE_SCHEMA = DATABASE()"
                : "SELECT name AS t FROM sqlite_master WHERE type IN ('table', 'index')",
          )
        ).map(({ t }) => String(t)),
      ),
    /** Every table the database has. */
    tables: async () =>
      new Set(
        (
          await sql(
            dialect === "postgresql"
              ? "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'"
              : dialect === "mysql"
                ? "SELECT TABLE_NAME AS t FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE()"
                : "SELECT name AS t FROM sqlite_master WHERE type = 'table'",
          )
        )
          .map(({ t }) => String(t))
          .filter(
            (t) => !t.startsWith("__drizzle") && !t.startsWith("sqlite_"),
          ),
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
 * and the documented edit deletes those statements. Applied as edited, the
 * upgrade creates the new tables and the app's own, rebuilds no existing
 * table or index, and the next generate has nothing to write.
 */
describe.each(["postgresql", "sqlite"] as const)(
  "drizzle-kit generate and migrate from a 1.1.16 %s database",
  (dialect) => {
    it("adds only what is new, the app's own table included, with the documented edit, then has nothing to write", async () => {
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
      const existing = await db.tables();
      const before = new Map(
        (await db.sql(storage[dialect])).map(({ name, at }) => [
          String(name),
          String(at),
        ]),
      );

      await db.generate();
      await db.addAppTable();
      expect((await db.kit("generate")).exitCode).toBe(0);
      await db.editLatestMigration(dropExisting(await db.objects()));
      expect((await db.kit("migrate")).output).toContain(
        "migrations applied successfully",
      );
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
        [...(await db.tables())].filter((t) => !existing.has(t)).sort(),
      ).toEqual([...NEW_TABLES, "todos"].sort());
      expect(after.has(NEW_INDEX)).toBe(true);
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
            `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('text', 'character varying') AND table_name NOT IN ('private_hot_updater_settings', 'todos') AND collation_name IS DISTINCT FROM 'C'`,
          ),
        ).resolves.toEqual([{ n: 0 }]);
      }
      await db.close();
    }, 180_000);
  },
);

/**
 * MySQL databases 1.1.16's `drizzle-kit push` created. With apiKeys() and
 * remoteConfig() its schema applied and served; with insights() its key
 * names exceeded MySQL's 64 characters and the push stopped after the first
 * tables. From either, the first migration generate writes creates every
 * table, which migrate refuses on a table that exists; the documented edit
 * deletes the statements on those, keeping their rows.
 */
describe("drizzle-kit generate and migrate from a MySQL database 1.1.16's push created", () => {
  /** generate, then migrate as written: refused at the first table that exists, having created nothing. */
  const migrateAsWritten = async (db: Awaited<ReturnType<typeof project>>) => {
    const existing = await db.tables();
    expect((await db.kit("migrate")).exitCode).toBe(1);
    expect(await db.tables()).toEqual(existing);
  };

  it("keeps a served database's rows", async () => {
    const plugins = toolingTargetOf([apiKeys(), remoteConfig()]);
    const db = await project("mysql", plugins);
    await db.generate1116("mysql.api-keys-remote-config");
    expect((await db.kit("push", "--force")).output).toContain(
      "Changes applied",
    );
    await db.sql(
      "INSERT INTO private_hot_updater_settings (`key`, value, _v) VALUES ('schema.engine', '1', 0), ('schema.core', '1.0.0', 0), ('schema.apiKeys', '1.0.0', 0), ('schema.remoteConfig', '1.0.0', 0)",
    );
    await db.sql(
      "INSERT INTO channels (id, name, _refs_releases_channel_id, _v) VALUES ('channel:production', 'production', 0, 0)",
    );
    const existing = await db.tables();

    await db.generate();
    expect((await db.kit("generate")).exitCode).toBe(0);
    await migrateAsWritten(db);
    await db.editLatestMigration(dropExisting(await db.objects()));
    expect((await db.kit("migrate")).output).toContain(
      "migrations applied successfully",
    );
    await db.migrate();
    expect(
      [...(await db.tables())].filter((t) => !existing.has(t)).sort(),
    ).toEqual([...NEW_TABLES].sort());
    expect((await db.kit("generate")).output).toContain(
      "No schema changes, nothing to migrate",
    );
    await expect(db.migrate()).resolves.toEqual([]);
    await expect(db.sql("SELECT name FROM channels")).resolves.toEqual([
      expect.objectContaining({ name: "production" }),
    ]);
    await db.close();
  }, 180_000);

  it("completes one whose push stopped on a key name", async () => {
    const db = await project("mysql");
    await db.generate1116();
    expect((await db.kit("push", "--force")).output).toContain("is too long");
    const existing = await db.tables();
    expect([...existing].sort()).toEqual([
      "api_keys",
      "bundle_event_heads",
      "bundle_events",
    ]);

    await db.generate();
    expect((await db.kit("generate")).exitCode).toBe(0);
    await migrateAsWritten(db);
    await db.editLatestMigration(dropExisting(await db.objects()));
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
