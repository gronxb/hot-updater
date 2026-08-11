import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ClientAccessKeyRow,
} from "@hot-updater/plugin-core";
import {
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  FieldValue,
  type Firestore,
  type QuerySnapshot,
  type Timestamp,
  type Transaction,
} from "firebase-admin/firestore";

import {
  parseFirebaseBundleRow,
  parseFirebaseBundleEventRow,
  parseFirebaseClientAccessKeyRow,
  parseFirebaseLegacyPatchRows,
  parseFirebasePatchRow,
} from "./firebaseDatabaseParser";
import type { FirebaseDatabaseSnapshot } from "./firebaseDatabaseState";
import { FirebaseDatabaseConstraintError } from "./firebaseDatabaseState";

export interface FirebaseDatabaseCollections {
  readonly bundles: CollectionReference<DocumentData>;
  readonly bundlePatches: CollectionReference<DocumentData>;
  readonly bundleEvents: CollectionReference<DocumentData>;
  readonly clientAccessKeys: CollectionReference<DocumentData>;
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
  bundles: db.collection("bundles"),
  bundlePatches: db.collection("bundle_patches"),
  bundleEvents: db.collection("bundle_events"),
  clientAccessKeys: db.collection("client_access_keys"),
  settings: db.collection("private_hot_updater_settings"),
});

type FixedRow =
  | BundleEventRow
  | BundlePatchRow
  | BundleRow
  | ClientAccessKeyRow;
type FixedModel =
  | "bundle_events"
  | "bundle_patches"
  | "bundles"
  | "client_access_keys";

type ParsedDocumentRow<TRow extends FixedRow> = {
  readonly document: { readonly id: string };
  readonly row: TRow;
};

export const requireFirebaseDocumentKey = <TRow extends FixedRow>(
  model: FixedModel,
  documentId: string,
  row: TRow,
): TRow => {
  if (documentId !== row.id) {
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
    if (rows.has(row.id)) {
      throw new FirebaseDatabaseConstraintError(`${model}.id.unique`);
    }
    rows.set(row.id, row);
  }
  for (const { document, row } of documents) {
    requireFirebaseDocumentKey(model, document.id, row);
  }
  return rows;
};

type FirebaseMigrationWrite =
  | {
      readonly kind: "create";
      readonly reference: DocumentReference<DocumentData>;
      readonly value: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "update";
      readonly reference: DocumentReference<DocumentData>;
      readonly updateTime: Timestamp;
      readonly value: Readonly<Record<string, unknown>>;
    };

const requireUpdateTime = (
  document: { readonly updateTime?: Timestamp },
  source: string,
): Timestamp => {
  if (!document.updateTime) {
    throw new Error(`Missing update time for ${source}.`);
  }
  return document.updateTime;
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

const eventMap = (
  snapshot: QuerySnapshot<DocumentData>,
): Map<string, BundleEventRow> =>
  documentMap(
    "bundle_events",
    snapshot.docs.map((document) => ({
      document,
      row: parseFirebaseBundleEventRow(
        document.data(),
        `bundle_events/${document.id}`,
      ),
    })),
  );

const clientAccessKeyMap = (
  snapshot: QuerySnapshot<DocumentData>,
): Map<string, ClientAccessKeyRow> =>
  documentMap(
    "client_access_keys",
    snapshot.docs.map((document) => ({
      document,
      row: parseFirebaseClientAccessKeyRow(
        document.data(),
        `client_access_keys/${document.id}`,
      ),
    })),
  );

type CoreSnapshotDocuments = readonly [
  QuerySnapshot<DocumentData>,
  QuerySnapshot<DocumentData>,
  QuerySnapshot<DocumentData>,
  QuerySnapshot<DocumentData>,
];

const toSnapshot = (
  documents: CoreSnapshotDocuments,
): FirebaseDatabaseSnapshot => ({
  bundles: bundleMap(documents[0]),
  bundlePatches: patchMap(documents[1]),
  bundleEvents: eventMap(documents[2]),
  clientAccessKeys: clientAccessKeyMap(documents[3]),
});

export const loadFirebaseDatabaseSnapshot = async (
  collections: FirebaseDatabaseCollections,
): Promise<FirebaseDatabaseSnapshot> => {
  const [bundles, patches, events, clientAccessKeys] = await Promise.all([
    collections.bundles.get(),
    collections.bundlePatches.get(),
    collections.bundleEvents.get(),
    collections.clientAccessKeys.get(),
  ]);
  return toSnapshot([bundles, patches, events, clientAccessKeys]);
};

export const loadFirebaseTransactionSnapshot = async (
  transaction: Transaction,
  collections: FirebaseDatabaseCollections,
): Promise<FirebaseDatabaseSnapshot> => {
  const [bundles, patches, events, clientAccessKeys] = await Promise.all([
    transaction.get(collections.bundles),
    transaction.get(collections.bundlePatches),
    transaction.get(collections.bundleEvents),
    transaction.get(collections.clientAccessKeys),
  ]);
  return toSnapshot([bundles, patches, events, clientAccessKeys]);
};

type PersistCollectionInput<TRow extends FixedRow> = {
  readonly transaction: Transaction;
  readonly collection: CollectionReference<DocumentData>;
  readonly before: ReadonlyMap<string, TRow>;
  readonly after: ReadonlyMap<string, TRow>;
};

const persistCollection = <TRow extends FixedRow>({
  transaction,
  collection,
  before,
  after,
}: PersistCollectionInput<TRow>): void => {
  for (const id of before.keys()) {
    if (!after.has(id)) transaction.delete(collection.doc(id));
  }
  for (const [id, row] of after) {
    if (JSON.stringify(before.get(id)) !== JSON.stringify(row)) {
      transaction.set(collection.doc(id), row, { merge: true });
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
  });
  persistCollection({
    transaction,
    collection: collections.bundlePatches,
    before: before.bundlePatches,
    after: after.bundlePatches,
  });
  persistCollection({
    transaction,
    collection: collections.bundleEvents,
    before: before.bundleEvents,
    after: after.bundleEvents,
  });
  persistCollection({
    transaction,
    collection: collections.clientAccessKeys,
    before: before.clientAccessKeys,
    after: after.clientAccessKeys,
  });
};

const migrateFirebaseDatabaseAttempt = async (
  db: Firestore,
  collections: FirebaseDatabaseCollections,
): Promise<void> => {
  const versionDocument = collections.settings.doc("database_adapter_version");
  const version = await versionDocument.get();
  const adapterVersion = version.data()?.version;
  if (adapterVersion === 2) return;
  if (version.exists && adapterVersion !== 1) {
    throw new FirebaseDatabaseAdapterVersionError(adapterVersion);
  }

  const [bundles, patches] = await Promise.all([
    collections.bundles.get(),
    collections.bundlePatches.get(),
  ]);
  const parsedBundles = bundles.docs.map((document) => ({
    document,
    row: parseFirebaseBundleRow(document.data(), `bundles/${document.id}`),
  }));
  const parsedPatches = patches.docs.map((document) => ({
    document,
    row: parseFirebasePatchRow(
      document.data(),
      `bundle_patches/${document.id}`,
    ),
  }));
  const bundleIds = new Set(documentMap("bundles", parsedBundles).keys());
  const existingPatches = documentMap("bundle_patches", parsedPatches);
  const patchWrites: FirebaseMigrationWrite[] = [];
  const bundleWrites: FirebaseMigrationWrite[] = [];

  for (const { row: patch } of parsedPatches) {
    if (!bundleIds.has(patch.bundle_id)) {
      throw new FirebaseDatabaseConstraintError(
        "bundle_patches.bundle_id.foreign-key",
      );
    }
    if (!bundleIds.has(patch.base_bundle_id)) {
      throw new FirebaseDatabaseConstraintError(
        "bundle_patches.base_bundle_id.foreign-key",
      );
    }
  }

  for (const { document, row: bundle } of parsedBundles) {
    const value: unknown = document.data();
    const legacyPatches = parseFirebaseLegacyPatchRows(
      value,
      bundle.id,
      `bundles/${document.id}`,
    );
    for (const patch of legacyPatches) {
      if (!bundleIds.has(patch.base_bundle_id)) {
        throw new FirebaseDatabaseConstraintError(
          "bundle_patches.base_bundle_id.foreign-key",
        );
      }
      const existingPatch = existingPatches.get(patch.id);
      if (
        existingPatch !== undefined &&
        (existingPatch.id !== patch.id ||
          existingPatch.bundle_id !== patch.bundle_id ||
          existingPatch.base_bundle_id !== patch.base_bundle_id ||
          existingPatch.base_file_hash !== patch.base_file_hash ||
          existingPatch.patch_file_hash !== patch.patch_file_hash ||
          existingPatch.patch_storage_uri !== patch.patch_storage_uri ||
          existingPatch.order_index !== patch.order_index)
      ) {
        throw new FirebaseDatabaseConstraintError("bundle_patches.id.conflict");
      }
      if (existingPatch === undefined) {
        patchWrites.push({
          kind: "create",
          reference: collections.bundlePatches.doc(patch.id),
          value: { ...patch },
        });
        existingPatches.set(patch.id, patch);
      }
    }
    bundleWrites.push({
      kind: "update",
      reference: document.ref,
      updateTime: requireUpdateTime(document, `bundles/${document.id}`),
      value: {
        ...bundle,
        patches: FieldValue.delete(),
        patch_base_bundle_id: FieldValue.delete(),
        patch_base_file_hash: FieldValue.delete(),
        patch_file_hash: FieldValue.delete(),
        patch_storage_uri: FieldValue.delete(),
      },
    });
  }

  const writes: FirebaseMigrationWrite[] = [
    ...patchWrites,
    ...bundleWrites,
    version.exists
      ? {
          kind: "update",
          reference: versionDocument,
          updateTime: requireUpdateTime(version, versionDocument.path),
          value: { version: 2 },
        }
      : {
          kind: "create",
          reference: versionDocument,
          value: { version: 2 },
        },
  ];
  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = db.batch();
    for (const write of writes.slice(offset, offset + 400)) {
      if (write.kind === "create") {
        batch.create(write.reference, write.value);
      } else {
        batch.update(write.reference, write.value, {
          lastUpdateTime: write.updateTime,
        });
      }
    }
    await batch.commit();
  }
};

const isFirebaseMigrationConflict = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  return code === 6 || code === 9 || code === 10;
};

export const migrateFirebaseDatabase = async (
  db: Firestore,
  collections: FirebaseDatabaseCollections,
): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await migrateFirebaseDatabaseAttempt(db, collections);
      return;
    } catch (error) {
      if (error instanceof FirebaseDatabaseAdapterVersionError) throw error;
      if (!isFirebaseMigrationConflict(error)) throw error;
      const version = await collections.settings
        .doc("database_adapter_version")
        .get();
      if (version.data()?.version === 2) return;
      if (attempt === 2) throw error;
    }
  }
};
