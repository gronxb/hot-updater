import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export function createFirestoreMock(projectId: string) {
  const app = getApps()[0] ?? initializeApp({ projectId });
  const firestore = getFirestore(app);
  const bundlesCollection = firestore.collection("bundles");
  const targetAppVersionsCollection = firestore.collection(
    "target_app_versions",
  );
  const channelsCollection = firestore.collection("channels");

  async function clearCollections() {
    const collections = [
      bundlesCollection,
      targetAppVersionsCollection,
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
    targetAppVersionsCollection,
    channelsCollection,
    clearCollections,
  };
}
