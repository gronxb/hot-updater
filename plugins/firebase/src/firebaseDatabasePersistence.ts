import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
} from "@hot-updater/plugin-core";
import {
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
  parseFirebaseMigratingBundleRow,
  parseFirebaseMigratingChannelRow,
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
    const channelIds = new Set<string>();
    const channelNames = new Set<string>();
    const channelIdsByName = new Map<string, string>();

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
      const channel = parseFirebaseMigratingChannelRow(
        document.data(),
        document.id,
      );
      if (channelIds.has(channel.id)) {
        throw new FirebaseDatabaseConstraintError("channels.id.unique");
      }
      if (channelNames.has(channel.name)) {
        throw new FirebaseDatabaseConstraintError("channels.name.unique");
      }
      channelIds.add(channel.id);
      channelNames.add(channel.name);
      channelIdsByName.set(channel.name, channel.id);
      transaction.set(document.ref, channel);
    }

    for (const document of bundles.docs) {
      const value: unknown = document.data();
      const migratingBundle = parseFirebaseMigratingBundleRow(
        value,
        `bundles/${document.id}`,
      );
      const isLegacyBundle = !hasFirebaseProperty(value, "channel_id");
      const channelId = isLegacyBundle
        ? (channelIdsByName.get(migratingBundle.channel_id) ??
          migratingBundle.channel_id)
        : migratingBundle.channel_id;
      const bundle = { ...migratingBundle, channel_id: channelId };
      if (!channelIds.has(bundle.channel_id)) {
        if (!isLegacyBundle) {
          throw new FirebaseDatabaseConstraintError(
            "bundles.channel_id.foreign-key",
          );
        }
        transaction.set(collections.channels.doc(bundle.channel_id), {
          id: bundle.channel_id,
          name: bundle.channel_id,
        });
        channelIds.add(bundle.channel_id);
        channelNames.add(bundle.channel_id);
        channelIdsByName.set(bundle.channel_id, bundle.channel_id);
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
      transaction.set(document.ref, bundle);
    }
  });
};
