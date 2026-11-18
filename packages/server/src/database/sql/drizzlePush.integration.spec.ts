import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  "drizzle-kit push tests need Docker Compose and a running Docker daemon.",
);

const compose = [
  "compose",
  "-f",
  path.join(import.meta.dirname, "docker-compose.yml"),
  "-p",
  "hot-updater-drizzle-push",
];
const POSTGRES = "postgres://postgres:hot_updater@127.0.0.1:15432";
const MYSQL = "mysql://root:hot_updater@127.0.0.1:13306";

/** The plugins a managed server runs, so every official table is pushed. */
const target = toolingTargetOf([apiKeys(), insights(), remoteConfig()]);

/** drizzle-kit's CLI, run as `npx drizzle-kit` runs it. */
const drizzleKit = path.join(
  path.dirname(createRequire(import.meta.url).resolve("drizzle-kit/api")),
  "bin.cjs",
);

// Inside the package, so the schema files resolve drizzle-orm.
const directory = mkdtemp(path.join(import.meta.dirname, ".drizzle-push-"));
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

let projects = 0;

/**
 * A server project on its own database: `hot-updater-schema.ts`, the
 * drizzle.config.ts the Drizzle docs show, and the adapter over it.
 */
const project = async (dialect: DrizzleProvider) => {
  const cwd = path.join(await directory, `${dialect}-${(projects += 1)}`);
  await execa("mkdir", ["-p", cwd]);
  let url: string;
  let database: ReturnType<typeof drizzleAdapter>;
  let close: () => Promise<void>;
  if (dialect === "postgresql") {
    const name = `drizzle_push_${projects}`;
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    url = `${POSTGRES}/${name}`;
    const pool = new pg.Pool({ connectionString: url });
    database = drizzleAdapter({ db: nodePostgres(pool), provider: dialect });
    close = () => pool.end();
  } else {
    url = `file:${path.join(cwd, "database.db")}`;
    const client = createClient({ url });
    database = drizzleAdapter({ db: libsql(client), provider: dialect });
    close = async () => client.close();
  }
  await writeFile(
    path.join(cwd, "drizzle.config.ts"),
    `export default ${JSON.stringify({
      schema: "./hot-updater-schema.ts",
      dialect,
      dbCredentials: { url },
    })};\n`,
  );
  const schemaFile = path.join(cwd, "hot-updater-schema.ts");
  return {
    database,
    close,
    sql: async (statement: string) => {
      if (dialect === "postgresql") {
        const pool = new pg.Pool({ connectionString: url });
        try {
          return (await pool.query(statement)).rows;
        } finally {
          await pool.end();
        }
      }
      const client = createClient({ url });
      try {
        return (await client.execute(statement)).rows;
      } finally {
        client.close();
      }
    },
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
    /** `npx drizzle-kit push` with no terminal, as CI or a deploy step runs it. */
    push: async () => {
      const { exitCode, all } = await execa(
        "node",
        [drizzleKit, "push", "--verbose"],
        { cwd, input: "", all: true, reject: false },
      );
      return { exitCode, output: all };
    },
    /** `hot-updater db migrate`. */
    migrate: async () => {
      const result = await database.createMigrator!(target).migrateToLatest();
      await result.execute();
      return result.operations;
    },
  };
};

/** What a push that applied nothing prints, and what one that would change a table does. */
const expectNoChanges = (output: string) => {
  expect(output).toContain("No changes detected");
  expect(output).not.toMatch(/ALTER|DROP|__new_|data loss|Error/iu);
};

describe.each(["postgresql", "sqlite"] as const)(
  "drizzle-kit push of the generated %s schema",
  (dialect) => {
    it("plans nothing on a second push of a fresh database", async () => {
      const db = await project(dialect);
      await db.generate();
      expect((await db.push()).exitCode).toBe(0);
      await db.migrate();

      expectNoChanges((await db.push()).output);
      await expect(db.migrate()).resolves.toEqual([]);
      await db.close();
    }, 120_000);

    it("adds only the new tables and indexes to a 1.1.16 database with rows, then plans nothing", async () => {
      const db = await project(dialect);
      await db.generate1116();
      expect((await db.push()).exitCode).toBe(0);
      // The rows 1.1.16's db migrate wrote, which made every push since ask
      // to confirm data loss.
      await db.sql(
        "INSERT INTO private_hot_updater_settings (key, value, _v) VALUES ('schema.engine', '1', 0), ('schema.core', '1.0.0', 0), ('schema.apiKeys', '1.0.0', 0), ('schema.insights', '1.0.0', 0), ('schema.remoteConfig', '1.0.0', 0)",
      );

      await db.generate();
      const upgrade = await db.push();
      expect(upgrade.exitCode).toBe(0);
      expect(upgrade.output).toContain("Changes applied");
      expect(upgrade.output).not.toMatch(/ALTER|DROP|__new_|data loss/iu);
      expect(
        [...upgrade.output.matchAll(/CREATE TABLE "?`?(\w+)/gu)]
          .map(([, table]) => table)
          .sort(),
      ).toEqual(["ios_device_account", "ios_devices", "native_builds"]);
      expect(upgrade.output).toContain("bundle_events__byBundle__key");

      await db.migrate();
      expectNoChanges((await db.push()).output);
      await expect(db.migrate()).resolves.toEqual([]);
      await expect(
        db.sql(
          "SELECT value FROM private_hot_updater_settings WHERE key = 'schema.core'",
        ),
      ).resolves.toEqual([expect.objectContaining({ value: "1.2.0" })]);
      if (dialect === "postgresql") {
        // Every string column compares by its bytes, as the engine's DDL
        // declares, the settings table aside: it is only read by key.
        await expect(
          db.sql(
            `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('text', 'character varying') AND table_name <> 'private_hot_updater_settings' AND collation_name IS DISTINCT FROM 'C'`,
          ),
        ).resolves.toEqual([{ n: 0 }]);
      }
      await db.close();
    }, 120_000);
  },
);

describe("drizzle-kit generate and migrate of the generated mysql schema", () => {
  /** `npx drizzle-kit <command>` in the project. */
  const kit = async (cwd: string, command: string) => {
    const { exitCode, all } = await execa("node", [drizzleKit, command], {
      cwd,
      input: "",
      all: true,
      reject: false,
    });
    return { exitCode, output: all };
  };

  // drizzle-kit push cannot read MySQL's character sets, so a MySQL
  // project applies the schema through migration files.
  it("creates every table, and a second generate has nothing to write", async () => {
    const cwd = path.join(await directory, "mysql");
    await execa("mkdir", ["-p", cwd]);
    const name = `drizzle_generate_${process.pid}`;
    const admin = await mysql.createConnection({ uri: MYSQL });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${name}`);
        await admin.query(`CREATE DATABASE ${name}`);
        break;
      } catch (error) {
        if (attempt > 60) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    await admin.end();
    await writeFile(
      path.join(cwd, "drizzle.config.ts"),
      `export default ${JSON.stringify({
        schema: "./hot-updater-schema.ts",
        out: "./drizzle",
        dialect: "mysql",
        dbCredentials: { url: `${MYSQL}/${name}` },
      })};\n`,
    );
    const pool = mysql.createPool({ uri: `${MYSQL}/${name}` });
    const database = drizzleAdapter({ db: mysql2(pool), provider: "mysql" });
    await writeFile(
      path.join(cwd, "hot-updater-schema.ts"),
      database.generateSchema!("latest", undefined, target).code,
    );

    expect(await kit(cwd, "generate")).toMatchObject({ exitCode: 0 });
    const migrated = await kit(cwd, "migrate");
    expect(migrated.output).toContain("migrations applied successfully");
    const migrator = database.createMigrator!(target);
    await (await migrator.migrateToLatest()).execute();
    await expect(migrator.migrateToLatest()).resolves.toMatchObject({
      operations: [],
    });
    expect((await kit(cwd, "generate")).output).toContain(
      "No schema changes, nothing to migrate",
    );
    await pool.end();
  }, 180_000);
});
