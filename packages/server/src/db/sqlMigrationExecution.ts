import { sql, type QueryExecutorProvider } from "kysely";

import type { ORMSQLProvider } from "./types";

class SqliteMigrationForeignKeyError extends Error {
  readonly name = "SqliteMigrationForeignKeyError";

  constructor(readonly violations: number) {
    super(`SQLite migration produced ${violations} foreign key violation(s).`);
  }
}

type MysqlSchemaObject = {
  readonly table: string;
  readonly name: string;
};

const parseMysqlSchemaObject = (
  statement: string,
  pattern: RegExp,
): MysqlSchemaObject | null => {
  const match = pattern.exec(statement);
  const table = match?.groups?.["table"];
  const name = match?.groups?.["name"];
  return table && name ? { table, name } : null;
};

const mysqlColumn = (statement: string, action: "add" | "drop") =>
  parseMysqlSchemaObject(
    statement,
    new RegExp(
      `^alter table (?<table>\\S+) ${action} column (?<name>\\S+)`,
      "i",
    ),
  );

const mysqlIndex = (statement: string) => {
  const match =
    /^create (?:unique )?index (?<name>\S+) on (?<table>[^\s(]+)/i.exec(
      statement,
    );
  const table = match?.groups?.["table"];
  const name = match?.groups?.["name"];
  return table && name ? { table, name } : null;
};

const mysqlConstraint = (statement: string) =>
  parseMysqlSchemaObject(
    statement,
    /^alter table (?<table>\S+) add constraint (?<name>\S+)/i,
  );

const mysqlColumnExists = async (
  db: QueryExecutorProvider,
  { table, name }: MysqlSchemaObject,
): Promise<boolean> => {
  const result = await sql<{ readonly present: number }>`
    select 1 as present
    from information_schema.columns
    where table_schema = database()
      and table_name = ${table}
      and column_name = ${name}
    limit 1
  `.execute(db);
  return result.rows.length > 0;
};

const mysqlIndexExists = async (
  db: QueryExecutorProvider,
  { table, name }: MysqlSchemaObject,
): Promise<boolean> => {
  const result = await sql<{ readonly present: number }>`
    select 1 as present
    from information_schema.statistics
    where table_schema = database()
      and table_name = ${table}
      and index_name = ${name}
    limit 1
  `.execute(db);
  return result.rows.length > 0;
};

const mysqlConstraintExists = async (
  db: QueryExecutorProvider,
  { table, name }: MysqlSchemaObject,
): Promise<boolean> => {
  const result = await sql<{ readonly present: number }>`
    select 1 as present
    from information_schema.table_constraints
    where constraint_schema = database()
      and table_name = ${table}
      and constraint_name = ${name}
    limit 1
  `.execute(db);
  return result.rows.length > 0;
};

const shouldSkipMysqlStatement = async (
  db: QueryExecutorProvider,
  statement: string,
): Promise<boolean> => {
  const index = mysqlIndex(statement);
  if (index) return mysqlIndexExists(db, index);

  const addedColumn = mysqlColumn(statement, "add");
  if (addedColumn) return mysqlColumnExists(db, addedColumn);

  const droppedColumn = mysqlColumn(statement, "drop");
  if (droppedColumn) return !(await mysqlColumnExists(db, droppedColumn));

  const constraint = mysqlConstraint(statement);
  if (constraint) return mysqlConstraintExists(db, constraint);

  return false;
};

const executeMysqlStatements = async (
  db: QueryExecutorProvider,
  statements: readonly string[],
): Promise<void> => {
  for (const statement of statements) {
    if (await shouldSkipMysqlStatement(db, statement)) continue;
    await sql.raw(statement).execute(db);
  }
};

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
