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
  const auditRecordsCollection = firestore.collection("audit_records");
  const securityRecordsCollection = firestore.collection("security_records");
  const auditHistoryRecordsCollection = firestore.collection(
    "audit_history_records",
  );
  const settingsCollection = firestore.collection(
    "private_hot_updater_settings",
  );

  async function clearCollections() {
    const collections = [
      bundlesCollection,
      bundlePatchesCollection,
      auditRecordsCollection,
      securityRecordsCollection,
      auditHistoryRecordsCollection,
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
    auditRecordsCollection,
    securityRecordsCollection,
    auditHistoryRecordsCollection,
    settingsCollection,
    clearCollections,
  };
}
