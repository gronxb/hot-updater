import {
  createDatabasePlugin,
  type DatabasePluginImplementation,
  resolveUpdateInfoFromBundles,
  rowsToBundles,
  type TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core";
import admin from "firebase-admin";

import {
  createFirebaseDatabaseCollections,
  loadFirebaseDatabaseSnapshot,
  loadFirebaseTransactionSnapshot,
  migrateFirebaseDatabase,
  persistFirebaseDatabaseSnapshot,
} from "./firebaseDatabasePersistence";
import {
  cloneFirebaseDatabaseSnapshot,
  createFirebaseDatabaseState,
} from "./firebaseDatabaseState";

type FirebaseMutation<TResult> = (
  database: TransactionDatabasePluginImplementation,
) => Promise<TResult>;

export const firebaseDatabase = createDatabasePlugin<admin.AppOptions>({
  name: "firebaseDatabase",
  factory: (config): DatabasePluginImplementation => {
    const existingApp = admin.apps.find((app) => app !== null);
    const app = existingApp ?? admin.initializeApp(config);
    const db = admin.firestore(app);
    const collections = createFirebaseDatabaseCollections(db);
    let migration: Promise<void> | undefined;

    const ensureMigrated = (): Promise<void> => {
      migration ??= migrateFirebaseDatabase(db, collections);
      return migration;
    };

    const mutate = async <TResult>(
      operation: FirebaseMutation<TResult>,
    ): Promise<TResult> => {
      await ensureMigrated();
      return db.runTransaction(async (transaction) => {
        const before = await loadFirebaseTransactionSnapshot(
          transaction,
          collections,
        );
        const after = cloneFirebaseDatabaseSnapshot(before);
        const result = await operation(createFirebaseDatabaseState(after));
        persistFirebaseDatabaseSnapshot({
          transaction,
          collections,
          before,
          after,
        });
        return result;
      });
    };

    const read = async <TResult>(
      operation: FirebaseMutation<TResult>,
    ): Promise<TResult> => {
      await ensureMigrated();
      const snapshot = await loadFirebaseDatabaseSnapshot(collections);
      return operation(createFirebaseDatabaseState(snapshot));
    };

    return {
      create: (input) => mutate((database) => database.create(input)),
      update: (input) => mutate((database) => database.update(input)),
      delete: (input) => mutate((database) => database.delete(input)),
      count: (input) => read((database) => database.count(input)),
      findOne: (input) => read((database) => database.findOne(input)),
      findMany: (input) => read((database) => database.findMany(input)),
      getUpdateInfo: async (args, context) => {
        await ensureMigrated();
        const snapshot = await loadFirebaseDatabaseSnapshot(collections);
        return resolveUpdateInfoFromBundles({
          args,
          bundles: rowsToBundles(
            [...snapshot.bundles.values()],
            [...snapshot.bundlePatches.values()],
            [...snapshot.bundles.values()],
          ),
          context,
        });
      },
      transaction: (callback) => mutate(callback),
    };
  },
});
