import type { EngineDatabase } from "@hot-updater/plugin-core";
import {
  createEngineDatabase,
  createKvAdapter,
  migrateBuiltInSchema,
} from "@hot-updater/server/database";
import {
  getApp,
  getApps,
  initializeApp,
  type AppOptions,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { FIREBASE_V1_COLLECTION } from "./firebaseInfrastructureNames";
import { createFirestoreStore } from "./firestoreStore";

export type FirebaseDatabaseConfig = AppOptions & {
  /** The one collection the database keeps its items in. */
  readonly collection?: string;
};

const adapterOf = ({
  collection = FIREBASE_V1_COLLECTION,
  ...appOptions
}: FirebaseDatabaseConfig) => {
  const app = getApps().length ? getApp() : initializeApp(appOptions);
  return createKvAdapter({
    store: createFirestoreStore({ firestore: getFirestore(app), collection }),
  });
};

/**
 * Writes the schema settings the database checks before its first read.
 * Firestore needs no other setup beyond `firestore.indexes.json`;
 * `hot-updater init` runs it after deploying the indexes.
 */
export const migrateFirebaseDatabase = (config: FirebaseDatabaseConfig) =>
  migrateBuiltInSchema(adapterOf(config), "firebaseDatabase");

/** Hot Updater's database in one Firestore collection, through the storage engine. */
export const firebaseDatabase = (
  config: FirebaseDatabaseConfig,
): EngineDatabase =>
  createEngineDatabase({
    name: "firebaseDatabase",
    adapter: adapterOf(config),
  });
