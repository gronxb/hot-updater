import type { SnakeCaseBundle } from "@hot-updater/core";
import type { Bundle, DatabasePluginHooks } from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";
import * as admin from "firebase-admin";

export interface FirebaseDatabaseConfig {
  projectId: string;
  privateKey: string;
  clientEmail: string;
}

export const firebaseDatabase = (
  config: FirebaseDatabaseConfig,
  hooks?: DatabasePluginHooks,
) => {
  const firebaseConfig = {
    project_id: config.projectId,
    private_key: config.privateKey,
    client_email: config.clientEmail,
  };

  let app: admin.app.App;
  try {
    app = admin.app();
  } catch (e) {
    app = admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig as admin.ServiceAccount),
    });
  }

  const db = admin.firestore(app);
  const bundlesCollection = db.collection("bundles");

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
  });

  let bundles: Bundle[] = [];

  return createDatabasePlugin(
    "firebaseDatabase",
    {
      async getBundleById(bundleId: string) {
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
        const { where, limit, offset = 0 } = options ?? {};

        let query: admin.firestore.Query<FirestoreData> = bundlesCollection;

        if (where?.channel) {
          query = query.where("channel", "==", where.channel);
        }

        if (where?.platform) {
          query = query.where("platform", "==", where.platform);
        }

        query = query.orderBy("id", "desc");

        if (offset) {
          query = query.offset(offset);
        }

        if (limit) {
          query = query.limit(limit);
        }

        const querySnapshot = await query.get();

        if (querySnapshot.empty) {
          bundles = [];
          return bundles;
        }

        bundles = querySnapshot.docs.map((doc) =>
          convertToBundle(doc.data() as SnakeCaseBundle),
        );

        return bundles;
      },

      async getChannels() {
        const query: admin.firestore.Query<FirestoreData> =
          bundlesCollection.orderBy("channel");
        const querySnapshot = await query.get();

        if (querySnapshot.empty) {
          return [];
        }

        const channels = new Set<string>();
        for (const doc of querySnapshot.docs) {
          channels.add((doc.data() as SnakeCaseBundle).channel);
        }

        return Array.from(channels);
      },

      async commitBundle({ changedSets }) {
        if (changedSets.length === 0) {
          return;
        }

        await db.runTransaction(async (transaction) => {
          for (const { operation, data } of changedSets) {
            const bundleRef = bundlesCollection.doc(data.id);

            if (operation === "insert" || operation === "update") {
              if (data.targetAppVersion) {
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
                    target_app_version: data.targetAppVersion,
                  },
                  { merge: true },
                );

                const versionDocId = `${data.platform}_${data.targetAppVersion}`;
                const targetAppVersionsRef = db
                  .collection("target_app_versions")
                  .doc(versionDocId);
                transaction.set(
                  targetAppVersionsRef,
                  {
                    platform: data.platform,
                    target_app_version: data.targetAppVersion,
                  },
                  { merge: true },
                );
              } else {
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
                    target_app_version: admin.firestore.FieldValue.delete(),
                  },
                  { merge: true },
                );
              }
            }
          }

          const targetVersionsSnapshot = await transaction.get(
            db.collection("target_app_versions"),
          );

          for (const targetDoc of targetVersionsSnapshot.docs) {
            const { platform, target_app_version } = targetDoc.data();
            const query = bundlesCollection
              .where("platform", "==", platform)
              .where("target_app_version", "==", target_app_version);
            const querySnapshot = await transaction.get(query);
            if (querySnapshot.empty) {
              transaction.delete(targetDoc.ref);
            }
          }
        });
      },
    },
    hooks,
  );
};
