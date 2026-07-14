import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  DatabaseImplementationResult,
  DatabaseAdapterImplementation,
  FindManyDatabaseImplementationInput,
} from "@hot-updater/plugin-core";
import { createDatabaseAdapter, createUUIDv7 } from "@hot-updater/plugin-core";
import type { Collection, MongoClient } from "mongodb";

import { createMongoMigrator } from "../db/fixedMigrator";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import { hasNullOrderOverrides, sortRowsByOrder } from "./databaseAdapterUtils";
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
const DELETION_TOKEN_FIELD = "_hot_updater_deletion_token" as const;

type MongoBundleDocument = BundleRow & {
  readonly [DELETION_TOKEN_FIELD]?: string;
};

const WITHOUT_INTERNAL_FIELDS = {
  ...WITHOUT_MONGO_ID,
  [DELETION_TOKEN_FIELD]: 0,
} as const;

const activeBundleFilter = (where: object) => ({
  $and: [where, { [DELETION_TOKEN_FIELD]: { $exists: false } }],
});

type MongoCollections = {
  readonly bundles: Collection<MongoBundleDocument>;
  readonly bundlePatches: Collection<BundlePatchRow>;
  readonly channels: Collection<ChannelRow>;
  readonly bundleEvents: Collection<BundleEventRow>;
};

const createCollections = (client: MongoClient): MongoCollections => {
  const database = client.db();
  return {
    bundles: database.collection<MongoBundleDocument>("bundles"),
    bundlePatches: database.collection<BundlePatchRow>("bundle_patches"),
    channels: database.collection<ChannelRow>("channels"),
    bundleEvents: database.collection<BundleEventRow>("bundle_events"),
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
  bundles: Collection<MongoBundleDocument>,
  patch: BundlePatchRow,
): Promise<void> => {
  const ids = Array.from(new Set([patch.bundle_id, patch.base_bundle_id]));
  const count = await bundles.countDocuments(
    activeBundleFilter({ id: { $in: ids } }),
  );
  if (count !== ids.length) {
    throw new MongoAdapterConstraintError(
      `patch "${patch.id}" references a missing bundle`,
    );
  }
};

const assertBundleTarget = (
  bundle: Pick<BundleRow, "fingerprint_hash" | "target_app_version">,
): void => {
  if (bundle.target_app_version === null && bundle.fingerprint_hash === null) {
    throw new MongoAdapterConstraintError(
      "bundles.version-or-fingerprint.check",
    );
  }
};

const targetConstraintFilter = (
  update: Parameters<DatabaseAdapterImplementation["update"]>[0]["update"],
): object => {
  if (
    update.target_app_version === null &&
    update.fingerprint_hash === undefined
  ) {
    return { fingerprint_hash: { $ne: null } };
  }
  if (
    update.fingerprint_hash === null &&
    update.target_app_version === undefined
  ) {
    return { target_app_version: { $ne: null } };
  }
  return {};
};

const createMongoEventWhere = (where: unknown): object =>
  createMongoBundleWhere(where as never) as object;

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
          },
        )
        .skip(input.offset)
        .limit(input.limit);
      if (rawOrderBy === undefined) {
        return cursor.toArray();
      }
      if (needsInMemoryOrder) {
        const rows = await collections.bundles
          .find(
            activeBundleFilter(createMongoBundleWhere(input.where as never)),
            {
              projection: WITHOUT_INTERNAL_FIELDS,
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
        })
        .skip(input.offset)
        .limit(input.limit);
      if (rawOrderBy === undefined) {
        return cursor.toArray();
      }
      if (needsInMemoryOrder) {
        const rows = await collections.bundlePatches
          .find(createMongoPatchWhere(input.where as never), {
            projection: WITHOUT_MONGO_ID,
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
    case "channels": {
      const cursor = collections.channels
        .find(createMongoChannelWhere(input.where as never), {
          projection: WITHOUT_MONGO_ID,
        })
        .skip(input.offset)
        .limit(input.limit);
      if (rawOrderBy === undefined) {
        return cursor.toArray();
      }
      if (needsInMemoryOrder) {
        const rows = await collections.channels
          .find(createMongoChannelWhere(input.where as never), {
            projection: WITHOUT_MONGO_ID,
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
        const rows = (await collections.bundleEvents
          .find(createMongoEventWhere(input.where), {
            projection: WITHOUT_MONGO_ID,
          })
          .toArray()) as BundleEventRow[];
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
      const cursor = collections.bundleEvents.find(
        createMongoEventWhere(input.where),
        {
          projection: WITHOUT_MONGO_ID,
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

const createMongoImplementation = (
  collections: MongoCollections,
): DatabaseAdapterImplementation => ({
  create: async (input) => {
    switch (input.model) {
      case "bundles":
        assertBundleTarget(input.data);
        await assertChannelExists(collections.channels, input.data.channel_id);
        await collections.bundles.insertOne(input.data);
        return input.data;
      case "bundle_patches":
        await assertPatchReferences(collections.bundles, input.data);
        await collections.bundlePatches.insertOne(input.data);
        try {
          await assertPatchReferences(collections.bundles, input.data);
        } catch (error) {
          await collections.bundlePatches.deleteMany({ id: input.data.id });
          throw error;
        }
        return input.data;
      case "channels":
        await collections.channels.insertOne(input.data);
        return input.data;
      case "bundle_events":
        await collections.bundleEvents.insertOne(input.data);
        return input.data;
    }
  },
  update: async (input) => {
    if (
      input.update.target_app_version === null &&
      input.update.fingerprint_hash === null
    ) {
      throw new MongoAdapterConstraintError(
        "bundles.version-or-fingerprint.check",
      );
    }
    if (input.update.channel_id !== undefined) {
      await assertChannelExists(collections.channels, input.update.channel_id);
    }
    return collections.bundles.findOneAndUpdate(
      activeBundleFilter({
        $and: [
          createMongoBundleWhere(input.where as never),
          targetConstraintFilter(input.update),
        ],
      }),
      { $set: input.update },
      { projection: WITHOUT_INTERNAL_FIELDS, returnDocument: "after" },
    );
  },
  delete: async (input) => {
    switch (input.model) {
      case "bundle_patches":
        await collections.bundlePatches.deleteMany(
          createMongoPatchWhere(input.where as never),
        );
        return;
      case "bundles": {
        const deletionToken = createUUIDv7();
        await collections.bundles.updateMany(
          createMongoBundleWhere(input.where as never),
          {
            $set: { [DELETION_TOKEN_FIELD]: deletionToken },
          },
        );
        const rows = await collections.bundles
          .find(
            { [DELETION_TOKEN_FIELD]: deletionToken },
            { projection: { _id: 0, id: 1 } },
          )
          .toArray();
        const ids = rows.map(({ id }) => id);
        if (ids.length === 0) return;
        await collections.bundlePatches.deleteMany({
          $or: [{ bundle_id: { $in: ids } }, { base_bundle_id: { $in: ids } }],
        });
        await collections.bundles.deleteMany({
          [DELETION_TOKEN_FIELD]: deletionToken,
        });
        return;
      }
    }
  },
  count: async (input) => {
    switch (input.model) {
      case "bundles":
        return collections.bundles.countDocuments(
          activeBundleFilter(createMongoBundleWhere(input.where as never)),
        );
      case "bundle_patches":
        return collections.bundlePatches.countDocuments(
          createMongoPatchWhere(input.where as never),
        );
      case "channels":
        return collections.channels.countDocuments(
          createMongoChannelWhere(input.where as never),
        );
      case "bundle_events": {
        if (input.distinct && input.distinct.length > 0) {
          const rows = (await collections.bundleEvents
            .find(createMongoEventWhere(input.where), {
              projection: WITHOUT_MONGO_ID,
            })
            .toArray()) as BundleEventRow[];
          return countDistinctRows(rows, input.distinct);
        }
        return collections.bundleEvents.countDocuments(
          createMongoEventWhere(input.where),
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
          },
        );
      case "bundle_patches":
        return collections.bundlePatches.findOne(
          createMongoPatchWhere(input.where as never),
          {
            projection: WITHOUT_MONGO_ID,
          },
        );
      case "channels":
        return collections.channels.findOne(
          createMongoChannelWhere(input.where as never),
          {
            projection: WITHOUT_MONGO_ID,
          },
        );
      case "bundle_events":
        return collections.bundleEvents.findOne(
          createMongoEventWhere(input.where),
          {
            projection: WITHOUT_MONGO_ID,
          },
        );
    }
  },
  findMany: (input) => findMongoRows(collections, input),
  getUpdateInfo: createMongoGetUpdateInfo(collections),
});

export const mongoAdapter = (
  config: MongoDBConfig,
): DatabaseAdapterWithCapabilities =>
  Object.assign(
    createDatabaseAdapter({
      name: "mongodb",
      adapter: () =>
        createMongoImplementation(createCollections(config.client)),
    }),
    {
      adapterName: "mongodb",
      provider: "mongodb" as const,
      createMigrator: () => createMongoMigrator(config.client),
    },
  );
