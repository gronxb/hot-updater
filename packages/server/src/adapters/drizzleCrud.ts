import type { TransactionDatabaseAdapterImplementation } from "@hot-updater/plugin-core";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  or,
  type SQLWrapper,
} from "drizzle-orm";

import {
  fromStoredBundleRow,
  toStoredBundleRow,
  toStoredBundleUpdate,
} from "./databaseAdapterUtils";
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

export const createDrizzleCrud = (
  db: DrizzleDB,
  provider: DrizzleProvider,
): TransactionDatabaseAdapterImplementation => {
  const bundles = getDrizzleTable(db, "bundles");
  const patches = getDrizzleTable(db, "bundle_patches");
  const channels = getDrizzleTable(db, "channels");
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
        case "channels":
          await db.insert(channels).values(input.data).execute();
          return input.data;
      }
    },
    async update(input) {
      const selector = input.where[0];
      if (selector === undefined || typeof selector.value !== "string") {
        throw new DrizzleAdapterInvariantError();
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
          const matchingBundles = await db.query.bundles.findMany({ where });
          const bundleIds = matchingBundles.map(({ id }) => id);
          if (bundleIds.length === 0) return;
          const patchWhere = or(
            inArray(getDrizzleColumn(patches, "bundle_id"), bundleIds),
            inArray(getDrizzleColumn(patches, "base_bundle_id"), bundleIds),
          );
          if (patchWhere === undefined) {
            throw new DrizzleAdapterInvariantError();
          }
          await db.delete(patches).where(patchWhere).execute();
          await db.delete(bundles).where(where).execute();
          return;
        }
        case "bundle_patches": {
          const where = buildDrizzleWhere(provider, patches, input.where);
          if (where === undefined) throw new DrizzleAdapterInvariantError();
          await db.delete(patches).where(where).execute();
        }
      }
    },
    count: (input) =>
      db.$count(
        bundles,
        buildDrizzleWhere(provider, bundles, input.where ?? []),
      ),
    async findOne(input) {
      switch (input.model) {
        case "bundles": {
          const row = await db.query.bundles.findFirst({
            where: buildDrizzleWhere(provider, bundles, input.where ?? []),
          });
          return row === undefined ? null : fromStoredBundleRow(row);
        }
        case "channels":
          return (
            (await db.query.channels.findFirst({
              where: buildDrizzleWhere(provider, channels, input.where ?? []),
            })) ?? null
          );
      }
    },
    async findMany(input) {
      switch (input.model) {
        case "bundles": {
          const rows = await db.query.bundles.findMany({
            where: buildDrizzleWhere(provider, bundles, input.where ?? []),
            orderBy: input.sortBy
              ? [
                  input.sortBy.direction === "asc"
                    ? asc(getDrizzleColumn(bundles, input.sortBy.field))
                    : desc(getDrizzleColumn(bundles, input.sortBy.field)),
                ]
              : undefined,
            limit: input.limit,
            offset: input.offset,
          });
          return rows.map(fromStoredBundleRow);
        }
        case "bundle_patches":
          return db.query.bundle_patches.findMany({
            where: buildDrizzleWhere(provider, patches, input.where ?? []),
            orderBy: input.sortBy
              ? [
                  input.sortBy.direction === "asc"
                    ? asc(getDrizzleColumn(patches, input.sortBy.field))
                    : desc(getDrizzleColumn(patches, input.sortBy.field)),
                ]
              : undefined,
            limit: input.limit,
            offset: input.offset,
          });
        case "channels":
          return db.query.channels.findMany({
            where: buildDrizzleWhere(provider, channels, input.where ?? []),
            orderBy: input.sortBy
              ? [
                  input.sortBy.direction === "asc"
                    ? asc(getDrizzleColumn(channels, input.sortBy.field))
                    : desc(getDrizzleColumn(channels, input.sortBy.field)),
                ]
              : undefined,
            limit: input.limit,
            offset: input.offset,
          });
      }
    },
  };
};
