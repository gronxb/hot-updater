import type { EngineDatabase } from "@hot-updater/plugin-core";
import {
  createEngineDatabase,
  createKvAdapter,
  migrateCoreSchema,
  type PluginTables,
} from "@hot-updater/plugin-core";
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
  /**
   * The Firestore database the collection lives in, for a project with
   * named databases. Defaults to the project's `(default)` database.
   */
  readonly databaseId?: string;
  /** The one collection the database keeps its items in. */
  readonly collection?: string;
  /**
   * Firestore bills each document write, so Insights' aggregates are
   * batched: through log rows a compaction merges (the default). `false` commits
   * them with each event.
   */
  readonly aggregateBatching?: EngineDatabase["aggregateBatching"] | false;
};

const adapterOf = ({
  databaseId,
  collection = FIREBASE_V1_COLLECTION,
  aggregateBatching: _,
  ...appOptions
}: FirebaseDatabaseConfig) => {
  const app = getApps().length ? getApp() : initializeApp(appOptions);
  const firestore = databaseId
    ? getFirestore(app, databaseId)
    : getFirestore(app);
  return createKvAdapter({
    store: createFirestoreStore({ firestore, collection }),
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

/**
 * The resource this database reaches, without credentials, under the key
 * `hot-updater doctor` reads to tell the database `hot-updater init` saved
 * from another (a convention CLAUDE.md documents).
 */
const DATABASE_TARGET = Symbol.for("@hot-updater/database-target");

/** Hot Updater's database in one Firestore collection, through the storage engine. */
export const firebaseDatabase = (
  config: FirebaseDatabaseConfig,
): EngineDatabase => ({
  ...createEngineDatabase({
    name: "firebaseDatabase",
    adapter: adapterOf(config),
    aggregateBatching: config.aggregateBatching ?? {},
  }),
  ...(config.projectId === undefined
    ? {}
    : {
        [DATABASE_TARGET]: `firestore/${config.projectId}/${config.databaseId ?? "(default)"}`,
      }),
});
