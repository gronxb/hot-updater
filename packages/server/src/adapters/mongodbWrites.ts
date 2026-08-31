import type { BundlePatchRow } from "@hot-updater/plugin-core";
import {
  createUUIDv7,
  DatabasePluginInputError,
} from "@hot-updater/plugin-core";
import type { DatabasePluginImplementation } from "@hot-updater/plugin-core/internal";
import type { ClientSession, Collection } from "mongodb";

import {
  activeBundleFilter,
  DELETION_TOKEN_FIELD,
  type MongoBundleDocument,
  type MongoCollections,
  MongoAdapterConstraintError,
  mongoSessionOptions,
  WITHOUT_INTERNAL_FIELDS,
} from "./mongodbCollections";
import { assertMongoInsightsEventRow } from "./mongodbInsights";
import {
  createMongoBundleWhere,
  createMongoChannelWhere,
  createMongoApiKeyWhere,
  createMongoPatchWhere,
  createMongoReleaseCatalogWhere,
  createMongoReleaseWhere,
} from "./mongodbQuery";

const assertPatchReferences = async (
  bundles: Collection<MongoBundleDocument>,
  patch: BundlePatchRow,
  session?: ClientSession,
): Promise<void> => {
  const ids = Array.from(new Set([patch.bundle_id, patch.base_bundle_id]));
  const count = await bundles.countDocuments(
    activeBundleFilter({ id: { $in: ids } }),
    mongoSessionOptions(session),
  );
  if (count !== ids.length) {
    throw new MongoAdapterConstraintError(
      `patch "${patch.id}" references a missing bundle`,
    );
  }
};

type MongoWriteImplementation = Pick<
  DatabasePluginImplementation,
  "create" | "delete" | "deleteChannel" | "insertChannel" | "update"
>;

export const createMongoWrites = (
  collections: MongoCollections,
  session?: ClientSession,
): MongoWriteImplementation => ({
  deleteChannel: async ({ id }) => {
    if (session === undefined) {
      throw new MongoAdapterConstraintError(
        "channel deletion requires transaction support",
      );
    }
    const locked = await collections.channels.updateOne(
      { id },
      { $set: { id } },
      mongoSessionOptions(session),
    );
    if (locked.matchedCount !== 1) {
      return { deleted: false, reason: "not_found" };
    }
    const referencedReleases = await collections.releases.countDocuments(
      { channel_id: id },
      mongoSessionOptions(session),
    );
    if (referencedReleases > 0) {
      return { deleted: false, reason: "not_empty" };
    }
    await collections.channels.deleteMany({ id }, mongoSessionOptions(session));
    return { deleted: true };
  },
  insertChannel: async (input) => {
    const result = await collections.channels.updateOne(
      { name: input.row.name },
      { $setOnInsert: input.row },
      { upsert: true, ...mongoSessionOptions(session) },
    );
    const row = await collections.channels.findOne(
      { name: input.row.name },
      mongoSessionOptions(session),
    );
    if (row === null) {
      throw new MongoAdapterConstraintError("channels.insert.return-existing");
    }
    return { row, inserted: result.upsertedCount === 1 };
  },
  create: async (input) => {
    switch (input.model) {
      case "bundles":
        await collections.bundles.insertOne(
          input.data,
          mongoSessionOptions(session),
        );
        return input.data;
      case "bundle_patches":
        await assertPatchReferences(collections.bundles, input.data, session);
        await collections.bundlePatches.insertOne(
          input.data,
          mongoSessionOptions(session),
        );
        try {
          await assertPatchReferences(collections.bundles, input.data, session);
        } catch (error) {
          await collections.bundlePatches.deleteMany(
            { id: input.data.id },
            mongoSessionOptions(session),
          );
          throw error;
        }
        return input.data;
      case "bundle_events":
        try {
          assertMongoInsightsEventRow(input.data);
        } catch (error) {
          if (error instanceof DatabasePluginInputError)
            throw new DatabasePluginInputError("invalid-data");
          throw error;
        }
        await collections.bundleEvents.insertOne(
          input.data,
          mongoSessionOptions(session),
        );
        return input.data;
      case "releases":
        await collections.releases.insertOne(
          input.data,
          mongoSessionOptions(session),
        );
        return input.data;
      case "release_catalogs":
        await collections.releaseCatalogs.insertOne(
          input.data,
          mongoSessionOptions(session),
        );
        return input.data;
      case "api_keys":
        if (input.onConflict === "ignore") {
          await collections.apiKeys.updateOne(
            { hash: input.data.hash },
            { $setOnInsert: input.data },
            { upsert: true, ...mongoSessionOptions(session) },
          );
          return input.data;
        }
        await collections.apiKeys.insertOne(
          input.data,
          mongoSessionOptions(session),
        );
        return input.data;
      case "channels":
        if (input.onConflict === "ignore") {
          await collections.channels.updateOne(
            { name: input.data.name },
            { $setOnInsert: input.data },
            { upsert: true, ...mongoSessionOptions(session) },
          );
          return input.data;
        }
        await collections.channels.insertOne(
          input.data,
          mongoSessionOptions(session),
        );
        return input.data;
    }
  },
  update: async (input) => {
    if (input.model === "api_keys") {
      return collections.apiKeys.findOneAndUpdate(
        createMongoApiKeyWhere(input.where),
        { $set: input.update },
        {
          projection: WITHOUT_INTERNAL_FIELDS,
          returnDocument: "after",
          ...mongoSessionOptions(session),
        },
      );
    }
    if (input.model === "releases") {
      return collections.releases.findOneAndUpdate(
        createMongoReleaseWhere(input.where),
        { $set: input.update },
        {
          projection: WITHOUT_INTERNAL_FIELDS,
          returnDocument: "after",
          ...mongoSessionOptions(session),
        },
      );
    }
    if (input.model === "release_catalogs") {
      return collections.releaseCatalogs.findOneAndUpdate(
        createMongoReleaseCatalogWhere(input.where),
        { $set: input.update },
        {
          projection: WITHOUT_INTERNAL_FIELDS,
          returnDocument: "after",
          ...mongoSessionOptions(session),
        },
      );
    }
    return collections.bundles.findOneAndUpdate(
      activeBundleFilter(createMongoBundleWhere(input.where)),
      { $set: input.update },
      {
        projection: WITHOUT_INTERNAL_FIELDS,
        returnDocument: "after",
        ...mongoSessionOptions(session),
      },
    );
  },
  delete: async (input) => {
    switch (input.model) {
      case "bundle_patches":
        await collections.bundlePatches.deleteMany(
          createMongoPatchWhere(input.where),
          mongoSessionOptions(session),
        );
        return;
      case "bundles": {
        const deletionToken = createUUIDv7();
        await collections.bundles.updateMany(
          createMongoBundleWhere(input.where),
          { $set: { [DELETION_TOKEN_FIELD]: deletionToken } },
          mongoSessionOptions(session),
        );
        const rows = await collections.bundles
          .find(
            { [DELETION_TOKEN_FIELD]: deletionToken },
            {
              projection: { _id: 0, id: 1 },
              ...mongoSessionOptions(session),
            },
          )
          .toArray();
        const ids = rows.map(({ id }) => id);
        if (ids.length === 0) return;
        await collections.bundlePatches.deleteMany(
          {
            $or: [
              { bundle_id: { $in: ids } },
              { base_bundle_id: { $in: ids } },
            ],
          },
          mongoSessionOptions(session),
        );
        await collections.bundles.deleteMany(
          { [DELETION_TOKEN_FIELD]: deletionToken },
          mongoSessionOptions(session),
        );
        return;
      }
      case "releases":
        await collections.releases.deleteMany(
          createMongoReleaseWhere(input.where),
          mongoSessionOptions(session),
        );
        return;
      case "channels":
        await collections.channels.deleteMany(
          createMongoChannelWhere(input.where),
          mongoSessionOptions(session),
        );
        return;
    }
  },
});
