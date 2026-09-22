import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  ApiKeyRow,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import {
  type CollectionReference,
  type DocumentData,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";

import type { FirebaseDatabaseSnapshot } from "./firebaseDatabaseState";
import { FirebaseDatabaseConstraintError } from "./firebaseDatabaseState";
import { FIREBASE_V1_COLLECTION_NAMES } from "./firebaseInfrastructureNames";

export interface FirebaseDatabaseCollections {
  readonly bundles: CollectionReference<DocumentData>;
  readonly bundlePatches: CollectionReference<DocumentData>;
  readonly bundleEvents: CollectionReference<DocumentData>;
  readonly insightsLatest: CollectionReference<DocumentData>;
  readonly insightsOverview: CollectionReference<DocumentData>;
  readonly channels: CollectionReference<DocumentData>;
  readonly apiKeys: CollectionReference<DocumentData>;
  readonly releaseCatalogs: CollectionReference<DocumentData>;
  readonly releases: CollectionReference<DocumentData>;
  readonly settings: CollectionReference<DocumentData>;
}

export class FirebaseDatabaseAdapterVersionError extends Error {
  readonly name = "FirebaseDatabaseAdapterVersionError";

  constructor(readonly version: unknown) {
    super(`Unsupported Firebase database adapter version: ${String(version)}`);
  }
}

export const createFirebaseDatabaseCollections = (
  db: Firestore,
): FirebaseDatabaseCollections => ({
  bundles: db.collection(FIREBASE_V1_COLLECTION_NAMES.bundles),
  bundlePatches: db.collection(FIREBASE_V1_COLLECTION_NAMES.bundlePatches),
  bundleEvents: db.collection(FIREBASE_V1_COLLECTION_NAMES.bundleEvents),
  insightsLatest: db.collection(FIREBASE_V1_COLLECTION_NAMES.insightsLatest),
  insightsOverview: db.collection(
    FIREBASE_V1_COLLECTION_NAMES.insightsOverview,
  ),
  channels: db.collection(FIREBASE_V1_COLLECTION_NAMES.channels),
  apiKeys: db.collection(FIREBASE_V1_COLLECTION_NAMES.apiKeys),
  releaseCatalogs: db.collection(FIREBASE_V1_COLLECTION_NAMES.releaseCatalogs),
  releases: db.collection(FIREBASE_V1_COLLECTION_NAMES.releases),
  settings: db.collection(FIREBASE_V1_COLLECTION_NAMES.settings),
});

type FixedRow =
  | BundleEventRow
  | BundlePatchRow
  | BundleRow
  | ChannelRow
  | ApiKeyRow
  | ReleaseCatalogRow
  | ReleaseRow;
type FixedModel =
  | "insights_latest"
  | "bundle_events"
  | "bundle_patches"
  | "bundles"
  | "channels"
  | "api_keys"
  | "release_catalogs"
  | "releases";

export const firebaseChannelDocumentId = (name: string): string =>
  `name_${Buffer.from(name, "utf8").toString("base64url")}`;

export const firebaseChannelIdDocumentId = (id: string): string =>
  `channel_id_${Buffer.from(id, "utf8").toString("base64url")}`;

export const firebaseInstallationDocumentId = (id: string): string =>
  `install_${Buffer.from(id, "utf8").toString("base64url")}`;

export const requireFirebaseDocumentKey = <TRow extends FixedRow>(
  model: FixedModel,
  documentId: string,
  row: TRow,
): TRow => {
  const key =
    model === "insights_latest"
      ? firebaseInstallationDocumentId((row as BundleEventRow).install_id)
      : "id" in row
        ? row.id
        : row.scope_key;
  if (documentId !== key) {
    throw new FirebaseDatabaseConstraintError(`${model}.id.document-key`);
  }
  return row;
};

type PersistCollectionInput<TRow extends FixedRow> = {
  readonly transaction: Transaction;
  readonly collection: CollectionReference<DocumentData>;
  readonly before: ReadonlyMap<string, TRow>;
  readonly after: ReadonlyMap<string, TRow>;
  readonly documentId: (row: TRow) => string;
};

const persistCollection = <TRow extends FixedRow>({
  transaction,
  collection,
  before,
  after,
  documentId,
}: PersistCollectionInput<TRow>): void => {
  for (const [id, row] of before) {
    if (!after.has(id)) transaction.delete(collection.doc(documentId(row)));
  }
  for (const [id, row] of after) {
    if (JSON.stringify(before.get(id)) !== JSON.stringify(row)) {
      transaction.set(collection.doc(documentId(row)), row, { merge: true });
    }
  }
};

type PersistSnapshotInput = {
  readonly transaction: Transaction;
  readonly collections: FirebaseDatabaseCollections;
  readonly before: FirebaseDatabaseSnapshot;
  readonly after: FirebaseDatabaseSnapshot;
};

export const persistFirebaseDatabaseSnapshot = ({
  transaction,
  collections,
  before,
  after,
}: PersistSnapshotInput): void => {
  persistCollection({
    transaction,
    collection: collections.bundles,
    before: before.bundles,
    after: after.bundles,
    documentId: (row) => row.id,
  });
  persistCollection({
    transaction,
    collection: collections.bundlePatches,
    before: before.bundlePatches,
    after: after.bundlePatches,
    documentId: (row) => row.id,
  });
  persistCollection({
    transaction,
    collection: collections.channels,
    before: before.channels,
    after: after.channels,
    documentId: (row) => firebaseChannelDocumentId(row.name),
  });
  for (const [id] of before.channels) {
    if (!after.channels.has(id)) {
      transaction.delete(
        collections.settings.doc(firebaseChannelIdDocumentId(id)),
      );
    }
  }
  for (const [id, row] of after.channels) {
    if (JSON.stringify(before.channels.get(id)) !== JSON.stringify(row)) {
      transaction.set(
        collections.settings.doc(firebaseChannelIdDocumentId(id)),
        row,
      );
    }
  }
  persistCollection({
    transaction,
    collection: collections.apiKeys,
    before: before.apiKeys,
    after: after.apiKeys,
    documentId: (row) => row.id,
  });
  persistCollection({
    transaction,
    collection: collections.releases,
    before: before.releases,
    after: after.releases,
    documentId: (row) => row.id,
  });
  persistCollection({
    transaction,
    collection: collections.releaseCatalogs,
    before: before.releaseCatalogs,
    after: after.releaseCatalogs,
    documentId: (row) => row.scope_key,
  });
};

export const migrateFirebaseDatabase = async (
  collections: FirebaseDatabaseCollections,
): Promise<void> => {
  const versionDocument = collections.settings.doc("database_adapter_version");
  const version = await versionDocument.get();
  const adapterVersion = version.data()?.version;
  if (adapterVersion === 4) {
    return;
  }
  if (version.exists) {
    throw new FirebaseDatabaseAdapterVersionError(adapterVersion);
  }

  const existingCollections = await Promise.all([
    collections.bundles.limit(1).get(),
    collections.bundlePatches.limit(1).get(),
    collections.channels.limit(1).get(),
    collections.releases.limit(1).get(),
    collections.releaseCatalogs.limit(1).get(),
    collections.insightsLatest.limit(1).get(),
    collections.insightsOverview.limit(1).get(),
    collections.bundleEvents.limit(1).get(),
  ]);
  if (existingCollections.some((snapshot) => !snapshot.empty)) {
    throw new FirebaseDatabaseAdapterVersionError("v0");
  }

  try {
    await versionDocument.create({ version: 4 });
  } catch (error) {
    const current = await versionDocument.get();
    if (current.data()?.version !== 4) {
      throw error;
    }
  }
};
