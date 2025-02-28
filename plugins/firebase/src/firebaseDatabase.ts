import type {
  BasePluginArgs,
  Bundle,
  DatabasePlugin,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";

import { getApp, getApps, initializeApp } from "firebase/app";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  orderBy,
  query,
  setDoc,
} from "firebase/firestore";

export interface FirebaseDatabaseConfig {
  apiKey: string;
  projectId: string;
  authDomain?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  appName?: string;
}

export const firebaseDatabase =
  (config: FirebaseDatabaseConfig, hooks?: DatabasePluginHooks) =>
  (_: BasePluginArgs): DatabasePlugin => {
    const appName = config.appName || "hot-updater-firebase";

    const app = getApps().find((app) => app.name === appName)
      ? getApp(appName)
      : initializeApp(config, appName);

    const db = getFirestore(app);
    const bundlesCollection = collection(db, "bundles");

    let bundles: Bundle[] = [];

    const changedIds = new Set<string>();
    function markChanged(id: string) {
      changedIds.add(id);
    }

    return {
      name: "firebaseDatabase",
      async commitBundle() {
        if (changedIds.size === 0) {
          return;
        }
        const changedBundles = bundles.filter((b) => changedIds.has(b.id));
        if (changedBundles.length === 0) {
          return;
        }

        for (const bundle of changedBundles) {
          const bundleRef = doc(bundlesCollection, bundle.id);
          await setDoc(
            bundleRef,
            {
              id: bundle.id,
              enabled: bundle.enabled,
              file_url: bundle.fileUrl,
              should_force_update: bundle.shouldForceUpdate,
              file_hash: bundle.fileHash,
              git_commit_hash: bundle.gitCommitHash,
              message: bundle.message,
              platform: bundle.platform,
              target_app_version: bundle.targetAppVersion,
            },
            { merge: true },
          );
        }

        changedIds.clear();
        hooks?.onDatabaseUpdated?.();
      },
      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        const bundles = await this.getBundles();

        if (!bundles || bundles.length === 0) {
          throw new Error("target bundle version not found");
        }

        const targetIndex = bundles.findIndex((u) => u.id === targetBundleId);
        if (targetIndex === -1) {
          throw new Error("target bundle version not found");
        }
        Object.assign(bundles[targetIndex], newBundle);
        markChanged(targetBundleId);
      },
      async appendBundle(inputBundle) {
        bundles = await this.getBundles();
        bundles.unshift(inputBundle);
        markChanged(inputBundle.id);
      },
      async getBundleById(bundleId) {
        const bundleRef = doc(bundlesCollection, bundleId);
        const bundleSnap = await getDoc(bundleRef);

        if (!bundleSnap.exists()) {
          return null;
        }

        const data = bundleSnap.data();
        return {
          enabled: data.enabled,
          fileUrl: data.file_url,
          shouldForceUpdate: data.should_force_update,
          fileHash: data.file_hash,
          gitCommitHash: data.git_commit_hash,
          id: data.id,
          message: data.message,
          platform: data.platform,
          targetAppVersion: data.target_app_version,
        };
      },
      async getBundles(refresh = false) {
        if (bundles.length > 0 && !refresh) {
          return bundles;
        }

        const q = query(bundlesCollection, orderBy("id", "desc"));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
          return [];
        }

        bundles = querySnapshot.docs.map((doc) => {
          const data = doc.data();
          return {
            enabled: data.enabled,
            fileUrl: data.file_url,
            shouldForceUpdate: data.should_force_update,
            fileHash: data.file_hash,
            gitCommitHash: data.git_commit_hash,
            id: data.id,
            message: data.message,
            platform: data.platform,
            targetAppVersion: data.target_app_version,
          };
        });

        return bundles;
      },
    };
  };
