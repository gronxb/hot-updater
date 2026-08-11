import {
  DatabasePluginInputError,
  type TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core";
import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  sql,
  type SQLWrapper,
} from "drizzle-orm";

import {
  fromStoredBundleRow,
  toStoredBundleRow,
  toStoredBundleUpdate,
} from "./databasePluginUtils";
import type { DrizzleProvider } from "./drizzle";
import type { DrizzleDB, DrizzleTable } from "./drizzleLazyDB";
import { buildDrizzleWhere } from "./drizzleQuery";

class MissingDrizzleTableError extends Error {
  readonly name = "MissingDrizzleTableError";

  constructor(readonly table: string) {
    super(`Drizzle schema is missing table "${table}".`);
  }
}

class DrizzleAdapterInvariantError extends Error {
  readonly name = "DrizzleAdapterInvariantError";
}

export const getDrizzleTable = (db: DrizzleDB, name: string): DrizzleTable => {
  const table = db._.fullSchema[name];
  if (table === undefined) throw new MissingDrizzleTableError(name);
  return table;
};

const isSQLWrapper = (value: unknown): value is SQLWrapper =>
  typeof value === "object" &&
  value !== null &&
  "getSQL" in value &&
  typeof value.getSQL === "function";

export const getDrizzleColumn = (
  table: DrizzleTable,
  name: string,
): SQLWrapper => {
  const value = table[name];
  if (!isSQLWrapper(value)) {
    throw new MissingDrizzleTableError(`${name} column`);
  }
  return value;
};

const toOrderBy = (
  table: DrizzleTable,
  input: {
    orderBy?: readonly {
      field: string;
      direction: "asc" | "desc";
      nulls?: "first" | "last";
    }[];
    sortBy?: {
      field: string;
      direction: "asc" | "desc";
      nulls?: "first" | "last";
    };
  },
) => {
  const clauses = input.orderBy ?? (input.sortBy ? [input.sortBy] : undefined);
  return clauses?.flatMap((clause) => {
    const column = getDrizzleColumn(table, clause.field);
    const nulls =
      clause.nulls ?? (clause.direction === "asc" ? "last" : "first");
    return [
      nulls === "first"
        ? sql`${column} is null desc`
        : sql`${column} is null asc`,
      clause.direction === "asc" ? asc(column) : desc(column),
    ];
  });
};

export const createDrizzleCrud = (
  db: DrizzleDB,
  provider: DrizzleProvider,
): TransactionDatabasePluginImplementation => {
  const bundles = getDrizzleTable(db, "bundles");
  const patches = getDrizzleTable(db, "bundle_patches");
  const events = getDrizzleTable(db, "bundle_events");
  const clientAccessKeys = getDrizzleTable(db, "client_access_keys");
  return {
    async create(input) {
      switch (input.model) {
        case "bundles":
          await db
            .insert(bundles)
            .values(toStoredBundleRow(input.data, provider))
            .execute();
          return input.data;
        case "bundle_patches":
          await db.insert(patches).values(input.data).execute();
          return input.data;
        case "bundle_events":
          await db.insert(events).values(input.data).execute();
          return input.data;
        case "client_access_keys":
          await db.insert(clientAccessKeys).values(input.data).execute();
          return input.data;
      }
    },
    async update(input) {
      const selector = input.where[0];
      if (selector === undefined || typeof selector.value !== "string") {
        throw new DrizzleAdapterInvariantError();
      }
      if (input.model === "client_access_keys") {
        const idPredicate = eq(
          getDrizzleColumn(clientAccessKeys, "id"),
          selector.value,
        );
        await db
          .update(clientAccessKeys)
          .set(input.update)
          .where(idPredicate)
          .execute();
        return (
          (await db.query.client_access_keys.findFirst({
            where: idPredicate,
          })) ?? null
        );
      }
      if (
        input.update.target_app_version === null &&
        input.update.fingerprint_hash === null
      ) {
        throw new DrizzleAdapterInvariantError();
      }
      const idPredicate = eq(getDrizzleColumn(bundles, "id"), selector.value);
      const targetPredicate =
        input.update.target_app_version === null &&
        input.update.fingerprint_hash === undefined
          ? isNotNull(getDrizzleColumn(bundles, "fingerprint_hash"))
          : input.update.fingerprint_hash === null &&
              input.update.target_app_version === undefined
            ? isNotNull(getDrizzleColumn(bundles, "target_app_version"))
            : undefined;
      const predicate =
        targetPredicate === undefined
          ? idPredicate
          : and(idPredicate, targetPredicate);
      if (predicate === undefined) throw new DrizzleAdapterInvariantError();
      await db
        .update(bundles)
        .set(toStoredBundleUpdate(input.update, provider))
        .where(predicate)
        .execute();
      const stored = await db.query.bundles.findFirst({ where: idPredicate });
      if (stored === undefined) return null;
      const updated = fromStoredBundleRow(stored);
      if (
        (input.update.target_app_version !== undefined &&
          updated.target_app_version !== input.update.target_app_version) ||
        (input.update.fingerprint_hash !== undefined &&
          updated.fingerprint_hash !== input.update.fingerprint_hash)
      ) {
        throw new DrizzleAdapterInvariantError();
      }
      return updated;
    },
    async delete(input) {
      switch (input.model) {
        case "bundles": {
          const where = buildDrizzleWhere(provider, bundles, input.where);
          if (where === undefined) throw new DrizzleAdapterInvariantError();
          await db.delete(bundles).where(where).execute();
          return;
        }
        case "bundle_patches": {
          const where = buildDrizzleWhere(provider, patches, input.where);
          if (where === undefined) throw new DrizzleAdapterInvariantError();
          await db.delete(patches).where(where).execute();
          return;
        }
      }
    },
    async count(input) {
      if (input.distinct !== undefined) {
        throw new DatabasePluginInputError("invalid-operation");
      }
      switch (input.model) {
        case "bundles":
          return db.$count(
            bundles,
            buildDrizzleWhere(provider, bundles, input.where),
          );
        case "bundle_patches":
          return db.$count(
            patches,
            buildDrizzleWhere(provider, patches, input.where),
          );
      }
    },
    async findOne(input) {
      switch (input.model) {
        case "bundles": {
          const row = await db.query.bundles.findFirst({
            where: buildDrizzleWhere(provider, bundles, input.where),
          });
          return row === undefined ? null : fromStoredBundleRow(row);
        }
        case "bundle_patches":
          return (
            (await db.query.bundle_patches.findFirst({
              where: buildDrizzleWhere(provider, patches, input.where),
            })) ?? null
          );
        case "client_access_keys":
          return (
            (await db.query.client_access_keys.findFirst({
              where: buildDrizzleWhere(provider, clientAccessKeys, input.where),
            })) ?? null
          );
      }
    },
    async findMany(input) {
      if (input.distinctOn !== undefined) {
        throw new DatabasePluginInputError("invalid-operation");
      }
      switch (input.model) {
        case "bundles": {
          const rows = await db.query.bundles.findMany({
            where: buildDrizzleWhere(provider, bundles, input.where),
            orderBy: toOrderBy(bundles, input),
            limit: input.limit,
            offset: input.offset,
          });
          return rows.map(fromStoredBundleRow);
        }
        case "bundle_events":
          return db.query.bundle_events.findMany({
            where: buildDrizzleWhere(provider, events, input.where),
            orderBy: toOrderBy(events, input),
            limit: input.limit,
            offset: input.offset,
          });
        case "client_access_keys":
          return db.query.client_access_keys.findMany({
            where: buildDrizzleWhere(provider, clientAccessKeys, input.where),
            orderBy: toOrderBy(clientAccessKeys, input),
            limit: input.limit,
            offset: input.offset,
          });
        case "bundle_patches":
          return db.query.bundle_patches.findMany({
            where: buildDrizzleWhere(provider, patches, input.where),
            orderBy: toOrderBy(patches, input),
            limit: input.limit,
            offset: input.offset,
          });
      }
    },
  };
};
