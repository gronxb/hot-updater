import {
  createDatabaseAdapter,
  type DatabaseAdapterImplementation,
  resolveUpdateInfoFromBundles,
  type TransactionDatabaseAdapterImplementation,
} from "@hot-updater/plugin-core";
import admin from "firebase-admin";

import {
  parseFirebaseBundleRow,
  parseFirebaseChannelRow,
} from "./firebaseDatabaseParser";
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
import { loadFirebaseUpdateBundles } from "./firebaseDatabaseUpdateInfo";

type FirebaseMutation<TResult> = (
  database: TransactionDatabaseAdapterImplementation,
) => Promise<TResult>;

const exactId = (
  input: Parameters<DatabaseAdapterImplementation["findOne"]>[0],
): string | undefined => {
  if (input.where?.length !== 1) return undefined;
  const [condition] = input.where;
  return condition.field === "id" &&
    (condition.operator === undefined || condition.operator === "eq") &&
    typeof condition.value === "string"
    ? condition.value
    : undefined;
};

export const firebaseDatabase = (config: admin.AppOptions) =>
  createDatabaseAdapter({
    name: "firebaseDatabase",
    adapter: (): DatabaseAdapterImplementation => {
      const existingApp = admin.apps.find((app) => app !== null);
      const app = existingApp ?? admin.initializeApp(config);
      const db = admin.firestore(app);
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
        findOne: async (input) => {
          const id = exactId(input);
          if (id === undefined) {
            return read((database) => database.findOne(input));
          }
          await ensureMigrated();
          if (input.model === "bundles") {
            const document = await collections.bundles.doc(id).get();
            return document.exists
              ? parseFirebaseBundleRow(
                  document.data(),
                  `bundles/${document.id}`,
                )
              : null;
          }
          const document = await collections.channels.doc(id).get();
          return document.exists
            ? parseFirebaseChannelRow(document.data(), document.id)
            : null;
        },
        findMany: (input) => read((database) => database.findMany(input)),
        getUpdateInfo: async (args, context) => {
          await ensureMigrated();
          return resolveUpdateInfoFromBundles({
            args,
            bundles: await loadFirebaseUpdateBundles(collections, args),
            context,
          });
        },
        transaction: (callback) => mutate(callback),
      };
    },
  });
