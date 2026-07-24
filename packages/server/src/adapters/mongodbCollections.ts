import type {
  BundlePatchRow,
  BundleRow,
  DatabaseRow,
} from "@hot-updater/plugin-core";
import type { ClientSession, Collection, MongoClient } from "mongodb";

import { createMongoBundleWhere } from "./mongodbQuery";

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

export type MongoCollections = {
  readonly bundles: Collection<MongoBundleDocument>;
  readonly bundlePatches: Collection<BundlePatchRow>;
  readonly appendOnlyRows: Collection<DatabaseRow<"bundle_events">>;
};

export const createMongoCollections = (
  client: MongoClient,
): MongoCollections => {
  const database = client.db();
  return {
    bundles: database.collection<MongoBundleDocument>("bundles"),
    bundlePatches: database.collection<BundlePatchRow>("bundle_patches"),
    appendOnlyRows:
      database.collection<DatabaseRow<"bundle_events">>("bundle_events"),
  };
};

export const mongoSessionOptions = (session?: ClientSession) =>
  session === undefined ? {} : { session };

export const createMongoAppendOnlyWhere = (where: unknown): object =>
  createMongoBundleWhere(where as never) as object;
