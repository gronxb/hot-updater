import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  InsightsInstallationRow,
  ApiKeyRow,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import {
  type CollectionReference,
  type DocumentData,
  type Firestore,
  type QuerySnapshot,
  type Transaction,
} from "firebase-admin/firestore";

import {
  parseFirebaseBundleRow,
  parseFirebaseApiKeyRow,
  parseFirebaseChannelRow,
  parseFirebasePatchRow,
  parseFirebaseReleaseCatalogRow,
  parseFirebaseReleaseRow,
} from "./firebaseDatabaseParser";
import type { FirebaseDatabaseSnapshot } from "./firebaseDatabaseState";
import { FirebaseDatabaseConstraintError } from "./firebaseDatabaseState";
import {
  FIREBASE_LEGACY_INSTALLATIONS_COLLECTION,
  FIREBASE_V1_COLLECTION_NAMES,
} from "./firebaseInfrastructureNames";

export interface FirebaseDatabaseCollections {
  readonly bundles: CollectionReference<DocumentData>;
  readonly bundlePatches: CollectionReference<DocumentData>;
  readonly bundleEvents: CollectionReference<DocumentData>;
  readonly bundleInstallations: CollectionReference<DocumentData>;
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

export class FirebaseInsightsMigrationRequiredError extends Error {
  readonly name = "FirebaseInsightsMigrationRequiredError";

  constructor() {
    super(
      "Firebase Insights storage needs migration. Stop old ingestion and run migrateFirebaseInsights(config) from @hot-updater/firebase before starting the updated server.",
    );
  }
}

export const createFirebaseDatabaseCollections = (
  db: Firestore,
): FirebaseDatabaseCollections => ({
  bundles: db.collection(FIREBASE_V1_COLLECTION_NAMES.bundles),
  bundlePatches: db.collection(FIREBASE_V1_COLLECTION_NAMES.bundlePatches),
  bundleEvents: db.collection(FIREBASE_V1_COLLECTION_NAMES.bundleEvents),
  bundleInstallations: db.collection(
    FIREBASE_V1_COLLECTION_NAMES.bundleInstallations,
  ),
  channels: db.collection(FIREBASE_V1_COLLECTION_NAMES.channels),
  apiKeys: db.collection(FIREBASE_V1_COLLECTION_NAMES.apiKeys),
  releaseCatalogs: db.collection(FIREBASE_V1_COLLECTION_NAMES.releaseCatalogs),
  releases: db.collection(FIREBASE_V1_COLLECTION_NAMES.releases),
  settings: db.collection(FIREBASE_V1_COLLECTION_NAMES.settings),
});

type FixedRow =
  | BundleEventRow
  | InsightsInstallationRow
  | BundlePatchRow
  | BundleRow
  | ChannelRow
  | ApiKeyRow
  | ReleaseCatalogRow
  | ReleaseRow;
type FixedModel =
  | "bundle_events"
  | "bundle_installations"
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

type ParsedDocumentRow<TRow extends FixedRow> = {
  readonly document: { readonly id: string };
  readonly row: TRow;
};

export const requireFirebaseDocumentKey = <TRow extends FixedRow>(
  model: FixedModel,
  documentId: string,
  row: TRow,
): TRow => {
  const key =
    model === "bundle_installations"
      ? firebaseInstallationDocumentId(
          (row as InsightsInstallationRow).install_id,
        )
      : "id" in row
        ? row.id
        : row.scope_key;
  if (documentId !== key) {
    throw new FirebaseDatabaseConstraintError(`${model}.id.document-key`);
  }
  return row;
};

const documentMap = <TRow extends FixedRow>(
  model: FixedModel,
  documents: readonly ParsedDocumentRow<TRow>[],
): Map<string, TRow> => {
  const rows = new Map<string, TRow>();
  for (const { row } of documents) {
    const key =
      model === "bundle_installations"
        ? (row as InsightsInstallationRow).install_id
        : "id" in row
          ? row.id
          : row.scope_key;
    if (rows.has(key)) {
      throw new FirebaseDatabaseConstraintError(`${model}.id.unique`);
    }
    rows.set(key, row);
  }
  for (const { document, row } of documents) {
    requireFirebaseDocumentKey(model, document.id, row);
  }
  return rows;
};

const bundleMap = (
  snapshot: QuerySnapshot<DocumentData>,
): Map<string, BundleRow> =>
  documentMap(
    "bundles",
    snapshot.docs.map((document) => ({
      document,
      row: parseFirebaseBundleRow(document.data(), `bundles/${document.id}`),
    })),
  );

const patchMap = (
  snapshot: QuerySnapshot<DocumentData>,
): Map<string, BundlePatchRow> =>
  documentMap(
    "bundle_patches",
    snapshot.docs.map((document) => ({
      document,
      row: parseFirebasePatchRow(
        document.data(),
        `bundle_patches/${document.id}`,
      ),
    })),
  );

const channelMap = (
  snapshot: QuerySnapshot<DocumentData>,
): Map<string, ChannelRow> => {
  const rows = new Map<string, ChannelRow>();
  const names = new Set<string>();
  for (const document of snapshot.docs) {
    const row = parseFirebaseChannelRow(
      document.data(),
      `channels/${document.id}`,
    );
    if (document.id !== firebaseChannelDocumentId(row.name)) {
      throw new FirebaseDatabaseConstraintError("channels.name.document-key");
    }
    if (rows.has(row.id)) {
      throw new FirebaseDatabaseConstraintError("channels.id.unique");
    }
    if (names.has(row.name)) {
      throw new FirebaseDatabaseConstraintError("channels.name.unique");
    }
    rows.set(row.id, row);
    names.add(row.name);
  }
  return rows;
};

export const loadFirebaseChannels = async (
  collections: FirebaseDatabaseCollections,
): Promise<readonly ChannelRow[]> => [
  ...channelMap(await collections.channels.get()).values(),
];

const apiKeyMap = (
  snapshot: QuerySnapshot<DocumentData>,
): Map<string, ApiKeyRow> =>
  documentMap(
    "api_keys",
    snapshot.docs.map((document) => ({
      document,
      row: parseFirebaseApiKeyRow(document.data(), `api_keys/${document.id}`),
    })),
  );

const releaseMap = (
  snapshot: QuerySnapshot<DocumentData>,
): Map<string, ReleaseRow> =>
  documentMap(
    "releases",
    snapshot.docs.map((document) => ({
      document,
      row: parseFirebaseReleaseRow(document.data(), `releases/${document.id}`),
    })),
  );

const releaseCatalogMap = (
  snapshot: QuerySnapshot<DocumentData>,
): Map<string, ReleaseCatalogRow> =>
  documentMap(
    "release_catalogs",
    snapshot.docs.map((document) => ({
      document,
      row: parseFirebaseReleaseCatalogRow(
        document.data(),
        `release_catalogs/${document.id}`,
      ),
    })),
  );

type CoreSnapshotDocuments = readonly [
  QuerySnapshot<DocumentData>,
  QuerySnapshot<DocumentData>,
  QuerySnapshot<DocumentData>,
  QuerySnapshot<DocumentData>,
  QuerySnapshot<DocumentData>,
  QuerySnapshot<DocumentData>,
];

const toSnapshot = (
  documents: CoreSnapshotDocuments,
): FirebaseDatabaseSnapshot => {
  const snapshot: FirebaseDatabaseSnapshot = {
    bundles: bundleMap(documents[0]),
    bundlePatches: patchMap(documents[1]),
    bundleEvents: new Map(),
    bundleInstallations: new Map(),
    channels: channelMap(documents[2]),
    apiKeys: apiKeyMap(documents[3]),
    releases: releaseMap(documents[4]),
    releaseCatalogs: releaseCatalogMap(documents[5]),
  };
  return snapshot;
};

export const loadFirebaseDatabaseSnapshot = async (
  collections: FirebaseDatabaseCollections,
): Promise<FirebaseDatabaseSnapshot> => {
  const [bundles, patches, channels, apiKeys, releases, releaseCatalogs] =
    await Promise.all([
      collections.bundles.get(),
      collections.bundlePatches.get(),
      collections.channels.get(),
      collections.apiKeys.get(),
      collections.releases.get(),
      collections.releaseCatalogs.get(),
    ]);
  return toSnapshot([
    bundles,
    patches,
    channels,
    apiKeys,
    releases,
    releaseCatalogs,
  ]);
};

export const loadFirebaseTransactionSnapshot = async (
  transaction: Transaction,
  collections: FirebaseDatabaseCollections,
): Promise<FirebaseDatabaseSnapshot> => {
  const [bundles, patches, channels, apiKeys, releases, releaseCatalogs] =
    await Promise.all([
      transaction.get(collections.bundles),
      transaction.get(collections.bundlePatches),
      transaction.get(collections.channels),
      transaction.get(collections.apiKeys),
      transaction.get(collections.releases),
      transaction.get(collections.releaseCatalogs),
    ]);
  return toSnapshot([
    bundles,
    patches,
    channels,
    apiKeys,
    releases,
    releaseCatalogs,
  ]);
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
  db: Firestore,
  collections: FirebaseDatabaseCollections,
): Promise<void> => {
  const versionDocument = collections.settings.doc("database_adapter_version");
  const version = await versionDocument.get();
  const adapterVersion = version.data()?.version;
  if (adapterVersion === 5) {
    return;
  }
  const legacyInstallations = db.collection(
    FIREBASE_LEGACY_INSTALLATIONS_COLLECTION,
  );
  if (adapterVersion === 4) {
    if (!(await legacyInstallations.limit(1).get()).empty) {
      throw new FirebaseInsightsMigrationRequiredError();
    }
    await versionDocument.update({ version: 5 });
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
    collections.bundleInstallations.limit(1).get(),
    collections.bundleEvents.limit(1).get(),
    legacyInstallations.limit(1).get(),
  ]);
  if (existingCollections.some((snapshot) => !snapshot.empty)) {
    throw new FirebaseDatabaseAdapterVersionError("v0");
  }

  try {
    await versionDocument.create({ version: 5 });
  } catch (error) {
    const current = await versionDocument.get();
    if (current.data()?.version !== 5) {
      throw error;
    }
  }
};
