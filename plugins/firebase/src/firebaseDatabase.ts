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
    projectId: config.projectId,
    clientEmail: config.clientEmail,
    privateKey: config.privateKey,
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
        } as Bundle;
      },

      async getBundles(options) {
        const { where, limit, offset = 0 } = options ?? {};

        let q = bundlesCollection.orderBy("id", "desc");

        if (where?.channel) {
          q = q.where("channel", "==", where.channel);
        }

        if (where?.platform) {
          q = q.where("platform", "==", where.platform);
        }

        if (limit) {
          q = q.limit(limit);
        }

        if (offset) {
          q = q.startAfter(offset);
        }

        const querySnapshot = await q.get();

        if (querySnapshot.empty) {
          bundles = [];
        } else {
          bundles = querySnapshot.docs.map((doc) => {
            const firestoreData = doc.data() as SnakeCaseBundle;
            return {
              id: firestoreData.id,
              channel: firestoreData.channel,
              enabled: Boolean(firestoreData.enabled),
              shouldForceUpdate: Boolean(firestoreData.should_force_update),
              fileHash: firestoreData.file_hash,
              gitCommitHash: firestoreData.git_commit_hash,
              message: firestoreData.message,
              platform: firestoreData.platform,
              targetAppVersion: firestoreData.target_app_version,
            };
          });
        }

        return bundles;
      },

      async getChannels() {
        const q = bundlesCollection.orderBy("channel");
        const querySnapshot = await q.get();

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

        const batch = db.batch();

        for (const { operation, data } of changedSets) {
          if (operation === "insert" || operation === "update") {
            const bundleRef = bundlesCollection.doc(data.id);
            batch.set(
              bundleRef,
              {
                id: data.id,
                channel: data.channel,
                enabled: data.enabled ? 1 : 0,
                should_force_update: data.shouldForceUpdate ? 1 : 0,
                file_hash: data.fileHash,
                git_commit_hash: data.gitCommitHash || null,
                message: data.message || null,
                platform: data.platform,
                target_app_version: data.targetAppVersion,
              },
              { merge: true },
            );
          }
        }

        await batch.commit();
      },
    },
    hooks,
  );
};
