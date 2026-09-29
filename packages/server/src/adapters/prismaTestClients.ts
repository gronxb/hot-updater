import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync, SqliteValue } from "node:sqlite";
import { promisify } from "node:util";

import type { PGlite, Transaction } from "@electric-sql/pglite";
import type { Pool as MysqlPool, PoolConnection } from "mysql2/promise";

import { prismaAdapter, type PrismaProvider } from "./prisma";
import type {
  PrismaRawClient,
  PrismaTransactionalClient,
} from "./prismaExecutor";

/** A database error as Prisma reports a failed raw query: P2010, with the database's code. */
const prismaError = (error: unknown) => {
  const { code, errcode, errno, message } = error as Record<string, unknown>;
  const database = String(errcode ?? errno ?? code);
  return Object.assign(
    new Error(
      `Raw query failed. Code: \`${database}\`. Message: \`${String(message)}\``,
    ),
    {
      name: "PrismaClientKnownRequestError",
      code: "P2010",
      meta: { code: database, message: String(message) },
    },
  );
};

const raw = (
  query: (sql: string, params: unknown[]) => Promise<unknown[]>,
  execute: (sql: string, params: unknown[]) => Promise<number>,
): PrismaRawClient => ({
  $queryRawUnsafe: (sql, ...params) =>
    query(sql, params).catch((error: unknown) => {
      throw prismaError(error);
    }),
  $executeRawUnsafe: (sql, ...params) =>
    execute(sql, params).catch((error: unknown) => {
      throw prismaError(error);
    }),
});

/** Prisma's raw query API over PGlite, as the Prisma client answers it. */
export const pglitePrisma = (db: PGlite): PrismaTransactionalClient => {
  const over = (runner: PGlite | Transaction) =>
    raw(
      async (sql, params) => (await runner.query(sql, params)).rows,
      async (sql, params) =>
        (await runner.query(sql, params)).affectedRows ?? 0,
    );
  return {
    ...over(db),
    $transaction: (fn) => db.transaction((tx) => fn(over(tx))),
  };
};

/**
 * Prisma's raw query API over `node:sqlite`. Like Prisma's SQLite client, it
 * runs one operation at a time, and begins transactions deferred.
 */
export const sqlitePrisma = (db: DatabaseSync): PrismaTransactionalClient => {
  const over = raw(
    async (sql, params) => db.prepare(sql).all(...(params as SqliteValue[])),
    async (sql, params) =>
      Number(db.prepare(sql).run(...(params as SqliteValue[])).changes),
  );
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>) => {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  };
  return {
    $queryRawUnsafe: (sql, ...params) =>
      serial(() => over.$queryRawUnsafe(sql, ...params)),
    $executeRawUnsafe: (sql, ...params) =>
      serial(() => over.$executeRawUnsafe(sql, ...params)),
    $transaction: (fn) =>
      serial(async () => {
        db.exec("BEGIN");
        try {
          const result = await fn(over);
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }),
  };
};

/** Prisma's raw query API over a mysql2 pool. */
export const mysqlPrisma = (pool: MysqlPool): PrismaTransactionalClient => {
  const over = (runner: MysqlPool | PoolConnection) =>
    raw(
      async (sql, params) => (await runner.query(sql, params))[0] as unknown[],
      async (sql, params) => {
        const [result] = await runner.query(sql, params);
        return (result as { affectedRows: number }).affectedRows;
      },
    );
  return {
    ...over(pool),
    async $transaction(fn) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await fn(over(connection));
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
  };
};

const prismaCli = createRequire(import.meta.url).resolve(
  "prisma/build/index.js",
);
const urls: Record<PrismaProvider, string> = {
  sqlite: "file:./unused.db",
  postgresql: "postgresql://unused@localhost/unused",
  mysql: "mysql://unused@localhost/unused",
};

/** The DDL `prisma db push` runs for the generated models on an empty database, from Prisma's CLI. */
export const prismaPushSql = async (
  provider: PrismaProvider,
): Promise<string> => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "hot-updater-prisma-"),
  );
  try {
    const file = path.join(directory, "schema.prisma");
    const models = prismaAdapter({ prisma: {}, provider }).generateSchema!(
      "latest",
    ).code;
    await writeFile(
      file,
      `datasource db {\n  provider = "${provider}"\n  url      = "${urls[provider]}"\n}\n\n${models}\n`,
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        prismaCli,
        "migrate",
        "diff",
        "--from-empty",
        "--to-schema-datamodel",
        file,
        "--script",
      ],
      {
        env: {
          ...process.env,
          CHECKPOINT_DISABLE: "1",
          PRISMA_HIDE_UPDATE_MESSAGE: "1",
        },
      },
    );
    return stdout;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
