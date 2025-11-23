import type { SnakeCaseBundle } from "@hot-updater/core";
import type { Bundle } from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import * as admin from "firebase-admin";

type FirestoreData = admin.firestore.DocumentData;

const convertToBundle = (firestoreData: SnakeCaseBundle): Bundle => ({
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
  metadata: firestoreData?.metadata ?? {},
  signature: firestoreData.signature ?? null,
});

export const firebaseDatabase = createDatabasePlugin<admin.AppOptions>({
  name: "firebaseDatabase",
  factory: (config) => {
    let bundles: Bundle[] = [];

    let app: admin.app.App;
    try {
      app = admin.app();
    } catch {
      app = admin.initializeApp(config);
    }

    const db = admin.firestore(app);
    const bundlesCollection = db.collection("bundles");

    return {
      async getBundleById(bundleId) {
        const found = bundles.find((b) => b.id === bundleId);
        if (found) {
          return found;
        }

        const bundleRef = bundlesCollection.doc(bundleId);
        const bundleSnap = await bundleRef.get();

        if (!bundleSnap.exists) {
          return null;
        }

        const firestoreData = bundleSnap.data() as SnakeCaseBundle;
        return convertToBundle(firestoreData);
      },

      async getBundles(options) {
        const { where, limit, offset } = options;

        let query: admin.firestore.Query<FirestoreData> = bundlesCollection;

        if (where?.channel) {
          query = query.where("channel", "==", where.channel);
        }
        if (where?.platform) {
          query = query.where("platform", "==", where.platform);
        }

        query = query.orderBy("id", "desc");

        const totalCountQuery = query;
        const totalSnapshot = await totalCountQuery.get();
        const total = totalSnapshot.size;

        if (offset > 0) {
          query = query.offset(offset);
        }
        if (limit) {
          query = query.limit(limit);
        }

        const querySnapshot = await query.get();

        bundles = querySnapshot.docs.map((doc) =>
          convertToBundle(doc.data() as SnakeCaseBundle),
        );

        return {
          data: bundles,
          pagination: calculatePagination(total, {
            limit,
            offset,
          }),
        };
      },

      async getChannels() {
        const channelsCollection = db.collection("channels");
        const querySnapshot = await channelsCollection.get();

        if (querySnapshot.empty) {
          return [];
        }

        const channels = new Set<string>();
        for (const doc of querySnapshot.docs) {
          const data = doc.data();
          if (data.name) {
            channels.add(data.name as string);
          }
        }

        return Array.from(channels);
      },

      async commitBundle({ changedSets }) {
        if (changedSets.length === 0) {
          return;
        }

        let isTargetAppVersionChanged = false;
        const deletedBundleIds = new Set<string>();

        await db.runTransaction(async (transaction) => {
          const bundlesSnapshot = await transaction.get(bundlesCollection);
          const targetVersionsSnapshot = await transaction.get(
            db.collection("target_app_versions"),
          );
          const channelsSnapshot = await transaction.get(
            db.collection("channels"),
          );

          const bundlesMap: { [id: string]: any } = {};
          for (const doc of bundlesSnapshot.docs) {
            bundlesMap[doc.id] = doc.data();
          }

          // Process all operations
          for (const { operation, data } of changedSets) {
            if (data.targetAppVersion) {
              isTargetAppVersionChanged = true;
            }

            if (operation === "insert" || operation === "update") {
              bundlesMap[data.id] = {
                id: data.id,
                channel: data.channel,
                enabled: data.enabled,
                should_force_update: data.shouldForceUpdate,
                file_hash: data.fileHash,
                git_commit_hash: data.gitCommitHash || null,
                message: data.message || null,
                platform: data.platform,
                target_app_version: data.targetAppVersion,
                storage_uri: data.storageUri,
                fingerprint_hash: data.fingerprintHash,
                metadata: data.metadata ?? {},
                signature: data.signature ?? null,
              } as SnakeCaseBundle;

              // Add channel to channels collection
              const channelRef = db.collection("channels").doc(data.channel);
              transaction.set(
                channelRef,
                {
                  name: data.channel,
                },
                { merge: true },
              );
            } else if (operation === "delete") {
              // Check if bundle exists
              if (!bundlesMap[data.id]) {
                throw new Error(`Bundle with id ${data.id} not found`);
              }

              // Remove from bundlesMap
              delete bundlesMap[data.id];
              deletedBundleIds.add(data.id);
              isTargetAppVersionChanged = true;
            }
          }

          // Calculate required target app versions and channels from remaining bundles
          const requiredTargetVersionKeys = new Set<string>();
          const requiredChannels = new Set<string>();
          for (const bundle of Object.values(bundlesMap)) {
            if (bundle.target_app_version) {
              const key = `${bundle.platform}_${bundle.channel}_${bundle.target_app_version}`;
              requiredTargetVersionKeys.add(key);
            }
            requiredChannels.add(bundle.channel);
          }

          // Execute database operations
          for (const { operation, data } of changedSets) {
            const bundleRef = bundlesCollection.doc(data.id);

            if (operation === "insert" || operation === "update") {
              transaction.set(
                bundleRef,
                {
                  id: data.id,
                  channel: data.channel,
                  enabled: data.enabled,
                  should_force_update: data.shouldForceUpdate,
                  file_hash: data.fileHash,
                  git_commit_hash: data.gitCommitHash || null,
                  message: data.message || null,
                  platform: data.platform,
                  target_app_version: data.targetAppVersion || null,
                  storage_uri: data.storageUri,
                  fingerprint_hash: data.fingerprintHash,
                  metadata: data.metadata ?? {},
                  signature: data.signature ?? null,
                } as SnakeCaseBundle,
                { merge: true },
              );

              if (data.targetAppVersion) {
                const versionDocId = `${data.platform}_${data.channel}_${data.targetAppVersion}`;
                const targetAppVersionsRef = db
                  .collection("target_app_versions")
                  .doc(versionDocId);
                transaction.set(
                  targetAppVersionsRef,
                  {
                    channel: data.channel,
                    platform: data.platform,
                    target_app_version: data.targetAppVersion,
                  },
                  { merge: true },
                );
              }
            } else if (operation === "delete") {
              // Delete the bundle document
              transaction.delete(bundleRef);
            }
          }

          // Clean up orphaned target app versions
          if (isTargetAppVersionChanged) {
            for (const targetDoc of targetVersionsSnapshot.docs) {
              if (!requiredTargetVersionKeys.has(targetDoc.id)) {
                transaction.delete(targetDoc.ref);
              }
            }
          }

          // Clean up orphaned channels
          for (const channelDoc of channelsSnapshot.docs) {
            if (!requiredChannels.has(channelDoc.id)) {
              transaction.delete(channelDoc.ref);
            }
          }
        });

        // Update local cache
        for (const bundleId of deletedBundleIds) {
          bundles = bundles.filter((b) => b.id !== bundleId);
        }
      },
    };
  },
});
