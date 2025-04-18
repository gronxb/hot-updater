import * as admin from "firebase-admin";

export function createFirestoreMock(projectId: string) {
  if (!admin.apps.length) {
    admin.initializeApp({
      projectId,
    });
  }

  const firestore = admin.firestore();
  const bundlesCollection = firestore.collection("bundles");
  const targetAppVersionsCollection = firestore.collection(
    "target_app_versions",
  );

  async function clearCollections() {
    const collections = [bundlesCollection, targetAppVersionsCollection];
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
    targetAppVersionsCollection,
    clearCollections,
  };
}
