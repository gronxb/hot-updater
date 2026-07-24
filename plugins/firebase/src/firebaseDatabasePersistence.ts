import type {
  BundlePatchRow,
  BundleRow,
  DatabaseRow,
} from "@hot-updater/plugin-core";
import {
  type CollectionReference,
  type DocumentData,
  type Firestore,
  type QuerySnapshot,
  type Transaction,
} from "firebase-admin/firestore";

import {
  parseFirebaseBundleEventRow,
  parseFirebaseBundleRow,
  parseFirebasePatchRow,
} from "./firebaseDatabaseParser";
import type { FirebaseDatabaseSnapshot } from "./firebaseDatabaseState";

type BundleEventPersistenceRow = DatabaseRow<"bundle_events">;

export interface FirebaseDatabaseCollections {
  readonly bundles: CollectionReference<DocumentData>;
  readonly bundlePatches: CollectionReference<DocumentData>;
  readonly bundleEvents: CollectionReference<DocumentData>;
  readonly settings: CollectionReference<DocumentData>;
}

export const createFirebaseDatabaseCollections = (
  db: Firestore,
): FirebaseDatabaseCollections => ({
  bundles: db.collection("bundles"),
  bundlePatches: db.collection("bundle_patches"),
  bundleEvents: db.collection("bundle_events"),
  settings: db.collection("private_hot_updater_settings"),
});

type FixedRow = BundleEventPersistenceRow | BundlePatchRow | BundleRow;

const bundleMap = (
  snapshot: QuerySnapshot<DocumentData>,
): Map<string, BundleRow> =>
  new Map(
    snapshot.docs.map((document) => {
      const row = parseFirebaseBundleRow(
        document.data(),
        `bundles/${document.id}`,
      );
      return [row.id, row];
    }),
  );

const patchMap = (
  snapshot: QuerySnapshot<DocumentData>,
): Map<string, BundlePatchRow> =>
  new Map(
    snapshot.docs.map((document) => {
      const row = parseFirebasePatchRow(
        document.data(),
        `bundle_patches/${document.id}`,
      );
      return [row.id, row];
    }),
  );

const bundleEventMap = (
  snapshot: QuerySnapshot<DocumentData>,
): Map<string, BundleEventPersistenceRow> =>
  new Map(
    snapshot.docs.map((document) => {
      const row = parseFirebaseBundleEventRow(
        document.data(),
        `bundle_events/${document.id}`,
      );
      return [row.id, row];
    }),
  );

type CoreSnapshotDocuments = readonly [
  QuerySnapshot<DocumentData>,
  QuerySnapshot<DocumentData>,
];

const toSnapshot = (
  documents: CoreSnapshotDocuments,
  bundleEvents?: QuerySnapshot<DocumentData>,
): FirebaseDatabaseSnapshot => ({
  bundles: bundleMap(documents[0]),
  bundlePatches: patchMap(documents[1]),
  bundleEvents: bundleEvents ? bundleEventMap(bundleEvents) : new Map(),
});

type FirebaseSnapshotOptions = {
  readonly includeBundleEvents?: boolean;
};

export const loadFirebaseDatabaseSnapshot = async (
  collections: FirebaseDatabaseCollections,
  options: FirebaseSnapshotOptions = {},
): Promise<FirebaseDatabaseSnapshot> => {
  const [bundles, patches, bundleEvents] = await Promise.all([
    collections.bundles.get(),
    collections.bundlePatches.get(),
    options.includeBundleEvents ? collections.bundleEvents.get() : undefined,
  ]);
  return toSnapshot([bundles, patches], bundleEvents);
};

export const loadFirebaseTransactionSnapshot = async (
  transaction: Transaction,
  collections: FirebaseDatabaseCollections,
  options: FirebaseSnapshotOptions = {},
): Promise<FirebaseDatabaseSnapshot> => {
  const [bundles, patches, bundleEvents] = await Promise.all([
    transaction.get(collections.bundles),
    transaction.get(collections.bundlePatches),
    options.includeBundleEvents
      ? transaction.get(collections.bundleEvents)
      : undefined,
  ]);
  return toSnapshot([bundles, patches], bundleEvents);
};

export const loadFirebaseTransactionBundleEvents = async (
  transaction: Transaction,
  collections: FirebaseDatabaseCollections,
): Promise<Map<string, BundleEventPersistenceRow>> =>
  bundleEventMap(await transaction.get(collections.bundleEvents));

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
      transaction.set(collection.doc(id), row);
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
};
