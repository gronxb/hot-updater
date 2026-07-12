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
  const channelsCollection = firestore.collection("channels");

  async function clearCollections() {
    const collections = [
      bundlesCollection,
      bundlePatchesCollection,
      channelsCollection,
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
    channelsCollection,
    clearCollections,
  };
}
