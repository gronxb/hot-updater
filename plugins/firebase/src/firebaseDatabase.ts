import { attachManagedAccessKeyStore } from "@hot-updater/better-auth/managed";
import {
  attachUniversalComponentDataAdapter,
  createDatabasePlugin,
  type DatabasePlugin,
  type DatabasePluginImplementation,
  resolveUpdateInfoFromBundles,
  type TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core";
import {
  getApp,
  getApps,
  initializeApp,
  type AppOptions,
} from "firebase-admin/app";
import {
  getFirestore as getAdminFirestore,
  type Firestore,
} from "firebase-admin/firestore";

import {
  parseFirebaseBundleRow,
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
import { createFirebaseManagedAccessKeyStore } from "./firebaseManagedAccessKeyStore";
import { createFirebaseUniversalComponentDataAdapter } from "./firebaseUniversalComponentData";

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

export function firebaseDatabase(config: AppOptions): DatabasePlugin {
  const getFirestore = (): Firestore => {
    const app = getApps().length ? getApp() : initializeApp(config);
    return getAdminFirestore(app);
  };
  const database = createDatabasePlugin({
    name: "firebaseDatabase",
    plugin: (): DatabasePluginImplementation => {
      const db = getFirestore();
      const collections = createFirebaseDatabaseCollections(db);
      let migration: Promise<void> | undefined;

      const ensureMigrated = (): Promise<void> => {
        migration ??= migrateFirebaseDatabase(db, collections).catch(
          (error) => {
            migration = undefined;
            throw error;
          },
        );
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
    },
  });
  return attachManagedAccessKeyStore(
    attachUniversalComponentDataAdapter(database, () =>
      createFirebaseUniversalComponentDataAdapter(getFirestore()),
    ),
    () => createFirebaseManagedAccessKeyStore(getFirestore()),
  );
}
