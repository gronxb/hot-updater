import admin from "firebase-admin";

export function createFirestoreMock(projectId: string) {
  if (!admin.apps.length) {
    admin.initializeApp({
      projectId,
    });
  }

  const firestore = admin.firestore();
  const bundlesCollection = firestore.collection("bundles");
  const bundlePatchesCollection = firestore.collection("bundle_patches");
  const bundleEventsCollection = firestore.collection("bundle_events");
  const settingsCollection = firestore.collection(
    "private_hot_updater_settings",
  );

  async function clearCollections() {
    const collections = [
      bundlesCollection,
      bundlePatchesCollection,
      bundleEventsCollection,
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
    settingsCollection,
    clearCollections,
  };
}
