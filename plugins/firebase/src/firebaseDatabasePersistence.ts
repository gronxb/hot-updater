import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
} from "@hot-updater/plugin-core";
import {
  FieldValue,
  type CollectionReference,
  type DocumentData,
  type Firestore,
  type QuerySnapshot,
  type Transaction,
} from "firebase-admin/firestore";

import {
  hasFirebaseProperty,
  parseFirebaseBundleRow,
  parseFirebaseChannelRow,
  parseFirebaseLegacyPatchRows,
  parseFirebasePatchRow,
} from "./firebaseDatabaseParser";
import type { FirebaseDatabaseSnapshot } from "./firebaseDatabaseState";
import { FirebaseDatabaseConstraintError } from "./firebaseDatabaseState";

export interface FirebaseDatabaseCollections {
  readonly bundles: CollectionReference<DocumentData>;
  readonly bundlePatches: CollectionReference<DocumentData>;
  readonly channels: CollectionReference<DocumentData>;
}

export const createFirebaseDatabaseCollections = (
  db: Firestore,
): FirebaseDatabaseCollections => ({
  bundles: db.collection("bundles"),
  bundlePatches: db.collection("bundle_patches"),
  channels: db.collection("channels"),
});

type FixedRow = BundlePatchRow | BundleRow | ChannelRow;

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

const channelMap = (
  snapshot: QuerySnapshot<DocumentData>,
): Map<string, ChannelRow> =>
  new Map(
    snapshot.docs.map((document) => {
      const row = parseFirebaseChannelRow(document.data(), document.id);
      return [row.id, row];
    }),
  );

type SnapshotDocuments = readonly [
  QuerySnapshot<DocumentData>,
  QuerySnapshot<DocumentData>,
  QuerySnapshot<DocumentData>,
];

const toSnapshot = (
  documents: SnapshotDocuments,
): FirebaseDatabaseSnapshot => ({
  bundles: bundleMap(documents[0]),
  bundlePatches: patchMap(documents[1]),
  channels: channelMap(documents[2]),
});

export const loadFirebaseDatabaseSnapshot = async (
  collections: FirebaseDatabaseCollections,
): Promise<FirebaseDatabaseSnapshot> =>
  toSnapshot(
    await Promise.all([
      collections.bundles.get(),
      collections.bundlePatches.get(),
      collections.channels.get(),
    ]),
  );

export const loadFirebaseTransactionSnapshot = async (
  transaction: Transaction,
  collections: FirebaseDatabaseCollections,
): Promise<FirebaseDatabaseSnapshot> =>
  toSnapshot(
    await Promise.all([
      transaction.get(collections.bundles),
      transaction.get(collections.bundlePatches),
      transaction.get(collections.channels),
    ]),
  );

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
    collection: collections.channels,
    before: before.channels,
    after: after.channels,
  });
};

const LEGACY_PATCH_FIELDS = [
  "patches",
  "patch_base_bundle_id",
  "patch_base_file_hash",
  "patch_file_hash",
  "patch_storage_uri",
] as const;

export const migrateFirebaseDatabase = async (
  db: Firestore,
  collections: FirebaseDatabaseCollections,
): Promise<void> => {
  await db.runTransaction(async (transaction) => {
    const [bundles, patches, channels] = await Promise.all([
      transaction.get(collections.bundles),
      transaction.get(collections.bundlePatches),
      transaction.get(collections.channels),
    ]);
    const bundleIds = new Set(bundles.docs.map(({ id }) => id));
    const patchIds = new Set(patches.docs.map(({ id }) => id));
    const channelIds = new Set(channels.docs.map(({ id }) => id));

    for (const document of patches.docs) {
      const patch = parseFirebasePatchRow(
        document.data(),
        `bundle_patches/${document.id}`,
      );
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

    for (const document of channels.docs) {
      if (!hasFirebaseProperty(document.data(), "id")) {
        transaction.set(document.ref, { id: document.id });
      }
    }

    for (const document of bundles.docs) {
      const value: unknown = document.data();
      const bundle = parseFirebaseBundleRow(value, `bundles/${document.id}`);
      if (!channelIds.has(bundle.channel)) {
        transaction.set(collections.channels.doc(bundle.channel), {
          id: bundle.channel,
        });
        channelIds.add(bundle.channel);
      }
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
        if (!patchIds.has(patch.id)) {
          transaction.set(collections.bundlePatches.doc(patch.id), patch);
          patchIds.add(patch.id);
        }
      }
      if (LEGACY_PATCH_FIELDS.some((key) => hasFirebaseProperty(value, key))) {
        transaction.update(document.ref, {
          patches: FieldValue.delete(),
          patch_base_bundle_id: FieldValue.delete(),
          patch_base_file_hash: FieldValue.delete(),
          patch_file_hash: FieldValue.delete(),
          patch_storage_uri: FieldValue.delete(),
        });
      }
    }
  });
};
