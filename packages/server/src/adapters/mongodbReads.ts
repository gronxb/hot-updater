import { DatabasePluginInputError } from "@hot-updater/plugin-core";
import type {
  DatabaseImplementationResult,
  DatabasePluginImplementation,
  FindManyDatabaseImplementationInput,
} from "@hot-updater/plugin-core/internal";
import type { ClientSession } from "mongodb";

import { hasNullOrderOverrides, sortRowsByOrder } from "./databasePluginUtils";
import {
  activeBundleFilter,
  type MongoCollections,
  mongoSessionOptions,
  WITHOUT_INTERNAL_FIELDS,
  WITHOUT_MONGO_ID,
} from "./mongodbCollections";
import {
  createMongoBundleWhere,
  createMongoChannelWhere,
  createMongoClientAccessKeyWhere,
  createMongoEventWhere,
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
    case "bundle_events": {
      const cursor = collections.bundleEvents
        .find(createMongoEventWhere(input.where), {
          projection: WITHOUT_MONGO_ID,
          ...mongoSessionOptions(session),
        })
        .skip(input.offset)
        .limit(input.limit);
      if (rawOrderBy === undefined) return cursor.toArray();
      if (needsInMemoryOrder) {
        const rows = await collections.bundleEvents
          .find(createMongoEventWhere(input.where), {
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
    case "client_access_keys": {
      const cursor = collections.clientAccessKeys
        .find(createMongoClientAccessKeyWhere(input.where), {
          projection: WITHOUT_MONGO_ID,
          ...mongoSessionOptions(session),
        })
        .skip(input.offset)
        .limit(input.limit);
      if (rawOrderBy === undefined) return cursor.toArray();
      if (needsInMemoryOrder) {
        const rows = await collections.clientAccessKeys
          .find(createMongoClientAccessKeyWhere(input.where), {
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
    case "channels": {
      const cursor = collections.channels
        .find(createMongoChannelWhere(input.where), {
          projection: WITHOUT_MONGO_ID,
          ...mongoSessionOptions(session),
        })
        .skip(input.offset)
        .limit(input.limit);
      if (rawOrderBy === undefined) return cursor.toArray();
      if (needsInMemoryOrder) {
        const rows = await collections.channels
          .find(createMongoChannelWhere(input.where), {
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
  "count" | "findMany" | "findOne" | "getUpdateInfo"
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
      case "channels":
        return collections.channels.findOne(
          createMongoChannelWhere(input.where),
          {
            projection: WITHOUT_MONGO_ID,
            ...mongoSessionOptions(session),
          },
        );
      case "client_access_keys":
        return collections.clientAccessKeys.findOne(
          createMongoClientAccessKeyWhere(input.where),
          {
            projection: WITHOUT_MONGO_ID,
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
  getUpdateInfo: createMongoGetUpdateInfo(collections),
});
