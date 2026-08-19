import { sql, type QueryExecutorProvider } from "kysely";

import type { ORMSQLProvider } from "./types";

class SqliteMigrationForeignKeyError extends Error {
  readonly name = "SqliteMigrationForeignKeyError";

  constructor(readonly violations: number) {
    super(`SQLite migration produced ${violations} foreign key violation(s).`);
  }
}

const executeTransactionalStatements = async (
  db: QueryExecutorProvider,
  statements: readonly string[],
): Promise<void> => {
  await db.getExecutor().provideConnection(async (connection) => {
    const execute = (statement: string) =>
      connection.executeQuery(sql.raw(statement).compile(db));
    await execute("begin");
    try {
      for (const statement of statements) await execute(statement);
      await execute("commit");
    } catch (error) {
      await execute("rollback");
      throw error;
    }
  });
};

const executeSqliteStatements = async (
  db: QueryExecutorProvider,
  statements: readonly string[],
): Promise<void> => {
  await db.getExecutor().provideConnection(async (connection) => {
    const execute = (statement: string) =>
      connection.executeQuery(sql.raw(statement).compile(db));
    const foreignKeys = await execute("pragma foreign_keys");
    const state = foreignKeys.rows[0];
    const foreignKeysWereEnabled =
      typeof state === "object" &&
      state !== null &&
      "foreign_keys" in state &&
      state.foreign_keys === 1;

    await execute("pragma foreign_keys = off");
    try {
      await execute("begin");
      try {
        for (const statement of statements) {
          if (
            statement === "pragma foreign_keys = off" ||
            statement === "pragma foreign_keys = on"
          ) {
            continue;
          }
          if (statement === "pragma foreign_key_check") {
            const result = await execute(statement);
            if (result.rows.length > 0) {
              throw new SqliteMigrationForeignKeyError(result.rows.length);
            }
            continue;
          }
          await execute(statement);
        }
        await execute("commit");
      } catch (error) {
        await execute("rollback");
        throw error;
      }
    } finally {
      await execute(
        foreignKeysWereEnabled
          ? "pragma foreign_keys = on"
          : "pragma foreign_keys = off",
      );
    }
  });
};

const executeMysqlStatements = async (
  db: QueryExecutorProvider,
  statements: readonly string[],
): Promise<void> => {
  for (const statement of statements) {
    await sql.raw(statement).execute(db);
  }
};

export const executeMigrationStatements = async ({
  db,
  provider,
  statements,
}: {
  readonly db: QueryExecutorProvider;
  readonly provider: ORMSQLProvider;
  readonly statements: readonly string[];
}): Promise<void> => {
  if (provider === "mysql") {
    await executeMysqlStatements(db, statements);
    return;
  }
  if (provider === "sqlite") {
    await executeSqliteStatements(db, statements);
    return;
  }
  await executeTransactionalStatements(db, statements);
};
