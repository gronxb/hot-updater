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

type MysqlMigrationObjectType = "column" | "constraint" | "index";

type MysqlColumnMetadata = {
  readonly character_set_name: string | null;
  readonly character_maximum_length: number | null;
  readonly collation_name: string | null;
  readonly data_type: string;
  readonly is_nullable: "NO" | "YES";
};

type MysqlIndexMetadata = {
  readonly column_name: string;
  readonly non_unique: number;
  readonly seq_in_index: number;
};

type MysqlConstraintMetadata = {
  readonly check_clause: string | null;
  readonly constraint_type: string;
  readonly delete_rule: string | null;
  readonly referenced_column_name: string | null;
  readonly referenced_table_name: string | null;
  readonly update_rule: string | null;
};

class MysqlMigrationObjectConflictError extends Error {
  readonly name = "MysqlMigrationObjectConflictError";

  constructor(
    readonly objectType: MysqlMigrationObjectType,
    readonly table: string,
    readonly objectName: string,
  ) {
    super(
      `Cannot safely resume MySQL migration: ${objectType} ${table}.${objectName} already exists.`,
    );
  }
}

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

const mysqlColumnMetadata = async (
  db: QueryExecutorProvider,
  { table, name }: MysqlSchemaObject,
): Promise<MysqlColumnMetadata | undefined> => {
  const result = await sql<MysqlColumnMetadata>`
    select
      data_type,
      character_maximum_length,
      character_set_name,
      collation_name,
      is_nullable
    from information_schema.columns
    where table_schema = database()
      and table_name = ${table}
      and column_name = ${name}
    limit 1
  `.execute(db);
  return result.rows[0];
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

const mysqlIndexMetadata = async (
  db: QueryExecutorProvider,
  { table, name }: MysqlSchemaObject,
): Promise<readonly MysqlIndexMetadata[]> => {
  const result = await sql<MysqlIndexMetadata>`
    select column_name, non_unique, seq_in_index
    from information_schema.statistics
    where table_schema = database()
      and table_name = ${table}
      and index_name = ${name}
    order by seq_in_index
  `.execute(db);
  return result.rows;
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

const mysqlConstraintMetadata = async (
  db: QueryExecutorProvider,
  { table, name }: MysqlSchemaObject,
): Promise<MysqlConstraintMetadata | undefined> => {
  const result = await sql<MysqlConstraintMetadata>`
    select
      constraint_type,
      check_clause,
      referenced_table_name,
      referenced_column_name,
      update_rule,
      delete_rule
    from information_schema.table_constraints
    left join information_schema.key_column_usage using (
      constraint_schema,
      table_name,
      constraint_name
    )
    left join information_schema.referential_constraints using (
      constraint_schema,
      table_name,
      constraint_name
    )
    left join information_schema.check_constraints using (
      constraint_schema,
      constraint_name
    )
    where constraint_schema = database()
      and table_name = ${table}
      and constraint_name = ${name}
    limit 1
  `.execute(db);
  return result.rows[0];
};

const isResumableV038MysqlColumn = async (
  db: QueryExecutorProvider,
  object: MysqlSchemaObject,
): Promise<boolean> => {
  if (object.table !== "bundles" || object.name !== "channel_id") return false;
  const metadata = await mysqlColumnMetadata(db, object);
  return (
    metadata?.data_type.toLowerCase() === "varchar" &&
    metadata.character_maximum_length === 255 &&
    metadata.character_set_name === "utf8mb4" &&
    metadata.collation_name === "utf8mb4_bin" &&
    (metadata.is_nullable === "YES" || metadata.is_nullable === "NO")
  );
};

const isResumableV038MysqlIndex = async (
  db: QueryExecutorProvider,
  object: MysqlSchemaObject,
): Promise<boolean> => {
  const expected =
    object.table === "channels" && object.name === "channels_name_key"
      ? { column: "name", nonUnique: 0 }
      : object.table === "bundles" && object.name === "bundles_channel_id_idx"
        ? { column: "channel_id", nonUnique: 1 }
        : undefined;
  if (!expected) return false;
  const metadata = await mysqlIndexMetadata(db, object);
  return (
    metadata.length === 1 &&
    metadata[0]?.column_name === expected.column &&
    metadata[0].non_unique === expected.nonUnique &&
    metadata[0].seq_in_index === 1
  );
};

const isResumableV038MysqlConstraint = async (
  db: QueryExecutorProvider,
  object: MysqlSchemaObject,
): Promise<boolean> => {
  const metadata = await mysqlConstraintMetadata(db, object);
  if (
    object.table === "channels" &&
    (object.name === "channels_id_length_check" ||
      object.name === "channels_name_length_check")
  ) {
    const column = object.name === "channels_id_length_check" ? "id" : "name";
    const checkClause = metadata?.check_clause
      ?.replaceAll("`", "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\((.*)\)$/, "$1");
    return (
      metadata?.constraint_type === "CHECK" &&
      checkClause === `char_length(${column}) between 1 and 255`
    );
  }
  return (
    object.table === "bundles" &&
    object.name === "bundles_channel_id_fk" &&
    metadata?.constraint_type === "FOREIGN KEY" &&
    metadata.referenced_table_name === "channels" &&
    metadata.referenced_column_name === "id" &&
    metadata.update_rule === "RESTRICT" &&
    metadata.delete_rule === "RESTRICT"
  );
};

const shouldSkipMysqlStatement = async (
  db: QueryExecutorProvider,
  statement: string,
): Promise<boolean> => {
  const index = mysqlIndex(statement);
  if (index && (await mysqlIndexExists(db, index))) {
    if (await isResumableV038MysqlIndex(db, index)) return true;
    throw new MysqlMigrationObjectConflictError(
      "index",
      index.table,
      index.name,
    );
  }

  const addedColumn = mysqlColumn(statement, "add");
  if (addedColumn && (await mysqlColumnExists(db, addedColumn))) {
    if (await isResumableV038MysqlColumn(db, addedColumn)) return true;
    throw new MysqlMigrationObjectConflictError(
      "column",
      addedColumn.table,
      addedColumn.name,
    );
  }

  const droppedColumn = mysqlColumn(statement, "drop");
  if (droppedColumn) return !(await mysqlColumnExists(db, droppedColumn));

  const constraint = mysqlConstraint(statement);
  if (constraint && (await mysqlConstraintExists(db, constraint))) {
    if (await isResumableV038MysqlConstraint(db, constraint)) return true;
    throw new MysqlMigrationObjectConflictError(
      "constraint",
      constraint.table,
      constraint.name,
    );
  }

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
