import { SETTINGS_TABLE } from "@hot-updater/server/database";
import { getApps, initializeApp } from "firebase-admin/app";
import {
  getFirestore,
  type CollectionReference,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";

import { FIREBASE_V1_COLLECTION } from "../src/firebaseInfrastructureNames";

/** The Firestore emulator the integration project starts, and helpers to empty its collections. */
export function createFirestoreTestDatabase(projectId: string) {
  const app = getApps()[0] ?? initializeApp({ projectId });
  const firestore = getFirestore(app);
  const collection = firestore.collection(FIREBASE_V1_COLLECTION);
  const settings = SETTINGS_TABLE.name;

  const clear = async (
    target: CollectionReference,
    keep: (document: QueryDocumentSnapshot) => boolean = () => false,
  ) => {
    const doomed = (await target.get()).docs.filter(
      (document) => !keep(document),
    );
    for (let at = 0; at < doomed.length; at += 400) {
      const batch = firestore.batch();
      for (const document of doomed.slice(at, at + 400)) {
        batch.delete(document.ref);
      }
      await batch.commit();
    }
  };

  return {
    firestore,
    collection,
    /** Every item but the schema settings, which the plugin checks first. */
    clearData: () =>
      clear(collection, (document) => document.get("pk") === settings),
    clearCollection: (name: string) => clear(firestore.collection(name)),
  };
}
