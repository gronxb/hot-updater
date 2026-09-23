import {
  type DatabaseAdapter,
  type DatabaseKey,
  DATABASE_VERSION_COLUMN,
  findPhysicalColumn,
  findPhysicalIndex,
  indexEntries,
  indexOrderColumns,
  indexOrderTuple,
  normalizeStoredRow,
  type PhysicalColumn,
  type PhysicalIndex,
  type PhysicalTable,
  type QueryBound,
  type QueryRequest,
  rowKey,
  type StoredRow,
  type WriteOp,
  type WriteResult,
} from "@hot-updater/plugin-core/internal";

export type SqlDialect = "postgresql" | "mysql" | "sqlite";

export interface SqlStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface SqlResult {
  readonly rows: readonly Record<string, unknown>[];
  /** Rows an INSERT, UPDATE, or DELETE changed. */
  readonly changes: number;
}

export interface SqlConnection {
  execute(statement: SqlStatement): Promise<SqlResult>;
}

/** One per driver or ORM: runs statements, and runs a callback in one transaction. */
export interface SqlExecutor extends SqlConnection {
  readonly dialect: SqlDialect;
  /** Commits when `fn` resolves and rolls back when it throws; SQLite begins with BEGIN IMMEDIATE. */
  transaction<T>(fn: (connection: SqlConnection) => Promise<T>): Promise<T>;
}

export interface SqlAdapterOptions {
  readonly executor: SqlExecutor;
  /** Prepended to every table name. */
  readonly tablePrefix?: string;
  /** The most ops one write accepts (default 1,000). */
  readonly maxOps?: number;
}

/** PostgreSQL's syntax; SQLite and MySQL override what differs. */
const standard = {
  quote: (name: string) => `"${name.replaceAll('"', '""')}"`,
  param: (position: number) => `$${position}`,
  /** The driver returns JSON as text. */
  jsonText: false,
  /** Row-value comparisons; MySQL gets expanded OR predicates instead. */
  rowValues: true,
  lock: " FOR UPDATE",
  upsert: (key: string) => `ON CONFLICT (${key}) DO UPDATE SET`,
  inlineIndexes: false,
};

const dialects: Record<SqlDialect, typeof standard> = {
  postgresql: standard,
  sqlite: { ...standard, param: () => "?", jsonText: true, lock: "" },
  mysql: {
    ...standard,
    quote: (name) => `\`${name.replaceAll("`", "``")}\``,
    param: () => "?",
    rowValues: false,
    upsert: () => "ON DUPLICATE KEY UPDATE",
    inlineIndexes: true,
  },
};

const codes = (values: string) => new Set(values.split(" "));
const UNIQUE = codes(
  "23505 1062 23503 1451 1452 SQLITE_CONSTRAINT_UNIQUE SQLITE_CONSTRAINT_PRIMARYKEY SQLITE_CONSTRAINT_FOREIGNKEY SQLITE:2067 SQLITE:1555 SQLITE:787",
);
const RETRY = codes(
  "40001 40P01 1213 1205 SQLITE_BUSY SQLITE_BUSY_SNAPSHOT SQLITE_LOCKED SQLITE:5 SQLITE:517 SQLITE:6",
);

/** Driver codes on an error and its causes: SQLSTATE, MySQL errno, SQLite codes. */
const codesOf = (error: unknown, depth = 0): string[] => {
  if (typeof error !== "object" || error === null || depth > 3) return [];
  const record = error as Record<string, unknown>;
  const named = ["code", "errno", "sqlState", "extendedCode"].flatMap((field) =>
    record[field] === undefined ? [] : [String(record[field])],
  );
  const sqlite = ["errcode", "rawCode"].flatMap((field) =>
    typeof record[field] === "number" ? [`SQLITE:${record[field]}`] : [],
  );
  return [...named, ...sqlite, ...codesOf(record.cause, depth + 1)];
};

/** A constraint names the failed op; a transient error asks the engine to retry. */
export const classifySqlError = (
  error: unknown,
): "constraint" | "retry" | undefined => {
  const found = codesOf(error);
  if (found.some((code) => UNIQUE.has(code))) return "constraint";
  return found.some((code) => RETRY.has(code)) ? "retry" : undefined;
};

const isMultiIndex = (table: PhysicalTable, index: PhysicalIndex) =>
  index.eq.some((column) => findPhysicalColumn(table, column).multi);

const shortName = (name: string) => {
  if (name.length <= 60) return name;
  let hash = 0x811c9dc5;
  for (const char of name)
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return `${name.slice(0, 51)}_${hash.toString(36)}`;
};

/** The column type; `entry` types one value of a multi-valued column in its index table. */
const columnType = (
  dialect: SqlDialect,
  column: PhysicalColumn,
  indexed: boolean,
  entry = false,
): string => {
  if ((column.multi && !entry) || column.type === "json") {
    return { postgresql: "jsonb", mysql: "json", sqlite: "TEXT" }[dialect];
  }
  if (column.type === "string") {
    const length = column.maxLength ?? (indexed ? 255 : undefined);
    if (dialect === "sqlite") return "TEXT";
    if (dialect === "postgresql") {
      return `${column.maxLength ? `varchar(${column.maxLength})` : "text"} COLLATE "C"`;
    }
    return `${length ? `varchar(${length})` : "longtext"} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`;
  }
  if (column.type === "integer")
    return dialect === "sqlite" ? "INTEGER" : "bigint";
  if (column.type === "number") {
    return { postgresql: "double precision", mysql: "double", sqlite: "REAL" }[
      dialect
    ];
  }
  return dialect === "sqlite" ? "INTEGER" : "boolean";
};

/**
 * DDL for tables with binary collation: one table per model, one index per
 * declared index, and an index table `<table>__<index>` for each index over a
 * multi-valued field, keyed by every column it holds.
 */
export const createTableStatements = (
  dialect: SqlDialect,
  tables: readonly PhysicalTable[],
  tablePrefix = "",
): string[] => {
  const { quote, inlineIndexes } = dialects[dialect];
  const list = (columns: readonly string[]) => columns.map(quote).join(", ");
  const statements: string[] = [];
  for (const table of tables) {
    const name = tablePrefix + table.name;
    const indexed = new Set([
      ...table.key,
      ...table.indexes.flatMap(({ eq, sort }) => [...eq, ...sort]),
    ]);
    const definitions = table.columns.map(
      (column) =>
        `${quote(column.name)} ${columnType(dialect, column, indexed.has(column.name))}${column.nullable ? "" : " NOT NULL"}`,
    );
    definitions.push(`PRIMARY KEY (${list(table.key)})`);
    const indexes: string[] = [];
    for (const index of table.indexes) {
      const columns = [...index.eq, ...indexOrderColumns(table, index)];
      if (isMultiIndex(table, index)) {
        const entries = columns.map(
          (column) =>
            `${quote(column)} ${columnType(dialect, findPhysicalColumn(table, column), true, true)} NOT NULL`,
        );
        indexes.push(
          `CREATE TABLE IF NOT EXISTS ${quote(`${name}__${index.name}`)} (${entries.join(", ")}, PRIMARY KEY (${list(columns)}))`,
        );
        continue;
      }
      if (!index.unique && columns.join() === table.key.join()) continue;
      const indexName = quote(shortName(`${name}_${index.name}`));
      const indexColumns = list(index.unique ? index.eq : columns);
      if (inlineIndexes) {
        definitions.push(
          `${index.unique ? "UNIQUE " : ""}INDEX ${indexName} (${indexColumns})`,
        );
      } else {
        indexes.push(
          `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${indexName} ON ${quote(name)} (${indexColumns})`,
        );
      }
    }
    statements.push(
      `CREATE TABLE IF NOT EXISTS ${quote(name)} (${definitions.join(", ")})`,
      ...indexes,
    );
  }
  return statements;
};

/** The statements of one op; the first one's result shows whether the op applied. */
export interface CompiledWrite {
  readonly statements: readonly SqlStatement[];
  /** One changed row, a matching `_v` in the row read, or always (inserts and upserts). */
  readonly expect: "changed" | { readonly version: number } | "applied";
}

/** Compiles adapter calls to SQL for one dialect; executors only run the statements. */
export const createSqlCompiler = (name: SqlDialect, tablePrefix = "") => {
  const dialect = dialects[name];
  const { quote } = dialect;
  const tableOf = (table: PhysicalTable, index?: PhysicalIndex) =>
    quote(`${tablePrefix}${table.name}${index ? `__${index.name}` : ""}`);
  const version = quote(DATABASE_VERSION_COLUMN);

  /** Collects parameters in order; positional dialects bind every occurrence. */
  const builder = () => {
    const params: unknown[] = [];
    const bind = (value: unknown, column?: PhysicalColumn) => {
      params.push(
        value === null || value === undefined
          ? null
          : column && (column.multi || column.type === "json")
            ? JSON.stringify(value)
            : typeof value === "boolean" && name !== "postgresql"
              ? Number(value)
              : value,
      );
      return dialect.param(params.length);
    };
    const done = (sql: string): SqlStatement => ({ sql, params });
    return { bind, done };
  };
  type Builder = ReturnType<typeof builder>;

  const keyMatch = (
    { bind }: Builder,
    columns: readonly string[],
    key: DatabaseKey,
    alias = "",
  ) =>
    columns
      .map(
        (column, position) =>
          `${alias}${quote(column)} = ${bind(key[position])}`,
      )
      .join(" AND ");

  /** `columns op values` over a tuple prefix, expanded into ORs without row values. */
  const compare = (
    { bind }: Builder,
    columns: readonly string[],
    bound: QueryBound,
    op: "<" | ">",
  ): string => {
    const cols = columns
      .slice(0, bound.values.length)
      .map((column) => `i.${quote(column)}`);
    const last = `${op}${bound.inclusive ? "=" : ""}`;
    if (cols.length === 1) return `${cols[0]} ${last} ${bind(bound.values[0])}`;
    if (dialect.rowValues) {
      const values = bound.values.map((value) => bind(value));
      return `(${cols.join(", ")}) ${last} (${values.join(", ")})`;
    }
    const terms = cols.map((column, position) =>
      [
        ...cols
          .slice(0, position)
          .map((prefix, at) => `${prefix} = ${bind(bound.values[at])}`),
        `${column} ${position === cols.length - 1 ? last : op} ${bind(bound.values[position])}`,
      ].join(" AND "),
    );
    return `(${terms.map((term) => `(${term})`).join(" OR ")})`;
  };

  const insert = (
    table: PhysicalTable,
    row: Readonly<Record<string, unknown>>,
  ) => {
    const statement = builder();
    const values = table.columns.map((column) =>
      statement.bind(row[column.name], column),
    );
    const columns = table.columns.map(({ name: column }) => quote(column));
    return {
      statement,
      sql: `INSERT INTO ${tableOf(table)} (${columns.join(", ")}) VALUES (${values.join(", ")})`,
    };
  };

  /** Replaces one row's entries in the index table of every multi-valued index. */
  const entries = (
    table: PhysicalTable,
    key: DatabaseKey,
    row: StoredRow | null,
    changed?: readonly string[],
  ): SqlStatement[] =>
    table.indexes.flatMap((index) => {
      const columns = [...index.eq, ...indexOrderColumns(table, index)];
      if (
        !isMultiIndex(table, index) ||
        (changed && !columns.some((column) => changed.includes(column)))
      ) {
        return [];
      }
      const remove = builder();
      const found = row === null ? [] : indexEntries(table, index, row);
      const order = found.length > 0 ? indexOrderTuple(table, index, row!) : [];
      return [
        remove.done(
          `DELETE FROM ${tableOf(table, index)} WHERE ${keyMatch(remove, table.key, key)}`,
        ),
        ...found.map((eq) => {
          const add = builder();
          const values = [...eq, ...order].map((value) => add.bind(value));
          return add.done(
            `INSERT INTO ${tableOf(table, index)} (${columns.map(quote).join(", ")}) VALUES (${values.join(", ")})`,
          );
        }),
      ];
    });

  const bumps = (
    { bind }: Builder,
    by: Readonly<Record<string, number>>,
    qualify = "",
  ) =>
    [...Object.entries(by), [DATABASE_VERSION_COLUMN, 1] as const].map(
      ([column, delta]) =>
        `${quote(column)} = ${qualify}${quote(column)} + ${bind(delta)}`,
    );

  return {
    get(table: PhysicalTable, keys: readonly DatabaseKey[]): SqlStatement {
      const statement = builder();
      const where = keys
        .map((key) => `(${keyMatch(statement, table.key, key)})`)
        .join(" OR ");
      return statement.done(`SELECT * FROM ${tableOf(table)} WHERE ${where}`);
    },

    query(table: PhysicalTable, request: QueryRequest): SqlStatement {
      const index = findPhysicalIndex(table, request.index);
      if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
        throw new RangeError("query limit must be a positive integer.");
      }
      const statement = builder();
      const order = indexOrderColumns(table, index);
      const multi = isMultiIndex(table, index);
      const source = multi
        ? `${tableOf(table, index)} i JOIN ${tableOf(table)} b ON ${table.key.map((column) => `b.${quote(column)} = i.${quote(column)}`).join(" AND ")}`
        : `${tableOf(table)} i`;
      const conditions = [
        ...index.eq.map(
          (column, position) =>
            `i.${quote(column)} = ${statement.bind(request.eq[position])}`,
        ),
        ...(request.lower
          ? [compare(statement, order, request.lower, ">")]
          : []),
        ...(request.upper
          ? [compare(statement, order, request.upper, "<")]
          : []),
      ];
      const direction = request.order === "asc" ? "ASC" : "DESC";
      return statement.done(
        `SELECT ${multi ? "b" : "i"}.* FROM ${source}${conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY ${order.map((column) => `i.${quote(column)} ${direction}`).join(", ")} LIMIT ${request.limit}`,
      );
    },

    /** Guards via `UPDATE … WHERE _v = ?`, checks via locking reads, counters via upserts. */
    write(op: WriteOp): CompiledWrite {
      const { table } = op;
      const statement = builder();
      const where = (key: DatabaseKey, v?: number) =>
        `${keyMatch(statement, table.key, key)}${v === undefined ? "" : ` AND ${version} = ${statement.bind(v)}`}`;
      switch (op.type) {
        case "insert": {
          const { sql, statement: values } = insert(table, op.row);
          const key = rowKey(table, op.row);
          return {
            statements: [values.done(sql), ...entries(table, key, op.row)],
            expect: "applied",
          };
        }
        case "patch": {
          const set = Object.entries(op.set).map(
            ([column, value]) =>
              `${quote(column)} = ${statement.bind(value, findPhysicalColumn(table, column))}`,
          );
          const sql = `UPDATE ${tableOf(table)} SET ${[...set, `${version} = ${version} + 1`].join(", ")} WHERE ${where(op.key, op.guard.v)}`;
          return {
            statements: [
              statement.done(sql),
              ...entries(
                table,
                op.key,
                { ...op.previous, ...op.set },
                Object.keys(op.set),
              ),
            ],
            expect: "changed",
          };
        }
        case "delete":
          return {
            statements: [
              statement.done(
                `DELETE FROM ${tableOf(table)} WHERE ${where(op.key, op.guard.v)}`,
              ),
              ...entries(table, op.key, null),
            ],
            expect: "changed",
          };
        case "increment": {
          if (op.init !== undefined && op.guard === undefined) {
            const row: Record<string, unknown> = { ...op.init };
            for (const [column, delta] of Object.entries(op.by)) {
              row[column] = Number(row[column] ?? 0) + delta;
            }
            row[DATABASE_VERSION_COLUMN] =
              Number(row[DATABASE_VERSION_COLUMN] ?? 0) + 1;
            const upsert = insert(table, row);
            const conflict = dialect.upsert(table.key.map(quote).join(", "));
            const updates = bumps(
              upsert.statement,
              op.by,
              `${tableOf(table)}.`,
            );
            return {
              statements: [
                upsert.statement.done(
                  `${upsert.sql} ${conflict} ${updates.join(", ")}`,
                ),
              ],
              expect: "applied",
            };
          }
          const updates = bumps(statement, op.by);
          return {
            statements: [
              statement.done(
                `UPDATE ${tableOf(table)} SET ${updates.join(", ")} WHERE ${where(op.key, op.guard?.v)}`,
              ),
            ],
            expect: "changed",
          };
        }
        case "check":
          return {
            statements: [
              statement.done(
                `SELECT ${version} FROM ${tableOf(table)} WHERE ${where(op.key)}${dialect.lock}`,
              ),
            ],
            expect: { version: op.guard.v },
          };
      }
    },
  };
};

class FailedOp {
  constructor(readonly index: number) {}
}

/** The shared SQL core over one executor: compiled statements, run in one transaction per write. */
export const createSqlAdapter = (
  options: SqlAdapterOptions,
): DatabaseAdapter => {
  const { executor, tablePrefix = "", maxOps = 1000 } = options;
  const compiler = createSqlCompiler(executor.dialect, tablePrefix);
  const { jsonText } = dialects[executor.dialect];
  const normalize = (
    table: PhysicalTable,
    rows: readonly Record<string, unknown>[],
  ) => rows.map((row) => normalizeStoredRow(table, row, { jsonText }));

  return {
    id: `sql:${executor.dialect}`,
    fits: (ops) => ops.length <= maxOps,

    async get(table, keys) {
      if (keys.length === 0) return [];
      const { rows } = await executor.execute(compiler.get(table, keys));
      const found = new Map(
        normalize(table, rows).map((row) => [
          JSON.stringify(rowKey(table, row)),
          row,
        ]),
      );
      return keys.map((key) => found.get(JSON.stringify(key)) ?? null);
    },

    async query(table, request) {
      const { rows } = await executor.execute(compiler.query(table, request));
      return normalize(table, rows);
    },

    async write(ops): Promise<WriteResult> {
      try {
        await executor.transaction(async (connection) => {
          for (const [position, op] of ops.entries()) {
            const { statements, expect } = compiler.write(op);
            const [first, ...rest] = statements;
            let result: SqlResult;
            try {
              result = await connection.execute(first!);
            } catch (error) {
              if (classifySqlError(error) === "constraint")
                throw new FailedOp(position);
              throw error;
            }
            const applied =
              expect === "applied" ||
              (expect === "changed"
                ? result.changes === 1
                : result.rows.length === 1 &&
                  Number(result.rows[0]![DATABASE_VERSION_COLUMN]) ===
                    expect.version);
            if (!applied) throw new FailedOp(position);
            for (const statement of rest) await connection.execute(statement);
          }
        });
        return { ok: true };
      } catch (error) {
        if (error instanceof FailedOp)
          return { ok: false, failedOp: error.index };
        if (classifySqlError(error) === "retry")
          return { ok: false, retry: true };
        throw error;
      }
    },

    migrations: {
      async apply(tables) {
        for (const sql of createTableStatements(
          executor.dialect,
          tables,
          tablePrefix,
        )) {
          await executor.execute({ sql, params: [] });
        }
      },
    },
  };
};
