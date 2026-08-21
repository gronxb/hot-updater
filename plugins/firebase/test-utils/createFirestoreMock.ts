import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export function createFirestoreMock(projectId: string) {
  const app = getApps()[0] ?? initializeApp({ projectId });
  const firestore = getFirestore(app);
  const bundlesCollection = firestore.collection("bundles");
  const bundlePatchesCollection = firestore.collection("bundle_patches");
  const bundleEventsCollection = firestore.collection("bundle_events");
  const channelsCollection = firestore.collection("channels");
  const apiKeysCollection = firestore.collection("api_keys");
  const releasesCollection = firestore.collection("releases");
  const releaseCatalogsCollection = firestore.collection("release_catalogs");
  const settingsCollection = firestore.collection(
    "private_hot_updater_settings",
  );

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
    clearCollections,
  };
}
