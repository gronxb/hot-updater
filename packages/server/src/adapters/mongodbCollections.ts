import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  ApiKeyRow,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import type { ClientSession, Collection, MongoClient } from "mongodb";

import {
  createMongoInsightsSourceCollections,
  type MongoBundleEventDocument,
  type MongoInsightsSourceCollections,
} from "./mongodbInsightsSource";

export class MongoAdapterConstraintError extends Error {
  readonly name = "MongoAdapterConstraintError";

  constructor(readonly reason: string) {
    super(`MongoDB adapter constraint failed: ${reason}`);
  }
}

export const WITHOUT_MONGO_ID = { _id: 0 } as const;
export const DELETION_TOKEN_FIELD = "_hot_updater_deletion_token" as const;

export type MongoBundleDocument = BundleRow & {
  readonly [DELETION_TOKEN_FIELD]?: string;
};

export const WITHOUT_INTERNAL_FIELDS = {
  ...WITHOUT_MONGO_ID,
  [DELETION_TOKEN_FIELD]: 0,
} as const;

export const activeBundleFilter = (where: object) => ({
  $and: [where, { [DELETION_TOKEN_FIELD]: { $exists: false } }],
});

export type MongoCollections = MongoInsightsSourceCollections & {
  readonly bundles: Collection<MongoBundleDocument>;
  readonly bundlePatches: Collection<BundlePatchRow>;
  readonly bundleEvents: Collection<MongoBundleEventDocument>;
  readonly channels: Collection<ChannelRow>;
  readonly apiKeys: Collection<ApiKeyRow>;
  readonly releases: Collection<ReleaseRow>;
  readonly releaseCatalogs: Collection<ReleaseCatalogRow>;
};

export const createMongoCollections = (
  client: MongoClient,
): MongoCollections => {
  const database = client.db();
  return {
    ...createMongoInsightsSourceCollections(client),
    bundles: database.collection<MongoBundleDocument>("bundles"),
    bundlePatches: database.collection<BundlePatchRow>("bundle_patches"),
    channels: database.collection<ChannelRow>("channels"),
    apiKeys: database.collection<ApiKeyRow>("api_keys"),
    releases: database.collection<ReleaseRow>("releases"),
    releaseCatalogs: database.collection<ReleaseCatalogRow>("release_catalogs"),
  };
};

export const mongoSessionOptions = (session?: ClientSession) =>
  session === undefined ? {} : { session };
