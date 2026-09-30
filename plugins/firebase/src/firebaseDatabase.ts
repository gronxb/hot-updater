import {
  type EngineDatabase,
  withAdapterResource,
} from "@hot-updater/plugin-core";
import {
  createEngineDatabase,
  createKvAdapter,
  migrateCoreSchema,
  type PluginTables,
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
  /**
   * Firestore bills each document write, so Insights' aggregates are
   * batched: through log rows a compaction merges (the default), or
   * `{ mode: "memory" }` on a long-lived server. `false` commits them with
   * each event.
   */
  readonly aggregateBatching?: EngineDatabase["aggregateBatching"] | false;
};

const adapterOf = ({
  collection = FIREBASE_V1_COLLECTION,
  aggregateBatching: _,
  ...appOptions
}: FirebaseDatabaseConfig) => {
  const app = getApps().length ? getApp() : initializeApp(appOptions);
  return createKvAdapter({
    store: createFirestoreStore({ firestore: getFirestore(app), collection }),
  });
};

/**
 * Writes the schema settings of core and `plugins`, the plugins the server
 * runs, which the database checks before its first read. Firestore needs no
 * other setup beyond `firestore.indexes.json`; `hot-updater init` runs it
 * after deploying the indexes.
 */
export const migrateFirebaseDatabase = (
  config: FirebaseDatabaseConfig,
  plugins: readonly PluginTables[] = [],
) => migrateCoreSchema(adapterOf(config), "firebaseDatabase", plugins);

/** Hot Updater's database in one Firestore collection, through the storage engine. */
export const firebaseDatabase = (
  config: FirebaseDatabaseConfig,
): EngineDatabase =>
  withAdapterResource(
    createEngineDatabase({
      name: "firebaseDatabase",
      adapter: adapterOf(config),
      aggregateBatching: config.aggregateBatching ?? {},
    }),
    { projectId: config.projectId },
  );
