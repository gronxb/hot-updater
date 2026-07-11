// noqa: SIZE_OK - Existing Firebase provider module; splitting belongs to a dedicated provider cleanup.
import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  getAssetBaseStorageUri,
  getBundlePatches,
  getManifestFileHash,
  getManifestStorageUri,
  getPatchBaseBundleId,
  getPatchBaseFileHash,
  getPatchFileHash,
  getPatchStorageUri,
  NIL_UUID,
  type SnakeCaseBundle,
  stripBundleArtifactMetadata,
} from "@hot-updater/core";
import type {
  Bundle,
  DatabaseBundlePatch,
  DatabaseBundleRecord,
  DatabasePluginDeclaration,
} from "@hot-updater/plugin-core";
import {
  filterCompatibleAppVersions,
  resolveUpdateInfoFromBundles,
  toBundleReadModel,
  toDatabaseBundlePatches,
  toDatabaseBundleRecord,
} from "@hot-updater/plugin-core";
import { createLegacyDatabasePlugin } from "@hot-updater/plugin-core/internal";
import admin from "firebase-admin";

import {
  beginFirebaseDatabaseTransaction,
  getTargetAppVersionDocId,
} from "./firebaseDatabaseTransaction";

type FirestoreBundleData = Omit<SnakeCaseBundle, "patches"> & {
  readonly patches?: Bundle["patches"] | null;
};

type BundleIndexReference = Pick<
  DatabaseBundleRecord,
  "channel" | "platform" | "targetAppVersion"
>;

const chunkValues = <T>(values: T[], size: number) => {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
};

const convertToBundle = (firestoreData: FirestoreBundleData): Bundle => {
  const rawMetadata = firestoreData.metadata;
  const storedPatches = firestoreData.patches;
  const patches =
    storedPatches && Array.isArray(storedPatches)
      ? storedPatches
      : getBundlePatches({
          metadata: rawMetadata,
          patchBaseBundleId: firestoreData.patch_base_bundle_id ?? null,
          patchBaseFileHash: firestoreData.patch_base_file_hash ?? null,
          patchFileHash: firestoreData.patch_file_hash ?? null,
          patchStorageUri: firestoreData.patch_storage_uri ?? null,
        });
  const primaryPatch = patches[0] ?? null;

  return {
    channel: firestoreData.channel,
    enabled: Boolean(firestoreData.enabled),
    shouldForceUpdate: Boolean(firestoreData.should_force_update),
    fileHash: firestoreData.file_hash,
    gitCommitHash: firestoreData.git_commit_hash,
    id: firestoreData.id,
    message: firestoreData.message,
    platform: firestoreData.platform,
    targetAppVersion: firestoreData.target_app_version,
    storageUri: firestoreData.storage_uri,
    fingerprintHash: firestoreData.fingerprint_hash,
    metadata: stripBundleArtifactMetadata(rawMetadata),
    manifestStorageUri: firestoreData.manifest_storage_uri ?? null,
    manifestFileHash: firestoreData.manifest_file_hash ?? null,
    assetBaseStorageUri: firestoreData.asset_base_storage_uri ?? null,
    patches,
    patchBaseBundleId:
      primaryPatch?.baseBundleId ?? firestoreData.patch_base_bundle_id ?? null,
    patchBaseFileHash:
      primaryPatch?.baseFileHash ?? firestoreData.patch_base_file_hash ?? null,
    patchFileHash:
      primaryPatch?.patchFileHash ?? firestoreData.patch_file_hash ?? null,
    patchStorageUri:
      primaryPatch?.patchStorageUri ?? firestoreData.patch_storage_uri ?? null,
    rolloutCohortCount:
      firestoreData.rollout_cohort_count ?? DEFAULT_ROLLOUT_COHORT_COUNT,
    targetCohorts: firestoreData.target_cohorts ?? null,
  };
};

const toFirestoreBundleData = (bundle: Bundle): FirestoreBundleData => ({
  id: bundle.id,
  channel: bundle.channel,
  enabled: bundle.enabled,
  should_force_update: bundle.shouldForceUpdate,
  file_hash: bundle.fileHash,
  git_commit_hash: bundle.gitCommitHash || null,
  message: bundle.message || null,
  platform: bundle.platform,
  target_app_version: bundle.targetAppVersion || null,
  storage_uri: bundle.storageUri,
  fingerprint_hash: bundle.fingerprintHash,
  metadata: stripBundleArtifactMetadata(bundle.metadata) ?? {},
  manifest_storage_uri: getManifestStorageUri(bundle),
  manifest_file_hash: getManifestFileHash(bundle),
  asset_base_storage_uri: getAssetBaseStorageUri(bundle),
  patches: bundle.patches ?? null,
  patch_base_bundle_id: getPatchBaseBundleId(bundle),
  patch_base_file_hash: getPatchBaseFileHash(bundle),
  patch_file_hash: getPatchFileHash(bundle),
  patch_storage_uri: getPatchStorageUri(bundle),
  rollout_cohort_count:
    bundle.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
  target_cohorts: bundle.targetCohorts ?? null,
});

const databaseBundleRecordToFirestoreData = (
  bundle: DatabaseBundleRecord,
): FirestoreBundleData => toFirestoreBundleData(toBundleReadModel(bundle));

const rowToDatabaseBundleRecord = (firestoreData: FirestoreBundleData) =>
  toDatabaseBundleRecord(convertToBundle(firestoreData));

const patchesToFirestoreFields = (
  patches: readonly DatabaseBundlePatch[],
): Partial<FirestoreBundleData> => {
  const sortedPatches = patches
    .slice()
    .sort(
      (left, right) =>
        left.orderIndex - right.orderIndex ||
        left.baseBundleId.localeCompare(right.baseBundleId),
    )
    .map((patch) => ({
      baseBundleId: patch.baseBundleId,
      baseFileHash: patch.baseFileHash,
      patchFileHash: patch.patchFileHash,
      patchStorageUri: patch.patchStorageUri,
    }));
  const primaryPatch = sortedPatches[0] ?? null;
  return {
    patches: sortedPatches,
    patch_base_bundle_id: primaryPatch?.baseBundleId ?? null,
    patch_base_file_hash: primaryPatch?.baseFileHash ?? null,
    patch_file_hash: primaryPatch?.patchFileHash ?? null,
    patch_storage_uri: primaryPatch?.patchStorageUri ?? null,
  };
};

export const firebaseDatabase = createLegacyDatabasePlugin({
  name: "firebaseDatabase",
  connect: (config: admin.AppOptions): DatabasePluginDeclaration => {
    let app: admin.app.App;
    try {
      app = admin.app();
    } catch {
      app = admin.initializeApp(config);
    }

    const db = admin.firestore(app);
    const bundlesCollection = db.collection("bundles");
    const targetAppVersionsCollection = db.collection("target_app_versions");
    const channelsCollection = db.collection("channels");

    const writeBundle = async (bundle: DatabaseBundleRecord) => {
      const bundleData = databaseBundleRecordToFirestoreData(bundle);
      await bundlesCollection.doc(bundle.id).set(bundleData, { merge: true });
      await channelsCollection.doc(bundle.channel).set(
        {
          name: bundle.channel,
        },
        { merge: true },
      );
      if (bundle.targetAppVersion) {
        const versionDocId = `${bundle.platform}_${bundle.channel}_${bundle.targetAppVersion}`;
        await targetAppVersionsCollection.doc(versionDocId).set(
          {
            channel: bundle.channel,
            platform: bundle.platform,
            target_app_version: bundle.targetAppVersion,
          },
          { merge: true },
        );
      }
    };

    const cleanupChannel = async (channel: string) => {
      const snapshot = await bundlesCollection
        .where("channel", "==", channel)
        .get();
      if (snapshot.empty) {
        await channelsCollection.doc(channel).delete();
      }
    };

    const cleanupTargetAppVersion = async (bundle: BundleIndexReference) => {
      const versionDocId = getTargetAppVersionDocId(bundle);
      if (!versionDocId || !bundle.targetAppVersion) {
        return;
      }

      const snapshot = await bundlesCollection
        .where("platform", "==", bundle.platform)
        .where("channel", "==", bundle.channel)
        .where("target_app_version", "==", bundle.targetAppVersion)
        .get();
      if (snapshot.empty) {
        await targetAppVersionsCollection.doc(versionDocId).delete();
      }
    };

    const cleanupBundleIndexes = async (bundle: BundleIndexReference) => {
      await Promise.all([
        cleanupChannel(bundle.channel),
        cleanupTargetAppVersion(bundle),
      ]);
    };

    const getAllBundlePatchRecords = async () => {
      const querySnapshot = await bundlesCollection.get();
      return querySnapshot.docs
        .map((doc) => convertToBundle(doc.data() as FirestoreBundleData))
        .flatMap(toDatabaseBundlePatches);
    };

    const getBundlePatchRecords = async (
      bundleId: string,
    ): Promise<readonly DatabaseBundlePatch[] | null> => {
      const bundleSnap = await bundlesCollection.doc(bundleId).get();
      if (!bundleSnap.exists) return null;
      return toDatabaseBundlePatches(
        convertToBundle(bundleSnap.data() as FirestoreBundleData),
      );
    };

    const replaceBundlePatches = async (
      bundleId: string,
      patches: readonly DatabaseBundlePatch[],
    ) => {
      const bundleRef = bundlesCollection.doc(bundleId);
      const bundleSnap = await bundleRef.get();
      if (!bundleSnap.exists) {
        throw new Error("targetBundleId not found");
      }
      await bundleRef.set(patchesToFirestoreFields(patches), { merge: true });
    };

    return {
      beginTransaction: () =>
        beginFirebaseDatabaseTransaction({
          runTransaction: (callback) =>
            db.runTransaction(async (transaction) => {
              await callback({
                readBundles: async () => {
                  const snapshot = await transaction.get(bundlesCollection);
                  return snapshot.docs.map((document) => ({
                    id: document.id,
                    data: document.data(),
                  }));
                },
                setBundle: (bundleId, data) => {
                  transaction.set(bundlesCollection.doc(bundleId), data, {
                    merge: true,
                  });
                },
                deleteBundle: (bundleId) => {
                  transaction.delete(bundlesCollection.doc(bundleId));
                },
                setChannel: (channel) => {
                  transaction.set(
                    channelsCollection.doc(channel),
                    { name: channel },
                    { merge: true },
                  );
                },
                deleteChannel: (channel) => {
                  transaction.delete(channelsCollection.doc(channel));
                },
                setTargetAppVersion: (docId, bundle) => {
                  transaction.set(
                    targetAppVersionsCollection.doc(docId),
                    {
                      channel: bundle.channel,
                      platform: bundle.platform,
                      target_app_version: bundle.targetAppVersion,
                    },
                    { merge: true },
                  );
                },
                deleteTargetAppVersion: (docId) => {
                  transaction.delete(targetAppVersionsCollection.doc(docId));
                },
              });
            }),
          decodeBundle: (data) => {
            const bundle = convertToBundle(data as FirestoreBundleData);
            return {
              record: toDatabaseBundleRecord(bundle),
              patches: toDatabaseBundlePatches(bundle),
            };
          },
          encodeBundle: ({ record, patches }) => ({
            ...databaseBundleRecordToFirestoreData(record),
            ...patchesToFirestoreFields(patches),
          }),
        }),
      bundles: {
        async getById({ bundleId }) {
          const bundleSnap = await bundlesCollection.doc(bundleId).get();
          if (!bundleSnap.exists) {
            return null;
          }
          return rowToDatabaseBundleRecord(
            bundleSnap.data() as FirestoreBundleData,
          );
        },

        async findRecords() {
          const querySnapshot = await bundlesCollection.get();
          return querySnapshot.docs.map((doc) =>
            rowToDatabaseBundleRecord(doc.data() as FirestoreBundleData),
          );
        },

        async insert({ bundle }) {
          await writeBundle(bundle);
        },

        async update({ bundleId, patch }) {
          const bundleSnap = await bundlesCollection.doc(bundleId).get();
          if (!bundleSnap.exists) {
            throw new Error("targetBundleId not found");
          }
          const currentBundle = rowToDatabaseBundleRecord(
            bundleSnap.data() as FirestoreBundleData,
          );
          await writeBundle({
            ...currentBundle,
            ...patch,
            id: bundleId,
          });
          await cleanupBundleIndexes(currentBundle);
        },

        async delete({ bundleId }) {
          const bundleSnap = await bundlesCollection.doc(bundleId).get();
          const currentBundle = bundleSnap.exists
            ? rowToDatabaseBundleRecord(
                bundleSnap.data() as FirestoreBundleData,
              )
            : null;
          await bundlesCollection.doc(bundleId).delete();
          if (currentBundle) {
            await cleanupBundleIndexes(currentBundle);
          }
        },
      },

      patches: {
        storage: "embedded",
        findPatches: () => getAllBundlePatchRecords(),
        getBundlePatches: ({ bundleId }) => getBundlePatchRecords(bundleId),
        replaceBundlePatches: ({ bundleId, patches }) =>
          replaceBundlePatches(bundleId, patches),
      },

      updateInfo: {
        async get(args) {
          const channel = args.channel ?? "production";
          const minBundleId = args.minBundleId ?? NIL_UUID;

          if (args._updateStrategy === "appVersion") {
            const querySnapshot = await targetAppVersionsCollection
              .where("platform", "==", args.platform)
              .where("channel", "==", channel)
              .select("target_app_version")
              .get();

            const targetAppVersions = Array.from(
              new Set(
                querySnapshot.docs
                  .map(
                    (doc) =>
                      doc.data().target_app_version as string | undefined,
                  )
                  .filter((version): version is string => Boolean(version)),
              ),
            );
            const compatibleAppVersions = filterCompatibleAppVersions(
              targetAppVersions,
              args.appVersion,
            );
            const results =
              compatibleAppVersions.length > 0
                ? await Promise.all(
                    chunkValues(compatibleAppVersions, 10).map((versions) =>
                      bundlesCollection
                        .where("platform", "==", args.platform)
                        .where("channel", "==", channel)
                        .where("enabled", "==", true)
                        .where("id", ">=", minBundleId)
                        .where("target_app_version", "in", versions)
                        .get(),
                    ),
                  )
                : [];
            const bundles = results.flatMap((snapshot) =>
              snapshot.docs.map((doc) =>
                convertToBundle(doc.data() as FirestoreBundleData),
              ),
            );

            return resolveUpdateInfoFromBundles({
              args: { ...args, channel, minBundleId },
              bundles,
            });
          }

          const querySnapshot = await bundlesCollection
            .where("platform", "==", args.platform)
            .where("channel", "==", channel)
            .where("enabled", "==", true)
            .where("id", ">=", minBundleId)
            .where("fingerprint_hash", "==", args.fingerprintHash)
            .get();

          const bundles = querySnapshot.docs.map((doc) =>
            convertToBundle(doc.data() as FirestoreBundleData),
          );

          return resolveUpdateInfoFromBundles({
            args: { ...args, channel, minBundleId },
            bundles,
          });
        },
      },
    };
  },
});
