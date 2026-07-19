import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
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
  hasFirebaseProperty,
  parseFirebaseBundleEventRow,
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
  readonly bundleEvents: CollectionReference<DocumentData>;
  readonly settings: CollectionReference<DocumentData>;
}

export const createFirebaseDatabaseCollections = (
  db: Firestore,
): FirebaseDatabaseCollections => ({
  bundles: db.collection("bundles"),
  bundlePatches: db.collection("bundle_patches"),
  channels: db.collection("bundle_channels"),
  bundleEvents: db.collection("bundle_events"),
  settings: db.collection("private_hot_updater_settings"),
});

type FixedRow = BundleEventRow | BundlePatchRow | BundleRow | ChannelRow;

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

const bundleEventMap = (
  snapshot: QuerySnapshot<DocumentData>,
): Map<string, BundleEventRow> =>
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
  QuerySnapshot<DocumentData>,
];

const toSnapshot = (
  documents: CoreSnapshotDocuments,
  bundleEvents?: QuerySnapshot<DocumentData>,
): FirebaseDatabaseSnapshot => ({
  bundles: bundleMap(documents[0]),
  bundlePatches: patchMap(documents[1]),
  channels: channelMap(documents[2]),
  bundleEvents: bundleEvents ? bundleEventMap(bundleEvents) : new Map(),
});

type FirebaseSnapshotOptions = {
  readonly includeBundleEvents?: boolean;
};

export const loadFirebaseDatabaseSnapshot = async (
  collections: FirebaseDatabaseCollections,
  options: FirebaseSnapshotOptions = {},
): Promise<FirebaseDatabaseSnapshot> => {
  const [bundles, patches, channels, bundleEvents] = await Promise.all([
    collections.bundles.get(),
    collections.bundlePatches.get(),
    collections.channels.get(),
    options.includeBundleEvents ? collections.bundleEvents.get() : undefined,
  ]);
  return toSnapshot([bundles, patches, channels], bundleEvents);
};

export const loadFirebaseTransactionSnapshot = async (
  transaction: Transaction,
  collections: FirebaseDatabaseCollections,
  options: FirebaseSnapshotOptions = {},
): Promise<FirebaseDatabaseSnapshot> => {
  const [bundles, patches, channels, bundleEvents] = await Promise.all([
    transaction.get(collections.bundles),
    transaction.get(collections.bundlePatches),
    transaction.get(collections.channels),
    options.includeBundleEvents
      ? transaction.get(collections.bundleEvents)
      : undefined,
  ]);
  return toSnapshot([bundles, patches, channels], bundleEvents);
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
  persistCollection({
    transaction,
    collection: collections.bundleEvents,
    before: before.bundleEvents,
    after: after.bundleEvents,
  });
};

const migrateFirebaseDatabaseAttempt = async (
  db: Firestore,
  collections: FirebaseDatabaseCollections,
): Promise<void> => {
  const versionDocument = collections.settings.doc("database_adapter_version");
  const version = await versionDocument.get();
  if (version.data()?.version === 2) return;

  const [bundles, patches, channels] = await Promise.all([
    collections.bundles.get(),
    collections.bundlePatches.get(),
    collections.channels.get(),
  ]);
  const bundleIds = new Set(bundles.docs.map(({ id }) => id));
  const patchIds = new Set(patches.docs.map(({ id }) => id));
  const channelIds = new Set<string>();
  const channelNames = new Set<string>();
  const channelIdsByName = new Map<string, string>();
  const channelsById = new Map<string, ChannelRow>();
  const channelWrites: FirebaseMigrationWrite[] = [];
  const patchWrites: FirebaseMigrationWrite[] = [];
  const bundleWrites: FirebaseMigrationWrite[] = [];

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
    channelsById.set(channel.id, channel);
    channelWrites.push({
      kind: "update",
      reference: document.ref,
      updateTime: requireUpdateTime(document, `channels/${document.id}`),
      value: { ...channel },
    });
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
    if (!channelIds.has(channelId)) {
      if (!isLegacyBundle) {
        throw new FirebaseDatabaseConstraintError(
          "bundles.channel_id.foreign-key",
        );
      }
      const channel = { id: channelId, name: migratingBundle.channel };
      channelWrites.push({
        kind: "create",
        reference: collections.channels.doc(channel.id),
        value: { ...channel },
      });
      channelIds.add(channel.id);
      channelNames.add(channel.name);
      channelIdsByName.set(channel.name, channel.id);
      channelsById.set(channel.id, channel);
    }
    const channelName = channelsById.get(channelId)?.name;
    if (!channelName) {
      throw new FirebaseDatabaseConstraintError(
        "bundles.channel_id.foreign-key",
      );
    }
    const bundle = {
      ...migratingBundle,
      channel: channelName,
      channel_id: channelId,
    };
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
        patchWrites.push({
          kind: "create",
          reference: collections.bundlePatches.doc(patch.id),
          value: { ...patch },
        });
        patchIds.add(patch.id);
      }
    }
    bundleWrites.push({
      kind: "update",
      reference: document.ref,
      updateTime: requireUpdateTime(document, `bundles/${document.id}`),
      value: {
        ...bundle,
        patches: FieldValue.delete(),
        patchBaseBundleId: FieldValue.delete(),
        patchBaseFileHash: FieldValue.delete(),
        patchFileHash: FieldValue.delete(),
        patchStorageUri: FieldValue.delete(),
      },
    });
  }

  const writes: FirebaseMigrationWrite[] = [
    ...channelWrites,
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
      const version = await collections.settings
        .doc("database_adapter_version")
        .get();
      if (version.data()?.version === 2) return;
      if (!isFirebaseMigrationConflict(error) || attempt === 2) throw error;
    }
  }
};
