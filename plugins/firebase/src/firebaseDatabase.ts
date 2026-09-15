import {
  compareInsightsText,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import {
  latestInsightsWhere,
  latestInsightsCountGroups,
} from "@hot-updater/plugin-core/internal";
import {
  createDatabasePluginAdapter,
  createTransactionDatabasePlugin,
  publishBundlePatchInTransaction,
  type DatabasePluginImplementation,
  type TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";
import {
  getApp,
  getApps,
  initializeApp,
  type AppOptions,
} from "firebase-admin/app";
import {
  getFirestore,
  Filter,
  type DocumentData,
  type Query,
  type WhereFilterOp,
} from "firebase-admin/firestore";

import {
  parseFirebaseBundleEventRow,
  parseFirebaseBundleRow,
  parseFirebaseChannelRow,
  parseFirebaseApiKeyRow,
  parseFirebasePatchRow,
} from "./firebaseDatabaseParser";
import {
  createFirebaseDatabaseCollections,
  firebaseChannelDocumentId,
  firebaseChannelIdDocumentId,
  firebaseInstallationDocumentId,
  loadFirebaseChannels,
  loadFirebaseDatabaseSnapshot,
  loadFirebaseTransactionSnapshot,
  migrateFirebaseDatabase,
  persistFirebaseDatabaseSnapshot,
  requireFirebaseDocumentKey,
} from "./firebaseDatabasePersistence";
import { queryFirebaseDatabaseRows } from "./firebaseDatabaseQuery";
import {
  cloneFirebaseDatabaseSnapshot,
  createFirebaseDatabaseState,
  FirebaseDatabaseConstraintError,
} from "./firebaseDatabaseState";
import { FIREBASE_V1_COLLECTION_NAMES } from "./firebaseInfrastructureNames";

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

const firestoreOperator = (
  operator: string | undefined,
): WhereFilterOp | undefined => {
  switch (operator ?? "eq") {
    case "eq":
      return "==";
    case "ne":
      return "!=";
    case "gt":
      return ">";
    case "gte":
      return ">=";
    case "lt":
      return "<";
    case "lte":
      return "<=";
    case "in":
      return "in";
    case "not_in":
      return "not-in";
    default:
      return undefined;
  }
};

const applyFirebaseWhere = (
  initial: Query<DocumentData>,
  where: readonly {
    readonly connector?: "AND" | "OR";
    readonly field: string;
    readonly operator?: string;
    readonly value: unknown;
  }[],
): Query<DocumentData> => {
  let query = initial;
  for (const condition of where) {
    const operator = firestoreOperator(condition.operator);
    if (condition.connector === "OR" || operator === undefined) {
      throw new FirebaseDatabaseConstraintError("query.unsupported");
    }
    query = query.where(condition.field, operator, condition.value);
  }
  return query;
};

export type FirebaseDatabaseConfig = AppOptions;

export const firebaseDatabase = (config: FirebaseDatabaseConfig) => {
  const implementation: DatabasePluginImplementation = (() => {
    const app = getApps().length ? getApp() : initializeApp(config);
    const db = getFirestore(app);
    const collections = createFirebaseDatabaseCollections(db);
    let migration: Promise<void> | undefined;

    const ensureMigrated = (): Promise<void> => {
      migration ??= migrateFirebaseDatabase(collections).catch((error) => {
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
      recordInsights: async ({ event }) => {
        await ensureMigrated();
        await db.runTransaction(async (transaction) => {
          const eventReference = collections.bundleEvents.doc(event.id);
          const installationReference = collections.insightsLatest.doc(
            firebaseInstallationDocumentId(event.install_id),
          );
          const [storedEvent, storedInstallation] = await transaction.getAll(
            eventReference,
            installationReference,
          );
          if (storedEvent.exists) return;
          const current = storedInstallation.exists
            ? requireFirebaseDocumentKey(
                "insights_latest",
                storedInstallation.id,
                parseFirebaseBundleEventRow(
                  storedInstallation.data(),
                  `insights_latest/${storedInstallation.id}`,
                ),
              )
            : null;
          transaction.create(eventReference, event);
          if (
            current === null ||
            event.received_at_ms > current.received_at_ms ||
            (event.received_at_ms === current.received_at_ms &&
              compareInsightsText(event.id, current.id) > 0)
          ) {
            transaction.set(installationReference, event);
          }
        });
      },
      findLatestInsightsEvents: async (input) => {
        await ensureMigrated();
        if ("installId" in input) {
          const document = await collections.insightsLatest
            .doc(firebaseInstallationDocumentId(input.installId))
            .get();
          return document.exists
            ? [
                requireFirebaseDocumentKey(
                  "insights_latest",
                  document.id,
                  parseFirebaseBundleEventRow(
                    document.data(),
                    `insights_latest/${document.id}`,
                  ),
                ),
              ]
            : [];
        }
        const snapshot = await applyFirebaseWhere(
          collections.insightsLatest,
          latestInsightsWhere(input),
        )
          .orderBy("install_id", "asc")
          .limit(input.limit)
          .get();
        return snapshot.docs.map((document) =>
          requireFirebaseDocumentKey(
            "insights_latest",
            document.id,
            parseFirebaseBundleEventRow(
              document.data(),
              `insights_latest/${document.id}`,
            ),
          ),
        );
      },
      countLatestInsightsEvents: async (input) => {
        await ensureMigrated();
        const filter = Filter.or(
          ...latestInsightsCountGroups(input).map((where) =>
            Filter.and(
              ...where.map((condition) => {
                const operator = firestoreOperator(condition.operator);
                if (operator === undefined)
                  throw new FirebaseDatabaseConstraintError(
                    "query.unsupported",
                  );
                return Filter.where(condition.field, operator, condition.value);
              }),
            ),
          ),
        );
        const result = await collections.insightsLatest
          .where(filter)
          .count()
          .get();
        return result.data().count;
      },
      create: async (input) => {
        if (input.model !== "bundle_events")
          return mutate((database) => database.create(input));
        await ensureMigrated();
        await collections.bundleEvents.doc(input.data.id).create(input.data);
        return input.data;
      },
      update: (input) => mutate((database) => database.update(input)),
      delete: (input) => mutate((database) => database.delete(input)),
      count: async (input) => {
        if (input.model !== "bundle_events")
          return read((database) => database.count(input));
        await ensureMigrated();
        const result = await applyFirebaseWhere(
          collections.bundleEvents,
          input.where ?? [],
        )
          .orderBy("received_at_ms", "desc")
          .orderBy("id", "desc")
          .count()
          .get();
        return result.data().count;
      },
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
          case "api_keys": {
            const document = await collections.apiKeys.doc(id).get();
            return document.exists
              ? requireFirebaseDocumentKey(
                  "api_keys",
                  document.id,
                  parseFirebaseApiKeyRow(
                    document.data(),
                    `api_keys/${document.id}`,
                  ),
                )
              : null;
          }
          default:
            return read((database) => database.findOne(input));
        }
      },
      findMany: async (input) => {
        if (input.model === "bundle_events") {
          await ensureMigrated();
          let query = applyFirebaseWhere(
            collections.bundleEvents,
            input.where ?? [],
          );
          for (const order of input.orderBy ?? []) {
            if (order.nulls !== undefined)
              throw new FirebaseDatabaseConstraintError("query.unsupported");
            query = query.orderBy(order.field, order.direction);
          }
          const snapshot = await query
            .offset(input.offset)
            .limit(input.limit)
            .get();
          return snapshot.docs.map((document) =>
            requireFirebaseDocumentKey(
              "bundle_events",
              document.id,
              parseFirebaseBundleEventRow(
                document.data(),
                `bundle_events/${document.id}`,
              ),
            ),
          );
        }
        if (input.model === "channels") {
          await ensureMigrated();
          return queryFirebaseDatabaseRows(
            await loadFirebaseChannels(collections),
            input,
          );
        }
        return read((database) => database.findMany(input));
      },
      insertChannel: async (input) => {
        await ensureMigrated();
        return db.runTransaction(async (transaction) => {
          const reference = collections.channels.doc(
            firebaseChannelDocumentId(input.row.name),
          );
          const idReference = collections.settings.doc(
            firebaseChannelIdDocumentId(input.row.id),
          );
          const [document, idDocument] = await transaction.getAll(
            reference,
            idReference,
          );
          if (idDocument.exists) {
            const row = parseFirebaseChannelRow(
              idDocument.data(),
              `${FIREBASE_V1_COLLECTION_NAMES.settings}/${idDocument.id}`,
            );
            if (row.id !== input.row.id || row.name !== input.row.name) {
              throw new FirebaseDatabaseConstraintError("channels.id.registry");
            }
          }
          if (idDocument.exists && !document.exists) {
            throw new FirebaseDatabaseConstraintError("channels.id.unique");
          }
          if (document.exists) {
            const row = parseFirebaseChannelRow(
              document.data(),
              `channels/${document.id}`,
            );
            if (document.id !== firebaseChannelDocumentId(row.name)) {
              throw new FirebaseDatabaseConstraintError(
                "channels.name.document-key",
              );
            }
            return {
              row,
              inserted: false,
            };
          }
          transaction.create(reference, input.row);
          transaction.create(idReference, input.row);
          return { row: input.row, inserted: true };
        });
      },
      deleteChannel: async ({ id }) => {
        await ensureMigrated();
        return db.runTransaction(async (transaction) => {
          const idReference = collections.settings.doc(
            firebaseChannelIdDocumentId(id),
          );
          const idDocument = await transaction.get(idReference);
          if (!idDocument.exists) {
            return { deleted: false, reason: "not_found" };
          }
          const row = parseFirebaseChannelRow(
            idDocument.data(),
            `${FIREBASE_V1_COLLECTION_NAMES.settings}/${idDocument.id}`,
          );
          const reference = collections.channels.doc(
            firebaseChannelDocumentId(row.name),
          );
          const document = await transaction.get(reference);
          if (!document.exists || row.id !== id) {
            throw new FirebaseDatabaseConstraintError("channels.id.registry");
          }
          const referencedReleases = await transaction.get(
            collections.releases.where("channel_id", "==", id).limit(1),
          );
          if (!referencedReleases.empty) {
            return { deleted: false, reason: "not_empty" };
          }
          transaction.delete(reference);
          transaction.delete(idReference);
          return { deleted: true };
        });
      },
      publishBundlePatch: (input) =>
        mutate((transaction) =>
          publishBundlePatchInTransaction(
            createTransactionDatabasePlugin(transaction),
            input,
          ),
        ),
      transaction: (callback) => mutate(callback),
    };
  })();
  const adapter = createDatabasePluginAdapter(
    "firebaseDatabase",
    implementation,
  );
  return createDatabasePlugin({
    name: "firebaseDatabase",
    models: adapter.models,
    commit: adapter.commit,
  });
};
