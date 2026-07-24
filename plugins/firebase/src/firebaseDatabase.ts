import { withAnalyticsProvider } from "@hot-updater/analytics/provider";
import {
  createDatabasePlugin,
  type DatabasePluginImplementation,
  resolveUpdateInfoFromBundles,
  type TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core";
import admin from "firebase-admin";
import type {
  CollectionReference,
  DocumentData,
  Query,
} from "firebase-admin/firestore";

import { migrateFirebaseDatabase } from "./firebaseDatabaseMigration";
import {
  parseFirebaseBundleEventRow,
  parseFirebaseBundleRow,
  parseFirebasePatchRow,
} from "./firebaseDatabaseParser";
import {
  createFirebaseDatabaseCollections,
  loadFirebaseDatabaseSnapshot,
  loadFirebaseTransactionBundleEvents,
  loadFirebaseTransactionSnapshot,
  persistFirebaseDatabaseSnapshot,
} from "./firebaseDatabasePersistence";
import {
  type FirebaseBundleEventsFindManyInput,
  getFirebaseWhereOperator,
  supportsFirebaseBundleEventQuery,
} from "./firebaseDatabaseQuerySupport";
import {
  cloneFirebaseDatabaseSnapshot,
  createFirebaseDatabaseState,
  createFirebaseTransactionDatabaseState,
} from "./firebaseDatabaseState";
import { loadFirebaseUpdateBundles } from "./firebaseDatabaseUpdateInfo";

type FirebaseMutation<TResult> = (
  database: TransactionDatabasePluginImplementation,
) => Promise<TResult>;

const loadFirebaseBundleEvents = async (
  collection: CollectionReference<DocumentData>,
  input: FirebaseBundleEventsFindManyInput,
) => {
  let query: Query<DocumentData> = collection;
  for (const condition of input.where ?? []) {
    const operator = condition.operator ?? "eq";
    const firestoreOperator = getFirebaseWhereOperator(operator);
    if (firestoreOperator === undefined) throw new Error("Unsupported query");
    query = query.where(condition.field, firestoreOperator, condition.value);
  }
  const orderBy = input.orderBy ?? (input.sortBy ? [input.sortBy] : []);
  for (const clause of orderBy) {
    query = query.orderBy(clause.field, clause.direction);
  }
  const snapshot = await query.offset(input.offset).limit(input.limit).get();
  return snapshot.docs.map((document) =>
    parseFirebaseBundleEventRow(
      document.data(),
      `bundle_events/${document.id}`,
    ),
  );
};

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

export const firebaseDatabase = (config: admin.AppOptions) =>
  withAnalyticsProvider(
    createDatabasePlugin({
      name: "firebaseDatabase",
      plugin: (): DatabasePluginImplementation => {
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
            const database = createFirebaseTransactionDatabaseState(
              after,
              async () => {
                const bundleEvents = await loadFirebaseTransactionBundleEvents(
                  transaction,
                  collections,
                );
                for (const [id, row] of bundleEvents) {
                  before.bundleEvents.set(id, row);
                  after.bundleEvents.set(id, row);
                }
              },
            );
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
          includeBundleEvents = false,
        ): Promise<TResult> => {
          await ensureMigrated();
          const snapshot = await loadFirebaseDatabaseSnapshot(collections, {
            includeBundleEvents,
          });
          return operation(createFirebaseDatabaseState(snapshot));
        };

        return {
          create: async (input) => {
            if (input.model !== "bundle_events") {
              return mutate((database) => database.create(input));
            }
            await ensureMigrated();
            await collections.bundleEvents
              .doc(input.data.id)
              .create(input.data);
            return input.data;
          },
          update: (input) => mutate((database) => database.update(input)),
          delete: (input) => mutate((database) => database.delete(input)),
          count: (input) =>
            read(
              (database) => database.count(input),
              input.model === "bundle_events",
            ),
          findOne: async (input) => {
            const id = exactId(input);
            if (id === undefined) {
              return read(
                (database) => database.findOne(input),
                input.model === "bundle_events",
              );
            }
            await ensureMigrated();
            switch (input.model) {
              case "bundles": {
                const document = await collections.bundles.doc(id).get();
                return document.exists
                  ? parseFirebaseBundleRow(
                      document.data(),
                      `bundles/${document.id}`,
                    )
                  : null;
              }
              case "bundle_patches": {
                const document = await collections.bundlePatches.doc(id).get();
                return document.exists
                  ? parseFirebasePatchRow(
                      document.data(),
                      `bundle_patches/${document.id}`,
                    )
                  : null;
              }
              case "bundle_events": {
                const document = await collections.bundleEvents.doc(id).get();
                return document.exists
                  ? parseFirebaseBundleEventRow(
                      document.data(),
                      `bundle_events/${document.id}`,
                    )
                  : null;
              }
            }
          },
          findMany: async (input) => {
            if (
              input.model !== "bundle_events" ||
              !supportsFirebaseBundleEventQuery(input)
            ) {
              return read(
                (database) => database.findMany(input),
                input.model === "bundle_events",
              );
            }
            await ensureMigrated();
            return loadFirebaseBundleEvents(collections.bundleEvents, input);
          },
          getChannels: async () => {
            await ensureMigrated();
            const snapshot = await collections.bundles.select("channel").get();
            return [
              ...new Set(
                snapshot.docs.map((document) =>
                  String(document.get("channel")),
                ),
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
    }),
  );
