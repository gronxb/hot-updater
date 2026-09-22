import { compareInsightsText } from "@hot-updater/plugin-core";
import {
  latestInsightsWhere,
  latestInsightsCountGroups,
} from "@hot-updater/plugin-core/internal";
import {
  createDatabasePluginAdapter,
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
  parseFirebaseChannelRow,
} from "./firebaseDatabaseParser";
import {
  createFirebaseDatabaseCollections,
  firebaseChannelDocumentId,
  firebaseChannelIdDocumentId,
  firebaseInstallationDocumentId,
  migrateFirebaseDatabase,
  requireFirebaseDocumentKey,
} from "./firebaseDatabasePersistence";
import { createFirebaseReads } from "./firebaseDatabaseReads";
import { FirebaseDatabaseConstraintError } from "./firebaseDatabaseState";
import { createFirebaseTransaction } from "./firebaseDatabaseTransaction";
import { FIREBASE_V1_COLLECTION_NAMES } from "./firebaseInfrastructureNames";
import {
  getFirebaseAppUsage,
  getFirebaseReleaseActivity,
  recordFirebaseInsightsOverview,
} from "./firebaseInsightsOverview";

type FirebaseMutation<TResult> = (
  database: TransactionDatabasePluginImplementation,
) => Promise<TResult>;

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
        const staged = createFirebaseTransaction(transaction, collections);
        const result = await operation(staged.database);
        staged.persist();
        return result;
      });
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
          await recordFirebaseInsightsOverview({
            transaction,
            collections,
            event,
            current,
          });
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
      getReleaseActivity: async (input) => {
        await ensureMigrated();
        return getFirebaseReleaseActivity(db, collections, input);
      },
      getAppUsage: async (input) => {
        await ensureMigrated();
        return getFirebaseAppUsage(db, collections, input);
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
      ...createFirebaseReads(collections, ensureMigrated),
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
      transaction: (callback) => mutate(callback),
    };
  })();
  return createDatabasePluginAdapter("firebaseDatabase", implementation);
};
