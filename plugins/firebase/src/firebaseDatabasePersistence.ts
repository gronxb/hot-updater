import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
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
  parseFirebaseChannelRow,
  parseFirebaseLegacyBundleRow,
  parseFirebaseLegacyPatchRows,
  parseFirebasePatchRow,
} from "./firebaseDatabaseParser";
import type { FirebaseDatabaseSnapshot } from "./firebaseDatabaseState";
import { FirebaseDatabaseConstraintError } from "./firebaseDatabaseState";

export interface FirebaseDatabaseCollections {
  readonly bundles: CollectionReference<DocumentData>;
  readonly bundlePatches: CollectionReference<DocumentData>;
  readonly bundleEvents: CollectionReference<DocumentData>;
  readonly channels: CollectionReference<DocumentData>;
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
  channels: db.collection("channels"),
  clientAccessKeys: db.collection("client_access_keys"),
  settings: db.collection("private_hot_updater_settings"),
});

type FixedRow =
  | BundleEventRow
  | BundlePatchRow
  | BundleRow
  | ChannelRow
  | ClientAccessKeyRow;
type FixedModel =
  | "bundle_events"
  | "bundle_patches"
  | "bundles"
  | "channels"
  | "client_access_keys";

export const firebaseChannelDocumentId = (name: string): string =>
  `name_${Buffer.from(name, "utf8").toString("base64url")}`;

export const firebaseChannelIdDocumentId = (id: string): string =>
  `channel_id_${Buffer.from(id, "utf8").toString("base64url")}`;

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
  QuerySnapshot<DocumentData>,
];

const toSnapshot = (
  documents: CoreSnapshotDocuments,
): FirebaseDatabaseSnapshot => {
  const snapshot: FirebaseDatabaseSnapshot = {
    bundles: bundleMap(documents[0]),
    bundlePatches: patchMap(documents[1]),
    bundleEvents: eventMap(documents[2]),
    channels: channelMap(documents[3]),
    clientAccessKeys: clientAccessKeyMap(documents[4]),
  };
  for (const bundle of snapshot.bundles.values()) {
    const channel = snapshot.channels.get(bundle.channel_id);
    if (channel === undefined) {
      throw new FirebaseDatabaseConstraintError(
        "bundles.channel_id.foreign-key",
      );
    }
    if (channel.name !== bundle.channel) {
      throw new FirebaseDatabaseConstraintError("bundles.channel.dual-write");
    }
  }
  return snapshot;
};

export const loadFirebaseDatabaseSnapshot = async (
  collections: FirebaseDatabaseCollections,
): Promise<FirebaseDatabaseSnapshot> => {
  const [bundles, patches, events, channels, clientAccessKeys] =
    await Promise.all([
      collections.bundles.get(),
      collections.bundlePatches.get(),
      collections.bundleEvents.get(),
      collections.channels.get(),
      collections.clientAccessKeys.get(),
    ]);
  return toSnapshot([bundles, patches, events, channels, clientAccessKeys]);
};

export const loadFirebaseTransactionSnapshot = async (
  transaction: Transaction,
  collections: FirebaseDatabaseCollections,
): Promise<FirebaseDatabaseSnapshot> => {
  const [bundles, patches, events, channels, clientAccessKeys] =
    await Promise.all([
      transaction.get(collections.bundles),
      transaction.get(collections.bundlePatches),
      transaction.get(collections.bundleEvents),
      transaction.get(collections.channels),
      transaction.get(collections.clientAccessKeys),
    ]);
  return toSnapshot([bundles, patches, events, channels, clientAccessKeys]);
};

type PersistCollectionInput<TRow extends FixedRow> = {
  readonly transaction: Transaction;
  readonly collection: CollectionReference<DocumentData>;
  readonly before: ReadonlyMap<string, TRow>;
  readonly after: ReadonlyMap<string, TRow>;
  readonly documentId?: (row: TRow) => string;
};

const persistCollection = <TRow extends FixedRow>({
  transaction,
  collection,
  before,
  after,
  documentId = (row) => row.id,
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
    collection: collections.clientAccessKeys,
    before: before.clientAccessKeys,
    after: after.clientAccessKeys,
  });
};

const applyFirebaseMigrationWrites = async (
  db: Firestore,
  writes: readonly FirebaseMigrationWrite[],
): Promise<void> => {
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

const migrateFirebaseDatabaseAttempt = async (
  db: Firestore,
  collections: FirebaseDatabaseCollections,
): Promise<void> => {
  const versionDocument = collections.settings.doc("database_adapter_version");
  const version = await versionDocument.get();
  const adapterVersion = version.data()?.version;
  if (adapterVersion === 3) return;
  if (version.exists && adapterVersion !== 1 && adapterVersion !== 2) {
    throw new FirebaseDatabaseAdapterVersionError(adapterVersion);
  }

  const [bundles, patches, channels] = await Promise.all([
    collections.bundles.get(),
    collections.bundlePatches.get(),
    collections.channels.get(),
  ]);
  const parsedBundles = bundles.docs.map((document) => ({
    document,
    row: parseFirebaseLegacyBundleRow(
      document.data(),
      `bundles/${document.id}`,
    ),
  }));
  const bundleIds = new Set<string>();
  for (const { row } of parsedBundles) {
    if (bundleIds.has(row.id)) {
      throw new FirebaseDatabaseConstraintError("bundles.id.unique");
    }
    bundleIds.add(row.id);
  }
  for (const { document, row } of parsedBundles) {
    if (document.id !== row.id) {
      throw new FirebaseDatabaseConstraintError("bundles.id.document-key");
    }
  }

  const parsedPatches = patches.docs.map((document) => ({
    document,
    row: parseFirebasePatchRow(
      document.data(),
      `bundle_patches/${document.id}`,
    ),
  }));
  const existingPatches = documentMap("bundle_patches", parsedPatches);
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

  const existingChannels = channelMap(channels);
  const channelsByName = new Map(
    [...existingChannels.values()].map((row) => [row.name, row]),
  );
  const channelWrites: FirebaseMigrationWrite[] = [];
  for (const name of new Set(parsedBundles.map(({ row }) => row.channel))) {
    if (channelsByName.has(name)) continue;
    const row: ChannelRow = { id: collections.channels.doc().id, name };
    channelWrites.push({
      kind: "create",
      reference: collections.channels.doc(firebaseChannelDocumentId(name)),
      value: { ...row },
    });
    channelsByName.set(name, row);
  }
  await applyFirebaseMigrationWrites(db, channelWrites);

  const canonicalChannels = channelMap(await collections.channels.get());
  const canonicalChannelsByName = new Map(
    [...canonicalChannels.values()].map((row) => [row.name, row]),
  );
  const patchWrites: FirebaseMigrationWrite[] = [];
  const bundleWrites: FirebaseMigrationWrite[] = [];
  const channelIdWrites: FirebaseMigrationWrite[] = [];
  const migratesLegacyPatches = adapterVersion !== 2;

  const settings = await collections.settings.get();
  const settingIds = new Set(settings.docs.map(({ id }) => id));
  for (const document of settings.docs) {
    if (!document.id.startsWith("channel_id_")) continue;
    const row = parseFirebaseChannelRow(
      document.data(),
      `private_hot_updater_settings/${document.id}`,
    );
    const canonical = canonicalChannels.get(row.id);
    if (
      document.id !== firebaseChannelIdDocumentId(row.id) ||
      canonical?.name !== row.name
    ) {
      throw new FirebaseDatabaseConstraintError("channels.id.registry");
    }
  }
  for (const channel of canonicalChannels.values()) {
    const documentId = firebaseChannelIdDocumentId(channel.id);
    if (!settingIds.has(documentId)) {
      channelIdWrites.push({
        kind: "create",
        reference: collections.settings.doc(documentId),
        value: { ...channel },
      });
    }
  }
  await applyFirebaseMigrationWrites(db, channelIdWrites);

  for (const { document, row: bundle } of parsedBundles) {
    const channel = canonicalChannelsByName.get(bundle.channel);
    if (channel === undefined) {
      throw new FirebaseDatabaseConstraintError(
        "bundles.channel_id.foreign-key",
      );
    }
    const legacyPatches = migratesLegacyPatches
      ? parseFirebaseLegacyPatchRows(
          document.data(),
          bundle.id,
          `bundles/${document.id}`,
        )
      : [];
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
        channel_id: channel.id,
        patches: FieldValue.delete(),
        patch_base_bundle_id: FieldValue.delete(),
        patch_base_file_hash: FieldValue.delete(),
        patch_file_hash: FieldValue.delete(),
        patch_storage_uri: FieldValue.delete(),
      },
    });
  }

  await applyFirebaseMigrationWrites(db, [
    ...patchWrites,
    ...bundleWrites,
    version.exists
      ? {
          kind: "update",
          reference: versionDocument,
          updateTime: requireUpdateTime(version, versionDocument.path),
          value: { version: 3 },
        }
      : {
          kind: "create",
          reference: versionDocument,
          value: { version: 3 },
        },
  ]);
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
      if (version.data()?.version === 3) return;
      if (attempt === 2) throw error;
    }
  }
};
