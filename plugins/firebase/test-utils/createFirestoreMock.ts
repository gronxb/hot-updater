import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import {
  FIREBASE_V1_COLLECTION_NAMES,
  FIREBASE_V2_INSIGHTS_COLLECTION_NAMES,
} from "../src/firebaseInfrastructureNames";

export function createFirestoreMock(projectId: string) {
  const app = getApps()[0] ?? initializeApp({ projectId });
  const firestore = getFirestore(app);
  const bundlesCollection = firestore.collection(
    FIREBASE_V1_COLLECTION_NAMES.bundles,
  );
  const bundlePatchesCollection = firestore.collection(
    FIREBASE_V1_COLLECTION_NAMES.bundlePatches,
  );
  const bundleEventsCollection = firestore.collection(
    FIREBASE_V1_COLLECTION_NAMES.bundleEvents,
  );
  const channelsCollection = firestore.collection(
    FIREBASE_V1_COLLECTION_NAMES.channels,
  );
  const apiKeysCollection = firestore.collection(
    FIREBASE_V1_COLLECTION_NAMES.apiKeys,
  );
  const releasesCollection = firestore.collection(
    FIREBASE_V1_COLLECTION_NAMES.releases,
  );
  const releaseCatalogsCollection = firestore.collection(
    FIREBASE_V1_COLLECTION_NAMES.releaseCatalogs,
  );
  const settingsCollection = firestore.collection(
    FIREBASE_V1_COLLECTION_NAMES.settings,
  );
  const legacyBundlesCollection = firestore.collection("bundles");
  const legacySettingsCollection = firestore.collection(
    "private_hot_updater_settings",
  );
  const insightsV2 = Object.fromEntries(
    Object.entries(FIREBASE_V2_INSIGHTS_COLLECTION_NAMES).map(([key, name]) => [
      key,
      firestore.collection(name),
    ]),
  ) as Record<
    keyof typeof FIREBASE_V2_INSIGHTS_COLLECTION_NAMES,
    ReturnType<typeof firestore.collection>
  >;

  async function clearCollections() {
    const collections = [
      bundlesCollection,
      bundlePatchesCollection,
      bundleEventsCollection,
      channelsCollection,
      apiKeysCollection,
      releasesCollection,
      releaseCatalogsCollection,
      settingsCollection,
      legacyBundlesCollection,
      legacySettingsCollection,
      ...Object.values(insightsV2),
    ];
    for (const coll of collections) {
      const snapshot = await coll.get();
      const batch = firestore.batch();
      for (const doc of snapshot.docs) {
        batch.delete(doc.ref);
      }
      await batch.commit();
    }
  }

  return {
    firestore,
    bundlesCollection,
    bundlePatchesCollection,
    bundleEventsCollection,
    channelsCollection,
    apiKeysCollection,
    releasesCollection,
    releaseCatalogsCollection,
    settingsCollection,
    legacyBundlesCollection,
    legacySettingsCollection,
    insightsV2,
    clearCollections,
  };
}
