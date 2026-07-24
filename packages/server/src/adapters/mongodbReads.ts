import type {
  DatabaseImplementationResult,
  DatabasePluginImplementation,
  FindManyDatabaseImplementationInput,
} from "@hot-updater/plugin-core";
import type { ClientSession } from "mongodb";

import { hasNullOrderOverrides, sortRowsByOrder } from "./databasePluginUtils";
import {
  activeBundleFilter,
  createMongoAppendOnlyWhere,
  type MongoCollections,
  MongoAdapterConstraintError,
  mongoSessionOptions,
  WITHOUT_INTERNAL_FIELDS,
  WITHOUT_MONGO_ID,
} from "./mongodbCollections";
import {
  createMongoBundleWhere,
  createMongoPatchWhere,
  createMongoSort,
} from "./mongodbQuery";
import { createMongoGetUpdateInfo } from "./mongodbUpdateInfo";

const createDistinctKey = (row: object, fields: readonly string[]): string =>
  JSON.stringify(fields.map((field) => Reflect.get(row, field) ?? null));

const applyDistinctOnRows = <TRow extends object>(
  rows: readonly TRow[],
  fields: readonly string[],
  offset: number,
  limit: number,
): TRow[] => {
  const seen = new Set<string>();
  const distinctRows: TRow[] = [];
  for (const row of rows) {
    const key = createDistinctKey(row, fields);
    if (seen.has(key)) continue;
    seen.add(key);
    distinctRows.push(row);
  }
  return distinctRows.slice(offset, offset + limit);
};

const countDistinctRows = <TRow extends object>(
  rows: readonly TRow[],
  fields: readonly string[],
): number => new Set(rows.map((row) => createDistinctKey(row, fields))).size;

const findMongoRows = async (
  collections: MongoCollections,
  input: FindManyDatabaseImplementationInput,
  session?: ClientSession,
): Promise<readonly DatabaseImplementationResult[]> => {
  if (input.limit === 0) return [];
  const rawOrderBy =
    "orderBy" in input && input.orderBy
      ? input.orderBy
      : "sortBy" in input && input.sortBy
        ? [input.sortBy]
        : undefined;
  const needsInMemoryOrder = hasNullOrderOverrides(rawOrderBy as never);
  switch (input.model) {
    case "bundles": {
      const cursor = collections.bundles
        .find(
          activeBundleFilter(createMongoBundleWhere(input.where as never)),
          {
            projection: WITHOUT_INTERNAL_FIELDS,
            ...mongoSessionOptions(session),
          },
        )
        .skip(input.offset)
        .limit(input.limit);
      if (rawOrderBy === undefined) return cursor.toArray();
      if (needsInMemoryOrder) {
        const rows = await collections.bundles
          .find(
            activeBundleFilter(createMongoBundleWhere(input.where as never)),
            {
              projection: WITHOUT_INTERNAL_FIELDS,
              ...mongoSessionOptions(session),
            },
          )
          .toArray();
        return sortRowsByOrder(rows, rawOrderBy as never).slice(
          input.offset,
          input.offset + input.limit,
        );
      }
      const sort = createMongoSort(input as never);
      return sort === undefined
        ? cursor.toArray()
        : cursor.sort(sort).toArray();
    }
    case "bundle_patches": {
      const cursor = collections.bundlePatches
        .find(createMongoPatchWhere(input.where as never), {
          projection: WITHOUT_MONGO_ID,
          ...mongoSessionOptions(session),
        })
        .skip(input.offset)
        .limit(input.limit);
      if (rawOrderBy === undefined) return cursor.toArray();
      if (needsInMemoryOrder) {
        const rows = await collections.bundlePatches
          .find(createMongoPatchWhere(input.where as never), {
            projection: WITHOUT_MONGO_ID,
            ...mongoSessionOptions(session),
          })
          .toArray();
        return sortRowsByOrder(rows, rawOrderBy as never).slice(
          input.offset,
          input.offset + input.limit,
        );
      }
      const sort = createMongoSort(input as never);
      return sort === undefined
        ? cursor.toArray()
        : cursor.sort(sort).toArray();
    }
    case "bundle_events": {
      if (input.distinctOn || needsInMemoryOrder) {
        const rows = await collections.appendOnlyRows
          .find(createMongoAppendOnlyWhere(input.where), {
            projection: WITHOUT_MONGO_ID,
            ...mongoSessionOptions(session),
          })
          .toArray();
        const orderedRows = sortRowsByOrder(rows, rawOrderBy as never);
        if (input.distinctOn) {
          return applyDistinctOnRows(
            orderedRows,
            input.distinctOn.fields,
            input.offset,
            input.limit,
          );
        }
        return orderedRows.slice(input.offset, input.offset + input.limit);
      }
      const cursor = collections.appendOnlyRows.find(
        createMongoAppendOnlyWhere(input.where),
        {
          projection: WITHOUT_MONGO_ID,
          ...mongoSessionOptions(session),
        },
      );
      const sort = createMongoSort(input as never);
      cursor.skip(input.offset).limit(input.limit);
      return sort === undefined
        ? cursor.toArray()
        : cursor.sort(sort).toArray();
    }
  }
};

type MongoReadImplementation = Pick<
  DatabasePluginImplementation,
  "count" | "findMany" | "findOne" | "getChannels" | "getUpdateInfo"
>;

export const createMongoReads = (
  collections: MongoCollections,
  session?: ClientSession,
): MongoReadImplementation => ({
  count: async (input) => {
    switch (input.model) {
      case "bundles":
        return collections.bundles.countDocuments(
          activeBundleFilter(createMongoBundleWhere(input.where as never)),
          mongoSessionOptions(session),
        );
      case "bundle_patches":
        return collections.bundlePatches.countDocuments(
          createMongoPatchWhere(input.where as never),
          mongoSessionOptions(session),
        );
      case "bundle_events": {
        if (input.distinct && input.distinct.length > 0) {
          const rows = await collections.appendOnlyRows
            .find(createMongoAppendOnlyWhere(input.where), {
              projection: WITHOUT_MONGO_ID,
              ...mongoSessionOptions(session),
            })
            .toArray();
          return countDistinctRows(rows, input.distinct);
        }
        return collections.appendOnlyRows.countDocuments(
          createMongoAppendOnlyWhere(input.where),
          mongoSessionOptions(session),
        );
      }
    }
  },
  findOne: async (input) => {
    switch (input.model) {
      case "bundles":
        return collections.bundles.findOne(
          activeBundleFilter(createMongoBundleWhere(input.where as never)),
          {
            projection: WITHOUT_INTERNAL_FIELDS,
            ...mongoSessionOptions(session),
          },
        );
      case "bundle_patches":
        return collections.bundlePatches.findOne(
          createMongoPatchWhere(input.where as never),
          {
            projection: WITHOUT_MONGO_ID,
            ...mongoSessionOptions(session),
          },
        );
      case "bundle_events":
        return collections.appendOnlyRows.findOne(
          createMongoAppendOnlyWhere(input.where),
          {
            projection: WITHOUT_MONGO_ID,
            ...mongoSessionOptions(session),
          },
        );
    }
  },
  findMany: (input) => findMongoRows(collections, input, session),
  getChannels: async () => {
    const channels = await collections.bundles.distinct(
      "channel",
      activeBundleFilter({}),
      mongoSessionOptions(session),
    );
    if (!channels.every((channel) => typeof channel === "string")) {
      throw new MongoAdapterConstraintError(
        "bundles.channel must contain only strings",
      );
    }
    return channels.sort();
  },
  getUpdateInfo: createMongoGetUpdateInfo(collections),
});
