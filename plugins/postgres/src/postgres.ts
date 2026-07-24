import { withAnalyticsProvider } from "@hot-updater/analytics/provider";
import type {
  CreateDatabaseImplementationInput,
  DatabasePluginImplementation,
  DatabaseModel,
  DatabaseWhere,
  DeleteDatabaseImplementationInput,
  FindOneDatabaseImplementationInput,
  UpdateBundleDatabaseImplementationInput,
} from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";
import {
  Kysely,
  PostgresDialect,
  sql,
  type Dialect,
  type RawBuilder,
} from "kysely";
import { Pool, type PoolConfig } from "pg";

import { getUpdateInfo } from "./getUpdateInfo";
import { countPostgresRows, findManyPostgresRows } from "./postgresQuery";
import type { Database } from "./types";

type PostgresWhere = {
  readonly [TModel in DatabaseModel]: DatabaseWhere<TModel>;
}[DatabaseModel];

type PostgresWhereList = {
  readonly [TModel in DatabaseModel]: readonly DatabaseWhere<TModel>[];
}[DatabaseModel];

export type PostgresConfig = PoolConfig & {
  readonly dialect?: Dialect;
};

class InvalidPostgresPredicateError extends Error {
  readonly name = "InvalidPostgresPredicateError";
}

const escapeLikePattern = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

const stringPredicate = (
  condition: PostgresWhere,
  operator: "contains" | "ends_with" | "starts_with",
): RawBuilder<boolean> => {
  if (typeof condition.value !== "string") {
    throw new InvalidPostgresPredicateError();
  }
  const column = sql.ref(condition.field);
  const literal = escapeLikePattern(condition.value);
  const pattern =
    operator === "contains"
      ? `%${literal}%`
      : operator === "starts_with"
        ? `${literal}%`
        : `%${literal}`;
  return "mode" in condition && condition.mode === "insensitive"
    ? sql<boolean>`lower(${column}) like lower(${pattern}) escape '\\'`
    : sql<boolean>`${column} like ${pattern} escape '\\'`;
};

const predicate = (condition: PostgresWhere): RawBuilder<boolean> => {
  const column = sql.ref(condition.field);
  const operator = condition.operator ?? "eq";
  switch (operator) {
    case "eq":
    case "ne": {
      if (condition.value === null) {
        return operator === "eq"
          ? sql<boolean>`${column} is null`
          : sql<boolean>`${column} is not null`;
      }
      const insensitive =
        "mode" in condition && condition.mode === "insensitive";
      if (insensitive) {
        return operator === "eq"
          ? sql<boolean>`lower(${column}) = lower(${condition.value})`
          : sql<boolean>`lower(${column}) <> lower(${condition.value})`;
      }
      return operator === "eq"
        ? sql<boolean>`${column} = ${condition.value}`
        : sql<boolean>`${column} <> ${condition.value}`;
    }
    case "gt":
      return sql<boolean>`${column} > ${condition.value}`;
    case "gte":
      return sql<boolean>`${column} >= ${condition.value}`;
    case "lt":
      return sql<boolean>`${column} < ${condition.value}`;
    case "lte":
      return sql<boolean>`${column} <= ${condition.value}`;
    case "in":
    case "not_in": {
      if (!Array.isArray(condition.value)) {
        throw new InvalidPostgresPredicateError();
      }
      if (condition.value.length === 0) {
        return sql<boolean>`${operator === "not_in"}`;
      }
      return operator === "in"
        ? sql<boolean>`${column} in (${sql.join(condition.value)})`
        : sql<boolean>`${column} not in (${sql.join(condition.value)})`;
    }
    case "contains":
    case "starts_with":
    case "ends_with":
      return stringPredicate(condition, operator);
  }
};

const buildWhere = (
  where: PostgresWhereList | undefined,
): RawBuilder<boolean> | undefined => {
  const [first, ...rest] = where ?? [];
  if (first === undefined) {
    return undefined;
  }
  let expression = predicate(first);
  for (const condition of rest) {
    const next = predicate(condition);
    expression =
      condition.connector === "OR"
        ? sql<boolean>`(${expression} or ${next})`
        : sql<boolean>`(${expression} and ${next})`;
  }
  return expression;
};

const createPostgresImplementation = (
  db: Kysely<Database>,
): DatabasePluginImplementation => ({
  async create(input: CreateDatabaseImplementationInput) {
    switch (input.model) {
      case "bundles":
        return db
          .insertInto("bundles")
          .values(input.data)
          .returningAll()
          .executeTakeFirstOrThrow();
      case "bundle_patches":
        return db
          .insertInto("bundle_patches")
          .values(input.data)
          .returningAll()
          .executeTakeFirstOrThrow();
      case "bundle_events":
        return db
          .insertInto("bundle_events")
          .values(input.data)
          .returningAll()
          .executeTakeFirstOrThrow();
    }
  },
  async update(input: UpdateBundleDatabaseImplementationInput) {
    const where = buildWhere(input.where);
    let query = db.updateTable("bundles").set(input.update);
    if (where !== undefined) {
      query = query.where(where);
    }
    return (await query.returningAll().executeTakeFirst()) ?? null;
  },
  async delete(input: DeleteDatabaseImplementationInput) {
    const where = buildWhere(input.where);
    switch (input.model) {
      case "bundles": {
        let query = db.deleteFrom("bundles");
        if (where !== undefined) query = query.where(where);
        await query.execute();
        return;
      }
      case "bundle_patches": {
        let query = db.deleteFrom("bundle_patches");
        if (where !== undefined) query = query.where(where);
        await query.execute();
      }
    }
  },
  count: (input) => countPostgresRows(db, input, buildWhere(input.where)),
  async findOne(input: FindOneDatabaseImplementationInput) {
    const where = buildWhere(input.where);
    switch (input.model) {
      case "bundles": {
        let query = db.selectFrom("bundles").selectAll();
        if (where !== undefined) query = query.where(where);
        return (await query.executeTakeFirst()) ?? null;
      }
      case "bundle_patches": {
        let query = db.selectFrom("bundle_patches").selectAll();
        if (where !== undefined) query = query.where(where);
        return (await query.executeTakeFirst()) ?? null;
      }
      case "bundle_events": {
        let query = db.selectFrom("bundle_events").selectAll();
        if (where !== undefined) query = query.where(where);
        return (await query.executeTakeFirst()) ?? null;
      }
    }
  },
  findMany: (input) => findManyPostgresRows(db, input, buildWhere(input.where)),
  async getChannels() {
    const rows = await db
      .selectFrom("bundles")
      .select("channel")
      .distinct()
      .orderBy("channel", "asc")
      .execute();
    return rows.map(({ channel }) => channel);
  },
  transaction: (callback) =>
    db
      .transaction()
      .execute((transaction) =>
        callback(createPostgresImplementation(transaction)),
      ),
  onUnmount: () => db.destroy(),
});

export const postgres = (config: PostgresConfig) =>
  withAnalyticsProvider(
    createDatabasePlugin({
      name: "postgres",
      plugin: () => {
        const { dialect, ...poolConfig } = config;
        if (dialect !== undefined) {
          return createPostgresImplementation(
            new Kysely<Database>({ dialect }),
          );
        }
        const pool = new Pool(poolConfig);
        const implementation = createPostgresImplementation(
          new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }),
        );
        return {
          ...implementation,
          getUpdateInfo: (args) => getUpdateInfo(pool, args),
        };
      },
    }),
  );
