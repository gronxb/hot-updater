import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  type SnakeCaseBundle,
} from "@hot-updater/core";
import type {
  Bundle,
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import admin from "firebase-admin";

type FirestoreData = admin.firestore.DocumentData;

const bundleMatchesQueryWhere = (
  bundle: Bundle,
  where: DatabaseBundleQueryWhere | undefined,
) => {
  if (!where) return true;
  if (where.channel !== undefined && bundle.channel !== where.channel)
    return false;
  if (where.platform !== undefined && bundle.platform !== where.platform)
    return false;
  if (where.enabled !== undefined && bundle.enabled !== where.enabled)
    return false;
  if (where.id?.eq !== undefined && bundle.id !== where.id.eq) return false;
  if (where.id?.gt !== undefined && bundle.id.localeCompare(where.id.gt) <= 0)
    return false;
  if (where.id?.gte !== undefined && bundle.id.localeCompare(where.id.gte) < 0)
    return false;
  if (where.id?.lt !== undefined && bundle.id.localeCompare(where.id.lt) >= 0)
    return false;
  if (where.id?.lte !== undefined && bundle.id.localeCompare(where.id.lte) > 0)
    return false;
  if (where.id?.in && !where.id.in.includes(bundle.id)) return false;
  if (where.targetAppVersionNotNull && bundle.targetAppVersion === null) {
    return false;
  }
  if (
    where.targetAppVersion !== undefined &&
    bundle.targetAppVersion !== where.targetAppVersion
  ) {
    return false;
  }
  if (
    where.targetAppVersionIn &&
    !where.targetAppVersionIn.includes(bundle.targetAppVersion ?? "")
  ) {
    return false;
  }
  if (
    where.fingerprintHash !== undefined &&
    bundle.fingerprintHash !== where.fingerprintHash
  ) {
    return false;
  }
  return true;
};

const sortBundles = (
  bundles: Bundle[],
  orderBy: DatabaseBundleQueryOrder | undefined,
) => {
  const direction = orderBy?.direction ?? "desc";
  return bundles.slice().sort((a, b) => {
    const result = a.id.localeCompare(b.id);
    return direction === "asc" ? result : -result;
  });
};

const applyFirestoreQueryableFilters = (
  query: admin.firestore.Query<FirestoreData>,
  where: DatabaseBundleQueryWhere | undefined,
) => {
  let nextQuery = query;

  if (where?.channel) {
    nextQuery = nextQuery.where("channel", "==", where.channel);
  }
  if (where?.platform) {
    nextQuery = nextQuery.where("platform", "==", where.platform);
  }
  if (where?.enabled !== undefined) {
    nextQuery = nextQuery.where("enabled", "==", where.enabled);
  }
  if (where?.fingerprintHash !== undefined && where.fingerprintHash !== null) {
    nextQuery = nextQuery.where(
      "fingerprint_hash",
      "==",
      where.fingerprintHash,
    );
  }
  if (
    where?.targetAppVersion !== undefined &&
    where.targetAppVersion !== null
  ) {
    nextQuery = nextQuery.where(
      "target_app_version",
      "==",
      where.targetAppVersion,
    );
  }
  if (where?.id?.eq) {
    nextQuery = nextQuery.where("id", "==", where.id.eq);
  }
  if (where?.id?.gt) {
    nextQuery = nextQuery.where("id", ">", where.id.gt);
  }
  if (where?.id?.gte) {
    nextQuery = nextQuery.where("id", ">=", where.id.gte);
  }
  if (where?.id?.lt) {
    nextQuery = nextQuery.where("id", "<", where.id.lt);
  }
  if (where?.id?.lte) {
    nextQuery = nextQuery.where("id", "<=", where.id.lte);
  }

  return nextQuery;
};

const requiresInMemoryFiltering = (
  where: DatabaseBundleQueryWhere | undefined,
) => {
  return Boolean(
    where?.id?.in ||
    where?.targetAppVersionIn ||
    where?.targetAppVersionNotNull ||
    where?.targetAppVersion === null ||
    where?.fingerprintHash === null,
  );
};

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
  rolloutCohortCount:
    firestoreData.rollout_cohort_count ?? DEFAULT_ROLLOUT_COHORT_COUNT,
  targetCohorts: firestoreData.target_cohorts ?? null,
});

export const firebaseDatabase = createDatabasePlugin<admin.AppOptions>({
  name: "firebaseDatabase",
  factory: (config) => {
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
        const bundleRef = bundlesCollection.doc(bundleId);
        const bundleSnap = await bundleRef.get();

        if (!bundleSnap.exists) {
          return null;
        }

        const firestoreData = bundleSnap.data() as SnakeCaseBundle;
        return convertToBundle(firestoreData);
      },

      async getBundles(options) {
        const { where, limit, offset, orderBy } = options;

        let query = applyFirestoreQueryableFilters(bundlesCollection, where);

        query = query.orderBy(
          "id",
          orderBy?.direction === "asc" ? "asc" : "desc",
        );

        if (requiresInMemoryFiltering(where)) {
          const querySnapshot = await query.get();
          const filteredBundles = sortBundles(
            querySnapshot.docs
              .map((doc) => convertToBundle(doc.data() as SnakeCaseBundle))
              .filter((bundle) => bundleMatchesQueryWhere(bundle, where)),
            orderBy,
          );
          const total = filteredBundles.length;
          const data = filteredBundles.slice(offset, offset + limit);

          return {
            data,
            pagination: calculatePagination(total, {
              limit,
              offset,
            }),
          };
        }

        const totalSnapshot = await query.get();
        const total = totalSnapshot.size;

        if (offset > 0) {
          query = query.offset(offset);
        }
        if (limit) {
          query = query.limit(limit);
        }

        const querySnapshot = await query.get();

        const data = sortBundles(
          querySnapshot.docs.map((doc) =>
            convertToBundle(doc.data() as SnakeCaseBundle),
          ),
          orderBy,
        );

        return {
          data,
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
                rollout_cohort_count:
                  data.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
                target_cohorts: data.targetCohorts ?? null,
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
                  rollout_cohort_count:
                    data.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
                  target_cohorts: data.targetCohorts ?? null,
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
      },
    };
  },
});
