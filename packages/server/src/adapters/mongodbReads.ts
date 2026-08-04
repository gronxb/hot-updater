import {
  DatabasePluginInputError,
  type DatabaseImplementationResult,
  type DatabasePluginImplementation,
  type FindManyDatabaseImplementationInput,
} from "@hot-updater/plugin-core";
import type { ClientSession } from "mongodb";

import { hasNullOrderOverrides, sortRowsByOrder } from "./databasePluginUtils";
import {
  activeBundleFilter,
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
  const needsInMemoryOrder = hasNullOrderOverrides(rawOrderBy);
  switch (input.model) {
    case "bundles": {
      const cursor = collections.bundles
        .find(activeBundleFilter(createMongoBundleWhere(input.where)), {
          projection: WITHOUT_INTERNAL_FIELDS,
          ...mongoSessionOptions(session),
        })
        .skip(input.offset)
        .limit(input.limit);
      if (rawOrderBy === undefined) return cursor.toArray();
      if (needsInMemoryOrder) {
        const rows = await collections.bundles
          .find(activeBundleFilter(createMongoBundleWhere(input.where)), {
            projection: WITHOUT_INTERNAL_FIELDS,
            ...mongoSessionOptions(session),
          })
          .toArray();
        return sortRowsByOrder(rows, rawOrderBy).slice(
          input.offset,
          input.offset + input.limit,
        );
      }
      const sort = createMongoSort(input);
      return sort === undefined
        ? cursor.toArray()
        : cursor.sort(sort).toArray();
    }
    case "bundle_patches": {
      const cursor = collections.bundlePatches
        .find(createMongoPatchWhere(input.where), {
          projection: WITHOUT_MONGO_ID,
          ...mongoSessionOptions(session),
        })
        .skip(input.offset)
        .limit(input.limit);
      if (rawOrderBy === undefined) return cursor.toArray();
      if (needsInMemoryOrder) {
        const rows = await collections.bundlePatches
          .find(createMongoPatchWhere(input.where), {
            projection: WITHOUT_MONGO_ID,
            ...mongoSessionOptions(session),
          })
          .toArray();
        return sortRowsByOrder(rows, rawOrderBy).slice(
          input.offset,
          input.offset + input.limit,
        );
      }
      const sort = createMongoSort(input);
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
    if (input.distinct !== undefined) {
      throw new DatabasePluginInputError("invalid-operation");
    }
    switch (input.model) {
      case "bundles":
        return collections.bundles.countDocuments(
          activeBundleFilter(createMongoBundleWhere(input.where)),
          mongoSessionOptions(session),
        );
      case "bundle_patches":
        return collections.bundlePatches.countDocuments(
          createMongoPatchWhere(input.where),
          mongoSessionOptions(session),
        );
    }
  },
  findOne: async (input) => {
    switch (input.model) {
      case "bundles":
        return collections.bundles.findOne(
          activeBundleFilter(createMongoBundleWhere(input.where)),
          {
            projection: WITHOUT_INTERNAL_FIELDS,
            ...mongoSessionOptions(session),
          },
        );
      case "bundle_patches":
        return collections.bundlePatches.findOne(
          createMongoPatchWhere(input.where),
          {
            projection: WITHOUT_MONGO_ID,
            ...mongoSessionOptions(session),
          },
        );
    }
  },
  findMany: (input) => {
    if (input.distinctOn !== undefined) {
      throw new DatabasePluginInputError("invalid-operation");
    }
    return findMongoRows(collections, input, session);
  },
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
