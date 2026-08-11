import {
  createDatabasePlugin,
  type DatabasePluginImplementation,
  resolveUpdateInfoFromBundles,
  type TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core";
import { createDatabasePluginAdapter } from "@hot-updater/plugin-core/internal";
import {
  getApp,
  getApps,
  initializeApp,
  type AppOptions,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import {
  parseFirebaseBundleRow,
  parseFirebaseClientAccessKeyRow,
  parseFirebasePatchRow,
} from "./firebaseDatabaseParser";
import {
  createFirebaseDatabaseCollections,
  loadFirebaseDatabaseSnapshot,
  loadFirebaseTransactionSnapshot,
  migrateFirebaseDatabase,
  persistFirebaseDatabaseSnapshot,
  requireFirebaseDocumentKey,
} from "./firebaseDatabasePersistence";
import {
  cloneFirebaseDatabaseSnapshot,
  createFirebaseDatabaseState,
} from "./firebaseDatabaseState";
import { loadFirebaseUpdateBundles } from "./firebaseDatabaseUpdateInfo";

type FirebaseMutation<TResult> = (
  database: TransactionDatabasePluginImplementation,
) => Promise<TResult>;

const exactId = (
  input: Parameters<DatabasePluginImplementation["findOne"]>[0],
): string | undefined => {
  if (input.where?.length !== 1) return undefined;
  const [condition] = input.where;
  return condition.field === "id" &&
    (condition.operator === undefined || condition.operator === "eq") &&
    typeof condition.value === "string"
    ? condition.value
    : undefined;
};

export const firebaseDatabase = (config: AppOptions) => {
  const implementation: DatabasePluginImplementation = (() => {
    const app = getApps().length ? getApp() : initializeApp(config);
    const db = getFirestore(app);
    const collections = createFirebaseDatabaseCollections(db);
    let migration: Promise<void> | undefined;

    const ensureMigrated = (): Promise<void> => {
      migration ??= migrateFirebaseDatabase(db, collections).catch((error) => {
        migration = undefined;
        throw error;
      });
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
        const database = createFirebaseDatabaseState(after);
        const result = await operation(database);
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
      findOne: async (input) => {
        const id = exactId(input);
        if (id === undefined) {
          return read((database) => database.findOne(input));
        }
        await ensureMigrated();
        switch (input.model) {
          case "bundles": {
            const document = await collections.bundles.doc(id).get();
            return document.exists
              ? requireFirebaseDocumentKey(
                  "bundles",
                  document.id,
                  parseFirebaseBundleRow(
                    document.data(),
                    `bundles/${document.id}`,
                  ),
                )
              : null;
          }
          case "bundle_patches": {
            const document = await collections.bundlePatches.doc(id).get();
            return document.exists
              ? requireFirebaseDocumentKey(
                  "bundle_patches",
                  document.id,
                  parseFirebasePatchRow(
                    document.data(),
                    `bundle_patches/${document.id}`,
                  ),
                )
              : null;
          }
          case "client_access_keys": {
            const document = await collections.clientAccessKeys.doc(id).get();
            return document.exists
              ? requireFirebaseDocumentKey(
                  "client_access_keys",
                  document.id,
                  parseFirebaseClientAccessKeyRow(
                    document.data(),
                    `client_access_keys/${document.id}`,
                  ),
                )
              : null;
          }
        }
      },
      findMany: (input) => read((database) => database.findMany(input)),
      getChannels: async () => {
        await ensureMigrated();
        const snapshot = await collections.bundles.select("channel").get();
        return [
          ...new Set(
            snapshot.docs.map((document) => String(document.get("channel"))),
          ),
        ].sort();
      },
      getUpdateInfo: async (args) => {
        await ensureMigrated();
        return resolveUpdateInfoFromBundles({
          args,
          bundles: await loadFirebaseUpdateBundles(collections, args),
        });
      },
      transaction: (callback) => mutate(callback),
    };
  })();
  const adapter = createDatabasePluginAdapter(
    "firebaseDatabase",
    implementation,
  );
  return createDatabasePlugin({
    name: "firebaseDatabase",
    bundles: adapter.bundles,
    bundlePatches: adapter.bundlePatches,
    analytics: adapter.analytics,
    clientAccessKeys: adapter.clientAccessKeys,
    commit: adapter.commit,
    getChannels: adapter.getChannels,
    getUpdateInfo: adapter.getUpdateInfo,
  });
};
