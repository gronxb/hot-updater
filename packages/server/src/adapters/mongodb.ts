import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  DatabaseImplementationResult,
  DatabaseAdapterImplementation,
  FindManyDatabaseImplementationInput,
} from "@hot-updater/plugin-core";
import { createDatabaseAdapter } from "@hot-updater/plugin-core";
import type { Collection, MongoClient } from "mongodb";

import { createMongoMigrator } from "../db/fixedMigrator";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import {
  createMongoBundleWhere,
  createMongoChannelWhere,
  createMongoPatchWhere,
  createMongoSort,
} from "./mongodbQuery";
import { createMongoGetUpdateInfo } from "./mongodbUpdateInfo";

export interface MongoDBConfig {
  readonly client: MongoClient;
}

class MongoAdapterConstraintError extends Error {
  readonly name = "MongoAdapterConstraintError";

  constructor(readonly reason: string) {
    super(`MongoDB adapter constraint failed: ${reason}`);
  }
}

const WITHOUT_MONGO_ID = { _id: 0 } as const;

type MongoCollections = {
  readonly bundles: Collection<BundleRow>;
  readonly bundlePatches: Collection<BundlePatchRow>;
  readonly channels: Collection<ChannelRow>;
};

const createCollections = (client: MongoClient): MongoCollections => {
  const database = client.db();
  return {
    bundles: database.collection<BundleRow>("bundles"),
    bundlePatches: database.collection<BundlePatchRow>("bundle_patches"),
    channels: database.collection<ChannelRow>("channels"),
  };
};

const assertChannelExists = async (
  channels: Collection<ChannelRow>,
  channelId: string,
): Promise<void> => {
  const row = await channels.findOne(
    { id: channelId },
    { projection: WITHOUT_MONGO_ID },
  );
  if (row === null) {
    throw new MongoAdapterConstraintError(
      `channel "${channelId}" does not exist`,
    );
  }
};

const assertPatchReferences = async (
  bundles: Collection<BundleRow>,
  patch: BundlePatchRow,
): Promise<void> => {
  const ids = Array.from(new Set([patch.bundle_id, patch.base_bundle_id]));
  const count = await bundles.countDocuments({ id: { $in: ids } });
  if (count !== ids.length) {
    throw new MongoAdapterConstraintError(
      `patch "${patch.id}" references a missing bundle`,
    );
  }
};

const findMongoRows = async (
  collections: MongoCollections,
  input: FindManyDatabaseImplementationInput,
): Promise<readonly DatabaseImplementationResult[]> => {
  if (input.limit === 0) return [];
  switch (input.model) {
    case "bundles": {
      const cursor = collections.bundles
        .find(createMongoBundleWhere(input.where), {
          projection: WITHOUT_MONGO_ID,
        })
        .skip(input.offset)
        .limit(input.limit);
      const sort = createMongoSort(input.sortBy);
      return sort === undefined
        ? cursor.toArray()
        : cursor.sort(sort).toArray();
    }
    case "bundle_patches": {
      const cursor = collections.bundlePatches
        .find(createMongoPatchWhere(input.where), {
          projection: WITHOUT_MONGO_ID,
        })
        .skip(input.offset)
        .limit(input.limit);
      const sort = createMongoSort(input.sortBy);
      return sort === undefined
        ? cursor.toArray()
        : cursor.sort(sort).toArray();
    }
    case "channels": {
      const cursor = collections.channels
        .find(createMongoChannelWhere(input.where), {
          projection: WITHOUT_MONGO_ID,
        })
        .skip(input.offset)
        .limit(input.limit);
      const sort = createMongoSort(input.sortBy);
      return sort === undefined
        ? cursor.toArray()
        : cursor.sort(sort).toArray();
    }
  }
};

const createMongoImplementation = (
  collections: MongoCollections,
): DatabaseAdapterImplementation => ({
  create: async (input) => {
    switch (input.model) {
      case "bundles":
        await assertChannelExists(collections.channels, input.data.channel_id);
        await collections.bundles.insertOne(input.data);
        return input.data;
      case "bundle_patches":
        await assertPatchReferences(collections.bundles, input.data);
        await collections.bundlePatches.insertOne(input.data);
        return input.data;
      case "channels":
        await collections.channels.insertOne(input.data);
        return input.data;
    }
  },
  update: async (input) => {
    if (input.update.channel_id !== undefined) {
      await assertChannelExists(collections.channels, input.update.channel_id);
    }
    return collections.bundles.findOneAndUpdate(
      createMongoBundleWhere(input.where),
      { $set: input.update },
      { projection: WITHOUT_MONGO_ID, returnDocument: "after" },
    );
  },
  delete: async (input) => {
    switch (input.model) {
      case "bundle_patches":
        await collections.bundlePatches.deleteMany(
          createMongoPatchWhere(input.where),
        );
        return;
      case "bundles": {
        const rows = await collections.bundles
          .find(createMongoBundleWhere(input.where), {
            projection: { _id: 0, id: 1 },
          })
          .toArray();
        const ids = rows.map(({ id }) => id);
        if (ids.length === 0) return;
        const references = await collections.bundlePatches.countDocuments({
          $or: [{ bundle_id: { $in: ids } }, { base_bundle_id: { $in: ids } }],
        });
        if (references > 0) {
          throw new MongoAdapterConstraintError(
            "cannot delete a bundle referenced by a patch",
          );
        }
        await collections.bundles.deleteMany({ id: { $in: ids } });
      }
    }
  },
  count: (input) =>
    collections.bundles.countDocuments(createMongoBundleWhere(input.where)),
  findOne: async (input) => {
    switch (input.model) {
      case "bundles":
        return collections.bundles.findOne(
          createMongoBundleWhere(input.where),
          {
            projection: WITHOUT_MONGO_ID,
          },
        );
      case "channels":
        return collections.channels.findOne(
          createMongoChannelWhere(input.where),
          {
            projection: WITHOUT_MONGO_ID,
          },
        );
    }
  },
  findMany: (input) => findMongoRows(collections, input),
  getUpdateInfo: createMongoGetUpdateInfo(collections),
});

const createMongoAdapter = createDatabaseAdapter<MongoDBConfig>({
  name: "mongodb",
  factory: ({ client }) => createMongoImplementation(createCollections(client)),
});

export const mongoAdapter = (
  config: MongoDBConfig,
): DatabaseAdapterWithCapabilities =>
  Object.assign(createMongoAdapter(config), {
    adapterName: "mongodb",
    provider: "mongodb" as const,
    createMigrator: () => createMongoMigrator(config.client),
  });
