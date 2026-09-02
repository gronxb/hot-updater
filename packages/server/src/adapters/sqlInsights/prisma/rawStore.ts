import type { ORMSQLProvider } from "../../../db/types";
import {
  executePrismaInsights,
  PrismaInsightsSql,
  PrismaInsightsConfigurationError,
  queryPrismaInsights,
  type PrismaInsightsRawClient,
  type PrismaInsightsStatement,
} from "./client";

export type PrismaInsightsWhere = Readonly<
  Record<
    string,
    | unknown
    | {
        readonly operator: "gt" | "gte" | "lt" | "lte";
        readonly value: unknown;
      }
    | { readonly operator: "is-null" | "is-not-null" }
  >
>;

const whereSql = (sql: PrismaInsightsSql, where: PrismaInsightsWhere): string =>
  Object.entries(where)
    .map(([column, condition]) => {
      if (
        typeof condition === "object" &&
        condition !== null &&
        "operator" in condition
      ) {
        const operation = condition as {
          readonly operator:
            | "gt"
            | "gte"
            | "lt"
            | "lte"
            | "is-null"
            | "is-not-null";
          readonly value?: unknown;
        };
        switch (operation.operator) {
          case "is-null":
            return `${column} is null`;
          case "is-not-null":
            return `${column} is not null`;
          case "gt":
          case "gte":
          case "lt":
          case "lte":
            return `${column} ${
              operation.operator === "gt"
                ? ">"
                : operation.operator === "gte"
                  ? ">="
                  : operation.operator === "lt"
                    ? "<"
                    : "<="
            } ${sql.value(operation.value)}`;
        }
      }
      if (condition === null) return `${column} is null`;
      return `${column}=${sql.value(condition)}`;
    })
    .join(" and ");

export const selectPrismaInsightsRows = <TRow>(
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  input: {
    readonly table: string;
    readonly columns: readonly string[];
    readonly where?: PrismaInsightsWhere;
    readonly orderBy?: readonly {
      readonly column: string;
      readonly direction: "asc" | "desc";
    }[];
    readonly limit?: number;
    readonly lock?: "update" | "skip-locked";
  },
): Promise<TRow[]> => {
  const sql = new PrismaInsightsSql(provider);
  const filter =
    input.where === undefined || Object.keys(input.where).length === 0
      ? ""
      : ` where ${whereSql(sql, input.where)}`;
  const limit = input.limit === undefined ? undefined : sql.value(input.limit);
  const top = provider === "mssql" && limit ? `top (${limit}) ` : "";
  const suffix =
    provider !== "mssql" && limit !== undefined ? ` limit ${limit}` : "";
  const table =
    provider === "mssql" && input.lock !== undefined
      ? `${input.table} with (updlock,rowlock,holdlock)`
      : input.table;
  const lock =
    provider === "mysql" && input.lock !== undefined
      ? ` for update${input.lock === "skip-locked" ? " skip locked" : ""}`
      : "";
  const query = `select ${top}${input.columns.join(",")} from ${table}${filter}${
    input.orderBy === undefined || input.orderBy.length === 0
      ? ""
      : ` order by ${input.orderBy
          .map(({ column, direction }) => `${column} ${direction}`)
          .join(",")}`
  }${suffix}${lock}`;
  return queryPrismaInsights<TRow[]>(client, sql.statement(query));
};

export const insertPrismaInsightsIgnore = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  table: string,
  row: Readonly<Record<string, unknown>>,
  conflictFields: readonly string[],
): Promise<number> => {
  if (conflictFields.length === 0)
    throw new PrismaInsightsConfigurationError(
      "Prisma Insights conflict key is empty",
    );
  const columns = Object.keys(row);
  const values = columns.map((column) => row[column]);
  const sql = new PrismaInsightsSql(provider);
  if (provider === "mssql") {
    const conflict = whereSql(
      sql,
      Object.fromEntries(conflictFields.map((field) => [field, row[field]])),
    );
    const markers = values.map((value) => sql.value(value));
    const rows = await queryPrismaInsights<{ affected: number }[]>(
      client,
      sql.statement(
        `if not exists (select 1 from ${table} with (updlock,holdlock) where ${conflict})
         insert into ${table} (${columns.join(",")}) output 1 as affected
         values (${markers.join(",")})`,
      ),
    );
    return rows.length;
  }
  if (provider === "mysql") {
    const lockSql = new PrismaInsightsSql(provider);
    const conflict = whereSql(
      lockSql,
      Object.fromEntries(conflictFields.map((field) => [field, row[field]])),
    );
    const existing = await queryPrismaInsights<{ matched: number }[]>(
      client,
      lockSql.statement(
        `select 1 as matched from ${table} where ${conflict} limit 1 for update`,
      ),
    );
    if (existing.length === 1) return 0;
    if (existing.length !== 0)
      throw new PrismaInsightsConfigurationError(
        "Prisma Insights conflict lookup returned multiple rows",
      );
    const insertSql = new PrismaInsightsSql(provider);
    const markers = values.map((value) => insertSql.value(value));
    const inserted = await executePrismaInsights(
      client,
      insertSql.statement(
        `insert into ${table} (${columns.join(",")}) values (${markers.join(",")})`,
      ),
    );
    if (inserted !== 1)
      throw new PrismaInsightsConfigurationError(
        "Prisma Insights insert returned an invalid row count",
      );
    return 1;
  }
  const markers = values.map((value) => sql.value(value));
  return executePrismaInsights(
    client,
    sql.statement(
      `insert into ${table} (${columns.join(",")}) values (${markers.join(",")}) on conflict do nothing`,
    ),
  );
};

export const updatePrismaInsightsRows = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  table: string,
  update: Readonly<Record<string, unknown>>,
  where: PrismaInsightsWhere,
): Promise<number> => {
  const sql = new PrismaInsightsSql(provider);
  const assignments = Object.entries(update).map(
    ([column, value]) => `${column}=${sql.value(value)}`,
  );
  const filter = whereSql(sql, where);
  if (provider === "mssql") {
    const rows = await queryPrismaInsights<{ affected: number }[]>(
      client,
      sql.statement(
        `update ${table} set ${assignments.join(",")} output 1 as affected where ${filter}`,
      ),
    );
    return rows.length;
  }
  return executePrismaInsights(
    client,
    sql.statement(
      `update ${table} set ${assignments.join(",")} where ${filter}`,
    ),
  );
};

export const deletePrismaInsightsRows = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  table: string,
  where: PrismaInsightsWhere,
): Promise<number> => {
  const sql = new PrismaInsightsSql(provider);
  const filter = whereSql(sql, where);
  if (provider === "mssql") {
    const rows = await queryPrismaInsights<{ affected: number }[]>(
      client,
      sql.statement(
        `delete from ${table} output 1 as affected where ${filter}`,
      ),
    );
    return rows.length;
  }
  return executePrismaInsights(
    client,
    sql.statement(`delete from ${table} where ${filter}`),
  );
};

export const rawPrismaInsightsStatement = (
  provider: ORMSQLProvider,
  build: (sql: PrismaInsightsSql) => string,
): PrismaInsightsStatement => {
  const sql = new PrismaInsightsSql(provider);
  return sql.statement(build(sql));
};
