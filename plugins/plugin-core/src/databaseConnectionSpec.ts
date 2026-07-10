import { createBlobDatabaseConnection } from "./createBlobDatabaseConnection";
import {
  createBundleEventResource,
  type BundleEventStore,
} from "./databaseBundleEventResources";
import {
  buildBundlePatchSetResource,
  buildBundlePatchRowResource,
  type BundlePatchSetStore,
  type BundlePatchRowStore,
} from "./databaseBundlePatchTable";
import {
  createBundleResource,
  type BundleStore,
} from "./databaseBundleResources";
import type {
  DatabasePluginCore,
  DatabaseTransaction,
} from "./databaseCoreTypes";
import type { BundlePatchResource, UpdateInfoRepository } from "./types";

export type DatabasePluginPatchStorage =
  | ({ readonly storage: "rows" } & BundlePatchRowStore)
  | ({ readonly storage: "embedded" } & BundlePatchSetStore);

export interface DatabasePluginResourceDeclaration {
  readonly beginTransaction?: () => Promise<DatabasePluginTransaction>;
  readonly bundles: BundleStore;
  readonly patches: DatabasePluginPatchStorage;
  readonly bundleEvents?: BundleEventStore;
  readonly updateInfo?: UpdateInfoRepository;
  readonly close?: () => Promise<void>;
}

export interface DatabasePluginBlobOperations {
  readonly listObjects: (prefix: string) => Promise<string[]>;
  readonly loadObject: <T>(key: string) => Promise<T | null>;
  readonly uploadObject: <T>(key: string, data: T) => Promise<void>;
  readonly deleteObject: (key: string) => Promise<void>;
  readonly shouldSkipLoadObjectError?: (error: unknown, key: string) => boolean;
  readonly invalidatePaths: (paths: string[]) => Promise<void>;
}

export type DatabasePluginBlobDeclaration = {
  readonly storage: "blob";
} & DatabasePluginBlobOperations;

export type DatabasePluginDeclaration =
  | DatabasePluginResourceDeclaration
  | DatabasePluginBlobDeclaration;

export interface DatabasePluginTransaction {
  readonly connection: DatabasePluginDeclaration;
  readonly commit: () => Promise<void>;
  readonly rollback: () => Promise<void>;
}

const isBlobDatabaseDeclaration = (
  connection: DatabasePluginDeclaration,
): connection is DatabasePluginBlobDeclaration =>
  "storage" in connection && connection.storage === "blob";

const createBundlePatchResource = (
  storage: DatabasePluginPatchStorage,
): BundlePatchResource => {
  if (storage.storage === "rows") {
    return buildBundlePatchRowResource(storage);
  }
  if (storage.storage === "embedded") {
    return buildBundlePatchSetResource(storage);
  }
  throw new Error("Unsupported bundle patch storage");
};

const normalizeDatabaseTransaction = (
  transaction: DatabasePluginTransaction,
): DatabaseTransaction => {
  const { connection, ...lifecycle } = transaction;
  return {
    ...lifecycle,
    core: normalizeDatabaseDeclaration(connection),
  };
};

export const normalizeDatabaseDeclaration = (
  connection: DatabasePluginDeclaration,
): DatabasePluginCore => {
  const resourceConnection = isBlobDatabaseDeclaration(connection)
    ? createBlobDatabaseConnection(connection)
    : connection;
  const { beginTransaction, bundles, patches, bundleEvents, ...core } =
    resourceConnection;
  return {
    ...core,
    bundles: createBundleResource(bundles),
    ...(bundleEvents
      ? { bundleEvents: createBundleEventResource(bundleEvents) }
      : {}),
    ...(beginTransaction
      ? {
          beginTransaction: async () =>
            normalizeDatabaseTransaction(await beginTransaction()),
        }
      : {}),
    bundlePatches: createBundlePatchResource(patches),
  };
};
