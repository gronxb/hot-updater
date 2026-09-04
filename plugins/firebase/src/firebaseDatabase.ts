import { createDatabasePlugin } from "@hot-updater/plugin-core";
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
  type DocumentData,
  type Query,
  type WhereFilterOp,
} from "firebase-admin/firestore";

import {
  parseFirebaseBundleEventRow,
  parseFirebaseBundleRow,
  parseFirebaseChannelRow,
  parseFirebaseInsightsInstallationRow,
  parseFirebaseApiKeyRow,
  parseFirebasePatchRow,
} from "./firebaseDatabaseParser";
import {
  createFirebaseDatabaseCollections,
  firebaseChannelDocumentId,
  firebaseChannelIdDocumentId,
  loadFirebaseChannels,
  loadFirebaseDatabaseSnapshot,
  loadFirebaseTransactionSnapshot,
  migrateFirebaseDatabase,
  persistFirebaseDatabaseSnapshot,
  requireFirebaseDocumentKey,
} from "./firebaseDatabasePersistence";
import {
  matchesFirebaseDatabaseWhere,
  queryFirebaseDatabaseRows,
} from "./firebaseDatabaseQuery";
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

const exactInstallId = (
  input:
    | Parameters<DatabasePluginImplementation["findOne"]>[0]
    | Parameters<DatabasePluginImplementation["update"]>[0],
): string | undefined => {
  const condition = input.where?.find(
    ({ field, operator }) =>
      field === "install_id" && (operator === undefined || operator === "eq"),
  );
  return typeof condition?.value === "string" ? condition.value : undefined;
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
      create: async (input) => {
        if (
          input.model !== "bundle_events" &&
          input.model !== "bundle_installations"
        ) {
          return mutate((database) => database.create(input));
        }
        await ensureMigrated();
        return db.runTransaction(async (transaction) => {
          const collection =
            input.model === "bundle_events"
              ? collections.bundleEvents
              : collections.bundleInstallations;
          const documentId =
            input.model === "bundle_events"
              ? input.data.id
              : input.data.install_id;
          const reference = collection.doc(documentId);
          const document = await transaction.get(reference);
          if (document.exists) {
            const row =
              input.model === "bundle_events"
                ? requireFirebaseDocumentKey(
                    "bundle_events",
                    document.id,
                    parseFirebaseBundleEventRow(
                      document.data(),
                      `bundle_events/${document.id}`,
                    ),
                  )
                : requireFirebaseDocumentKey(
                    "bundle_installations",
                    document.id,
                    parseFirebaseInsightsInstallationRow(
                      document.data(),
                      `bundle_installations/${document.id}`,
                    ),
                  );
            if (input.onConflict === "ignore") return row;
            throw new FirebaseDatabaseConstraintError(
              `${input.model}.id.unique`,
            );
          }
          transaction.create(reference, input.data);
          return input.data;
        });
      },
      update: async (input) => {
        if (input.model !== "bundle_installations") {
          return mutate((database) => database.update(input));
        }
        const installId = exactInstallId(input);
        if (installId === undefined) {
          return mutate((database) => database.update(input));
        }
        await ensureMigrated();
        return db.runTransaction(async (transaction) => {
          const reference = collections.bundleInstallations.doc(installId);
          const document = await transaction.get(reference);
          if (!document.exists) return null;
          const current = requireFirebaseDocumentKey(
            "bundle_installations",
            document.id,
            parseFirebaseInsightsInstallationRow(
              document.data(),
              `bundle_installations/${document.id}`,
            ),
          );
          if (
            !matchesFirebaseDatabaseWhere<"bundle_installations">(
              current,
              input.where,
            )
          ) {
            return null;
          }
          const updated = { ...current, ...input.update };
          transaction.set(reference, updated, { merge: true });
          return updated;
        });
      },
      delete: (input) => mutate((database) => database.delete(input)),
      count: async (input) => {
        if (input.model !== "bundle_installations") {
          return read((database) => database.count(input));
        }
        await ensureMigrated();
        const query = applyFirebaseWhere(
          collections.bundleInstallations,
          input.where ?? [],
        );
        const result = await query.count().get();
        return result.data().count;
      },
      findOne: async (input) => {
        if (input.model === "bundle_installations") {
          const installId = exactInstallId(input);
          if (installId === undefined) {
            return read((database) => database.findOne(input));
          }
          await ensureMigrated();
          const document = await collections.bundleInstallations
            .doc(installId)
            .get();
          return document.exists
            ? requireFirebaseDocumentKey(
                "bundle_installations",
                document.id,
                parseFirebaseInsightsInstallationRow(
                  document.data(),
                  `bundle_installations/${document.id}`,
                ),
              )
            : null;
        }
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
        if (
          input.model === "bundle_events" ||
          input.model === "bundle_installations"
        ) {
          await ensureMigrated();
          const collection =
            input.model === "bundle_events"
              ? collections.bundleEvents
              : collections.bundleInstallations;
          let query = applyFirebaseWhere(collection, input.where ?? []);
          for (const order of input.orderBy ?? []) {
            if (order.nulls !== undefined) {
              throw new FirebaseDatabaseConstraintError("query.unsupported");
            }
            query = query.orderBy(order.field, order.direction);
          }
          const snapshot = await query
            .offset(input.offset)
            .limit(input.limit)
            .get();
          return snapshot.docs.map((document) =>
            input.model === "bundle_events"
              ? requireFirebaseDocumentKey(
                  "bundle_events",
                  document.id,
                  parseFirebaseBundleEventRow(
                    document.data(),
                    `bundle_events/${document.id}`,
                  ),
                )
              : requireFirebaseDocumentKey(
                  "bundle_installations",
                  document.id,
                  parseFirebaseInsightsInstallationRow(
                    document.data(),
                    `bundle_installations/${document.id}`,
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
