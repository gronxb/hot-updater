import { createDatabasePlugin } from "@hot-updater/plugin-core";
import type {
  CreateDatabaseImplementationInput,
  DatabaseModel,
  DatabasePluginImplementation,
  DatabaseWhere,
  DeleteDatabaseImplementationInput,
  FindOneDatabaseImplementationInput,
  UpdateDatabaseImplementationInput,
} from "@hot-updater/plugin-core/internal";
import {
  createDatabasePluginAdapter,
  DatabaseRowReferencedError,
} from "@hot-updater/plugin-core/internal";
import {
  Kysely,
  PostgresDialect,
  sql,
  type Dialect,
  type RawBuilder,
} from "kysely";
import pg, { type PoolConfig } from "pg";

import { countPostgresRows, findManyPostgresRows } from "./postgresQuery";
import type { Database } from "./types";

const { Pool } = pg;

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

const isForeignKeyViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error, "code") === "23503";

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
      case "releases":
        return db
          .insertInto("releases")
          .values(input.data)
          .returningAll()
          .executeTakeFirstOrThrow();
      case "release_catalogs":
        return db
          .insertInto("release_catalogs")
          .values(input.data)
          .returningAll()
          .executeTakeFirstOrThrow();
      case "channels": {
        const query = db.insertInto("channels").values(input.data);
        const row = await (
          input.onConflict === "ignore"
            ? query.onConflict((conflict) =>
                conflict.column("name").doNothing(),
              )
            : query
        )
          .returningAll()
          .executeTakeFirst();
        return (
          row ??
          (await db
            .selectFrom("channels")
            .selectAll()
            .where("name", "=", input.data.name)
            .executeTakeFirstOrThrow())
        );
      }
      case "api_keys":
        const row = await (
          input.onConflict === "ignore"
            ? db
                .insertInto("api_keys")
                .values(input.data)
                .onConflict((conflict) => conflict.column("hash").doNothing())
            : db.insertInto("api_keys").values(input.data)
        )
          .returningAll()
          .executeTakeFirst();
        return (
          row ??
          (await db
            .selectFrom("api_keys")
            .selectAll()
            .where("hash", "=", input.data.hash)
            .executeTakeFirstOrThrow())
        );
    }
  },
  async update(input: UpdateDatabaseImplementationInput) {
    const where = buildWhere(input.where);
    if (input.model === "api_keys") {
      let query = db.updateTable("api_keys").set(input.update);
      if (where !== undefined) query = query.where(where);
      return (await query.returningAll().executeTakeFirst()) ?? null;
    }
    if (input.model === "releases") {
      let query = db.updateTable("releases").set(input.update);
      if (where !== undefined) query = query.where(where);
      return (await query.returningAll().executeTakeFirst()) ?? null;
    }
    if (input.model === "release_catalogs") {
      let query = db.updateTable("release_catalogs").set(input.update);
      if (where !== undefined) query = query.where(where);
      return (await query.returningAll().executeTakeFirst()) ?? null;
    }
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
        return;
      }
      case "channels": {
        let query = db.deleteFrom("channels");
        if (where !== undefined) query = query.where(where);
        try {
          await query.execute();
        } catch (error) {
          if (isForeignKeyViolation(error)) {
            throw new DatabaseRowReferencedError();
          }
          throw error;
        }
      }
      case "releases": {
        let query = db.deleteFrom("releases");
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
      case "api_keys": {
        let query = db.selectFrom("api_keys").selectAll();
        if (where !== undefined) query = query.where(where);
        return (await query.executeTakeFirst()) ?? null;
      }
      case "bundle_patches": {
        let query = db.selectFrom("bundle_patches").selectAll();
        if (where !== undefined) query = query.where(where);
        return (await query.executeTakeFirst()) ?? null;
      }
      case "channels": {
        let query = db.selectFrom("channels").selectAll();
        if (where !== undefined) query = query.where(where);
        return (await query.executeTakeFirst()) ?? null;
      }
      case "releases": {
        let query = db.selectFrom("releases").selectAll();
        if (where !== undefined) query = query.where(where);
        return (await query.executeTakeFirst()) ?? null;
      }
      case "release_catalogs": {
        let query = db.selectFrom("release_catalogs").selectAll();
        if (where !== undefined) query = query.where(where);
        return (await query.executeTakeFirst()) ?? null;
      }
    }
  },
  findMany: (input) => findManyPostgresRows(db, input, buildWhere(input.where)),
  async insertChannel({ row }) {
    const inserted = await db
      .insertInto("channels")
      .values(row)
      .onConflict((conflict) => conflict.column("name").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted !== undefined) return { row: inserted, inserted: true };
    const existing = await db
      .selectFrom("channels")
      .selectAll()
      .where("name", "=", row.name)
      .executeTakeFirstOrThrow();
    return { row: existing, inserted: false };
  },
  async deleteChannel({ id }) {
    try {
      const deleted = await db
        .deleteFrom("channels")
        .where("id", "=", id)
        .returning("id")
        .executeTakeFirst();
      return deleted === undefined
        ? { deleted: false, reason: "not_found" }
        : { deleted: true };
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        return { deleted: false, reason: "not_empty" };
      }
      throw error;
    }
  },
  transaction: (callback) =>
    db
      .transaction()
      .execute((transaction) =>
        callback(createPostgresImplementation(transaction)),
      ),
  dispose: () => db.destroy(),
});

export const postgres = (config: PostgresConfig) => {
  const { dialect, ...poolConfig } = config;
  const implementation =
    dialect !== undefined
      ? createPostgresImplementation(new Kysely<Database>({ dialect }))
      : (() => {
          const pool = new Pool(poolConfig);
          return createPostgresImplementation(
            new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }),
          );
        })();
  const adapter = createDatabasePluginAdapter("postgres", implementation);
  return createDatabasePlugin({
    name: "postgres",
    models: adapter.models,
    commit: adapter.commit,
    dispose: adapter.dispose,
  });
};
