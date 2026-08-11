import type {
  BundlePatchRow,
  BundleRow,
  BundleRowUpdate,
  DatabasePluginImplementation,
} from "@hot-updater/plugin-core";
import { createUUIDv7 } from "@hot-updater/plugin-core";
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
import {
  createMongoBundleWhere,
  createMongoClientAccessKeyWhere,
  createMongoPatchWhere,
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

const assertBundleTarget = (
  bundle: Pick<BundleRow, "fingerprint_hash" | "target_app_version">,
): void => {
  if (bundle.target_app_version === null && bundle.fingerprint_hash === null) {
    throw new MongoAdapterConstraintError(
      "bundles.version-or-fingerprint.check",
    );
  }
};

const targetConstraintFilter = (update: BundleRowUpdate): object => {
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

type MongoWriteImplementation = Pick<
  DatabasePluginImplementation,
  "create" | "delete" | "update"
>;

export const createMongoWrites = (
  collections: MongoCollections,
  session?: ClientSession,
): MongoWriteImplementation => ({
  create: async (input) => {
    switch (input.model) {
      case "bundles":
        assertBundleTarget(input.data);
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
        await collections.bundleEvents.insertOne(
          input.data,
          mongoSessionOptions(session),
        );
        return input.data;
      case "client_access_keys":
        await collections.clientAccessKeys.insertOne(
          input.data,
          mongoSessionOptions(session),
        );
        return input.data;
    }
  },
  update: async (input) => {
    if (input.model === "client_access_keys") {
      return collections.clientAccessKeys.findOneAndUpdate(
        createMongoClientAccessKeyWhere(input.where),
        { $set: input.update },
        {
          projection: WITHOUT_INTERNAL_FIELDS,
          returnDocument: "after",
          ...mongoSessionOptions(session),
        },
      );
    }
    if (
      input.update.target_app_version === null &&
      input.update.fingerprint_hash === null
    ) {
      throw new MongoAdapterConstraintError(
        "bundles.version-or-fingerprint.check",
      );
    }
    return collections.bundles.findOneAndUpdate(
      activeBundleFilter({
        $and: [
          createMongoBundleWhere(input.where),
          targetConstraintFilter(input.update),
        ],
      }),
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
    }
  },
});
