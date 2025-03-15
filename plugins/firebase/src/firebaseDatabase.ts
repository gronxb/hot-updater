import type { DatabasePluginHooks } from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";
import { getApp, getApps, initializeApp } from "firebase/app";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  setDoc,
  startAfter,
  where,
} from "firebase/firestore";

export interface FirebaseDatabaseConfig {
  apiKey: string;
  projectId: string;
}

export const firebaseDatabase = (
  config: FirebaseDatabaseConfig,
  hooks?: DatabasePluginHooks,
) => {
  const appName = "hot-updater";
  const app = getApps().find((app) => app.name === appName)
    ? getApp(appName)
    : initializeApp(config, appName);

  const db = getFirestore(app);
  const bundlesCollection = collection(db, "bundles");

  return createDatabasePlugin(
    "firebaseDatabase",
    {
      async getBundleById(bundleId) {
        const bundleRef = doc(bundlesCollection, bundleId);
        const bundleSnap = await getDoc(bundleRef);

        if (!bundleSnap.exists()) {
          return null;
        }

        const data = bundleSnap.data();
        return {
          enabled: data.enabled,
          shouldForceUpdate: data.should_force_update,
          fileHash: data.file_hash,
          gitCommitHash: data.git_commit_hash,
          id: data.id,
          message: data.message,
          platform: data.platform,
          targetAppVersion: data.target_app_version,
          channel: data.channel,
        };
      },

      async getBundles(options) {
        let q = query(bundlesCollection, orderBy("id", "desc"));

        if (options?.where) {
          if (options.where.channel) {
            q = query(q, where("channel", "==", options.where.channel));
          }
          if (options.where.platform) {
            q = query(q, where("platform", "==", options.where.platform));
          }
        }

        if (options?.limit) {
          q = query(q, limit(options.limit));
        }

        if (options?.offset) {
          q = query(q, startAfter(options.offset));
        }

        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
          return [];
        }

        return querySnapshot.docs.map((doc) => {
          const data = doc.data();
          return {
            enabled: data.enabled,
            shouldForceUpdate: data.should_force_update,
            fileHash: data.file_hash,
            gitCommitHash: data.git_commit_hash,
            id: data.id,
            message: data.message,
            platform: data.platform,
            targetAppVersion: data.target_app_version,
            channel: data.channel,
          };
        });
      },

      async getChannels() {
        const q = query(bundlesCollection, orderBy("channel"));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
          return [];
        }

        const channels = new Set<string>();
        for (const doc of querySnapshot.docs) {
          channels.add(doc.data().channel);
        }

        return Array.from(channels);
      },

      async commitBundle({ changedSets }) {
        for (const { operation, data } of changedSets) {
          if (operation === "insert" || operation === "update") {
            const bundleRef = doc(bundlesCollection, data.id);
            await setDoc(
              bundleRef,
              {
                id: data.id,
                enabled: data.enabled,
                should_force_update: data.shouldForceUpdate,
                file_hash: data.fileHash,
                git_commit_hash: data.gitCommitHash,
                message: data.message,
                platform: data.platform,
                target_app_version: data.targetAppVersion,
                channel: data.channel,
              },
              { merge: true },
            );
          }
        }
      },
    },
    hooks,
  );
};
