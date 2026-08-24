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
  createMongoApiKeyWhere,
  createMongoEventWhere,
  createMongoPatchWhere,
  createMongoReleaseCatalogWhere,
  createMongoReleaseWhere,
  createMongoSort,
} from "./mongodbQuery";

const findMongoRows = async (
  collections: MongoCollections,
  input: FindManyDatabaseImplementationInput,
  session?: ClientSession,
): Promise<readonly DatabaseImplementationResult[]> => {
  if (input.limit === 0) return [];
  const rawOrderBy = input.orderBy;
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
    case "api_keys": {
      const cursor = collections.apiKeys
        .find(createMongoApiKeyWhere(input.where), {
          projection: WITHOUT_MONGO_ID,
          ...mongoSessionOptions(session),
        })
        .skip(input.offset)
        .limit(input.limit);
      if (rawOrderBy === undefined) return cursor.toArray();
      if (needsInMemoryOrder) {
        const rows = await collections.apiKeys
          .find(createMongoApiKeyWhere(input.where), {
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
    case "releases": {
      const cursor = collections.releases
        .find(createMongoReleaseWhere(input.where), {
          projection: WITHOUT_MONGO_ID,
          ...mongoSessionOptions(session),
        })
        .skip(input.offset)
        .limit(input.limit);
      if (rawOrderBy === undefined) return cursor.toArray();
      if (needsInMemoryOrder) {
        const rows = await collections.releases
          .find(createMongoReleaseWhere(input.where), {
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
    case "release_catalogs": {
      const cursor = collections.releaseCatalogs
        .find(createMongoReleaseCatalogWhere(input.where), {
          projection: WITHOUT_MONGO_ID,
          ...mongoSessionOptions(session),
        })
        .skip(input.offset)
        .limit(input.limit);
      if (rawOrderBy === undefined) return cursor.toArray();
      if (needsInMemoryOrder) {
        const rows = await collections.releaseCatalogs
          .find(createMongoReleaseCatalogWhere(input.where), {
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
  "count" | "findMany" | "findOne"
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
      case "releases":
        return collections.releases.countDocuments(
          createMongoReleaseWhere(input.where),
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
      case "api_keys":
        return collections.apiKeys.findOne(
          createMongoApiKeyWhere(input.where),
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
      case "releases":
        return collections.releases.findOne(
          createMongoReleaseWhere(input.where),
          {
            projection: WITHOUT_MONGO_ID,
            ...mongoSessionOptions(session),
          },
        );
      case "release_catalogs":
        return collections.releaseCatalogs.findOne(
          createMongoReleaseCatalogWhere(input.where),
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
});
