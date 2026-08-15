import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  ClientAccessKeyRow,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { compileLegacyReleaseCatalogBackfill } from "@hot-updater/server";
import { isEqual } from "es-toolkit";
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
  parseFirebaseReleaseCatalogRow,
  parseFirebaseReleaseRow,
} from "./firebaseDatabaseParser";
import type { FirebaseDatabaseSnapshot } from "./firebaseDatabaseState";
import { FirebaseDatabaseConstraintError } from "./firebaseDatabaseState";

export interface FirebaseDatabaseCollections {
  readonly bundles: CollectionReference<DocumentData>;
  readonly bundlePatches: CollectionReference<DocumentData>;
  readonly bundleEvents: CollectionReference<DocumentData>;
  readonly channels: CollectionReference<DocumentData>;
  readonly clientAccessKeys: CollectionReference<DocumentData>;
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
  bundles: db.collection("bundles"),
  bundlePatches: db.collection("bundle_patches"),
  bundleEvents: db.collection("bundle_events"),
  channels: db.collection("channels"),
  clientAccessKeys: db.collection("client_access_keys"),
  releaseCatalogs: db.collection("release_catalogs"),
  releases: db.collection("releases"),
  settings: db.collection("private_hot_updater_settings"),
});

type FixedRow =
  | BundleEventRow
  | BundlePatchRow
  | BundleRow
  | ChannelRow
  | ClientAccessKeyRow
  | ReleaseCatalogRow
  | ReleaseRow;
type FixedModel =
  | "bundle_events"
  | "bundle_patches"
  | "bundles"
  | "channels"
  | "client_access_keys"
  | "release_catalogs"
  | "releases";

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
  const key = "id" in row ? row.id : row.scope_key;
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
    const key = "id" in row ? row.id : row.scope_key;
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
    releases: releaseMap(documents[5]),
    releaseCatalogs: releaseCatalogMap(documents[6]),
  };
  return snapshot;
};

export const loadFirebaseDatabaseSnapshot = async (
  collections: FirebaseDatabaseCollections,
): Promise<FirebaseDatabaseSnapshot> => {
  const [
    bundles,
    patches,
    events,
    channels,
    clientAccessKeys,
    releases,
    releaseCatalogs,
  ] = await Promise.all([
    collections.bundles.get(),
    collections.bundlePatches.get(),
    collections.bundleEvents.get(),
    collections.channels.get(),
    collections.clientAccessKeys.get(),
    collections.releases.get(),
    collections.releaseCatalogs.get(),
  ]);
  return toSnapshot([
    bundles,
    patches,
    events,
    channels,
    clientAccessKeys,
    releases,
    releaseCatalogs,
  ]);
};

export const loadFirebaseTransactionSnapshot = async (
  transaction: Transaction,
  collections: FirebaseDatabaseCollections,
): Promise<FirebaseDatabaseSnapshot> => {
  const [
    bundles,
    patches,
    events,
    channels,
    clientAccessKeys,
    releases,
    releaseCatalogs,
  ] = await Promise.all([
    transaction.get(collections.bundles),
    transaction.get(collections.bundlePatches),
    transaction.get(collections.bundleEvents),
    transaction.get(collections.channels),
    transaction.get(collections.clientAccessKeys),
    transaction.get(collections.releases),
    transaction.get(collections.releaseCatalogs),
  ]);
  return toSnapshot([
    bundles,
    patches,
    events,
    channels,
    clientAccessKeys,
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
    collection: collections.bundleEvents,
    before: before.bundleEvents,
    after: after.bundleEvents,
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
    collection: collections.clientAccessKeys,
    before: before.clientAccessKeys,
    after: after.clientAccessKeys,
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

const legacyBundlePolicyFields = [
  "should_force_update",
  "enabled",
  "message",
  "channel",
  "channel_id",
  "target_app_version",
  "fingerprint_hash",
  "rollout_cohort_count",
  "target_cohorts",
  "patches",
  "patch_base_bundle_id",
  "patch_base_file_hash",
  "patch_file_hash",
  "patch_storage_uri",
] as const;

const cleanupFirebaseLegacyBundles = async (
  db: Firestore,
  collections: FirebaseDatabaseCollections,
): Promise<void> => {
  const bundles = await collections.bundles.get();
  const writes: FirebaseMigrationWrite[] = [];
  for (const document of bundles.docs) {
    const data = document.data();
    const row = requireFirebaseDocumentKey(
      "bundles",
      document.id,
      parseFirebaseBundleRow(data, `bundles/${document.id}`),
    );
    if (!legacyBundlePolicyFields.some((field) => field in data)) continue;
    writes.push({
      kind: "update",
      reference: document.ref,
      updateTime: requireUpdateTime(document, `bundles/${document.id}`),
      value: {
        ...row,
        ...Object.fromEntries(
          legacyBundlePolicyFields.map((field) => [field, FieldValue.delete()]),
        ),
      },
    });
  }
  await applyFirebaseMigrationWrites(db, writes);

  const versionDocument = collections.settings.doc("database_adapter_version");
  const version = await versionDocument.get();
  if (version.data()?.version !== 4) {
    throw new FirebaseDatabaseAdapterVersionError(version.data()?.version);
  }
  await applyFirebaseMigrationWrites(db, [
    {
      kind: "update",
      reference: versionDocument,
      updateTime: requireUpdateTime(version, versionDocument.path),
      value: { version: 4, cleanup_pending: FieldValue.delete() },
    },
  ]);
};

const migrateFirebaseDatabaseAttempt = async (
  db: Firestore,
  collections: FirebaseDatabaseCollections,
  authorityId: string | undefined,
): Promise<void> => {
  const versionDocument = collections.settings.doc("database_adapter_version");
  const version = await versionDocument.get();
  const adapterVersion = version.data()?.version;
  if (adapterVersion === 4) {
    if (version.data()?.cleanup_pending === true) {
      await cleanupFirebaseLegacyBundles(db, collections);
    }
    return;
  }
  if (
    version.exists &&
    adapterVersion !== 1 &&
    adapterVersion !== 2 &&
    adapterVersion !== 3
  ) {
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
  const backfill = await compileLegacyReleaseCatalogBackfill({
    authorityId,
    rows: parsedBundles.map(({ row }) => row),
  });

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
    const row: ChannelRow = { id: firebaseChannelDocumentId(name), name };
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
  const releaseWrites: FirebaseMigrationWrite[] = [];
  const releaseCatalogWrites: FirebaseMigrationWrite[] = [];
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

  const [storedReleases, storedCatalogs] = await Promise.all([
    collections.releases.get(),
    collections.releaseCatalogs.get(),
  ]);
  const existingReleases = releaseMap(storedReleases);
  const existingCatalogs = releaseCatalogMap(storedCatalogs);
  for (const { channelName, row } of backfill.releases) {
    const channel = canonicalChannelsByName.get(channelName);
    if (channel === undefined) {
      throw new FirebaseDatabaseConstraintError(
        "releases.channel_id.foreign-key",
      );
    }
    const desired = { ...row, channel_id: channel.id };
    const existing = existingReleases.get(row.id);
    if (existing && !isEqual(existing, desired)) {
      throw new FirebaseDatabaseConstraintError("releases.id.conflict");
    }
    if (!existing) {
      releaseWrites.push({
        kind: "create",
        reference: collections.releases.doc(row.id),
        value: desired,
      });
    }
  }
  for (const { channelName, row } of backfill.catalogs) {
    const channel = canonicalChannelsByName.get(channelName);
    if (channel === undefined) {
      throw new FirebaseDatabaseConstraintError(
        "release_catalogs.channel_id.foreign-key",
      );
    }
    const desired = { ...row, channel_id: channel.id };
    const existing = existingCatalogs.get(row.scope_key);
    if (existing && !isEqual(existing, desired)) {
      throw new FirebaseDatabaseConstraintError(
        "release_catalogs.scope_key.conflict",
      );
    }
    if (!existing) {
      releaseCatalogWrites.push({
        kind: "create",
        reference: collections.releaseCatalogs.doc(row.scope_key),
        value: desired,
      });
    }
  }

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
        id: bundle.id,
        platform: bundle.platform,
        file_hash: bundle.file_hash,
        git_commit_hash: bundle.git_commit_hash,
        storage_uri: bundle.storage_uri,
        metadata: bundle.metadata,
        manifest_storage_uri: bundle.manifest_storage_uri,
        manifest_file_hash: bundle.manifest_file_hash,
        asset_base_storage_uri: bundle.asset_base_storage_uri,
        should_force_update: FieldValue.delete(),
        enabled: FieldValue.delete(),
        message: FieldValue.delete(),
        channel: FieldValue.delete(),
        channel_id: FieldValue.delete(),
        target_app_version: FieldValue.delete(),
        fingerprint_hash: FieldValue.delete(),
        rollout_cohort_count: FieldValue.delete(),
        target_cohorts: FieldValue.delete(),
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
    ...releaseWrites,
    ...releaseCatalogWrites,
    version.exists
      ? {
          kind: "update",
          reference: versionDocument,
          updateTime: requireUpdateTime(version, versionDocument.path),
          value: { version: 4, cleanup_pending: true },
        }
      : {
          kind: "create",
          reference: versionDocument,
          value: { version: 4, cleanup_pending: true },
        },
  ]);
  await applyFirebaseMigrationWrites(db, bundleWrites);
  await cleanupFirebaseLegacyBundles(db, collections);
};

const isFirebaseMigrationConflict = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  return code === 6 || code === 9 || code === 10;
};

export const migrateFirebaseDatabase = async (
  db: Firestore,
  collections: FirebaseDatabaseCollections,
  authorityId?: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await migrateFirebaseDatabaseAttempt(db, collections, authorityId);
      return;
    } catch (error) {
      if (error instanceof FirebaseDatabaseAdapterVersionError) throw error;
      if (!isFirebaseMigrationConflict(error)) throw error;
      const version = await collections.settings
        .doc("database_adapter_version")
        .get();
      if (version.data()?.version === 4) return;
      if (attempt === 2) throw error;
    }
  }
};
