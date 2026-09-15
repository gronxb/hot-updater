import {
  compareInsightsText,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import {
  insightsHourlyBucketKey,
  insightsLifetimeMarkerKey,
  insightsReleaseKey,
  recordProjectedInsightsEvent,
} from "@hot-updater/plugin-core/internal";
import {
  latestInsightsWhere,
  latestInsightsCountGroups,
  type InsightsProjectionBackend,
  type PreparedInsightsEvent,
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
  FieldValue,
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

const firebaseInsightsDocumentId = (key: string): string =>
  Buffer.from(key, "utf8").toString("base64url");

const createFirebaseInsightsProjection = (
  db: ReturnType<typeof getFirestore>,
  collections: ReturnType<typeof createFirebaseDatabaseCollections>,
): InsightsProjectionBackend => ({
  async readRecordContext({ installId, lifetimeKey }) {
    return db.runTransaction(async (transaction) => {
      const stateReference = collections.insightsProjectionStates.doc(
        firebaseInsightsDocumentId(installId),
      );
      const references = [
        stateReference,
        ...(lifetimeKey === null
          ? []
          : [
              collections.insightsLifetimeMarkers.doc(
                firebaseInsightsDocumentId(
                  insightsLifetimeMarkerKey(lifetimeKey),
                ),
              ),
            ]),
      ];
      const [state, marker] = await transaction.getAll(...references);
      if (!state?.exists) {
        return {
          revision: "0",
          state: null,
          lifetimeExists: marker?.exists ?? false,
        };
      }
      const data = state.data();
      if (
        typeof data?.revision !== "number" ||
        !Number.isSafeInteger(data.revision) ||
        data.revision < 1 ||
        typeof data.state !== "string"
      ) {
        throw new FirebaseDatabaseConstraintError(
          "insights_projection_states.invalid",
        );
      }
      return {
        revision: String(data.revision),
        state: data.state,
        lifetimeExists: marker?.exists ?? false,
      };
    });
  },
  async commitPreparedEvent(prepared: PreparedInsightsEvent) {
    return db.runTransaction(async (transaction) => {
      const event = prepared.event;
      const eventReference = collections.bundleEvents.doc(event.id);
      const installationReference = collections.insightsLatest.doc(
        firebaseInstallationDocumentId(event.install_id),
      );
      const stateReference = collections.insightsProjectionStates.doc(
        firebaseInsightsDocumentId(event.install_id),
      );
      const markerReference =
        prepared.firstLifetime === null
          ? null
          : collections.insightsLifetimeMarkers.doc(
              firebaseInsightsDocumentId(
                insightsLifetimeMarkerKey(prepared.firstLifetime),
              ),
            );
      const [storedEvent, storedInstallation, storedState, storedMarker] =
        await transaction.getAll(
          eventReference,
          installationReference,
          stateReference,
          ...(markerReference === null ? [] : [markerReference]),
        );
      if (storedEvent.exists) return { status: "duplicate" as const };
      const expectedRevision = Number(prepared.expectedRevision);
      const actualRevision = storedState.exists
        ? storedState.data()?.revision
        : 0;
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        actualRevision !== expectedRevision ||
        storedMarker?.exists
      ) {
        return { status: "conflict" as const };
      }

      transaction.create(eventReference, event);
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
      if (
        current === null ||
        event.received_at_ms > current.received_at_ms ||
        (event.received_at_ms === current.received_at_ms &&
          compareInsightsText(event.id, current.id) > 0)
      ) {
        transaction.set(installationReference, event);
      }
      transaction.set(stateReference, {
        revision: expectedRevision + 1,
        state: prepared.nextState,
      });

      if (prepared.firstLifetime !== null) {
        transaction.create(markerReference!, prepared.firstLifetime);
      }
      for (const delta of prepared.summaryDeltas) {
        const key = insightsReleaseKey(delta.release);
        transaction.set(
          collections.insightsReleaseSummaries.doc(
            firebaseInsightsDocumentId(key),
          ),
          {
            release: delta.release,
            active_installations: FieldValue.increment(delta.active),
            pending_installations: FieldValue.increment(delta.pending),
            downloaded_installations: FieldValue.increment(delta.downloaded),
            recovered_installations: FieldValue.increment(delta.recovered),
          },
          { merge: true },
        );
      }
      if (prepared.hourly !== null) {
        const hourly = prepared.hourly;
        transaction.set(
          collections.insightsHourlyActivity.doc(
            firebaseInsightsDocumentId(
              insightsHourlyBucketKey(hourly.release, hourly.hourStartMs),
            ),
          ),
          {
            release_key: insightsReleaseKey(hourly.release),
            release: hourly.release,
            hour_start_ms: hourly.hourStartMs,
            downloaded_reports: FieldValue.increment(
              hourly.metric === "downloaded" ? 1 : 0,
            ),
            applied_reports: FieldValue.increment(
              hourly.metric === "applied" ? 1 : 0,
            ),
            recovered_reports: FieldValue.increment(
              hourly.metric === "recovered" ? 1 : 0,
            ),
          },
          { merge: true },
        );
      }
      return { status: "committed" as const };
    });
  },
  async getReleaseActivity(input) {
    const summaryDocuments = await db.getAll(
      ...input.releases.map((release) =>
        collections.insightsReleaseSummaries.doc(
          firebaseInsightsDocumentId(insightsReleaseKey(release)),
        ),
      ),
    );
    const summaries = new Map(
      summaryDocuments
        .filter((document) => document.exists)
        .map((document) => [document.id, document.data()!]),
    );
    const series =
      input.timeRange === undefined
        ? new Map<string, readonly DocumentData[]>()
        : new Map(
            await Promise.all(
              input.releases.map(async (release) => {
                const key = insightsReleaseKey(release);
                const snapshot = await collections.insightsHourlyActivity
                  .where("release_key", "==", key)
                  .where("hour_start_ms", ">=", input.timeRange!.start)
                  .where("hour_start_ms", "<", input.timeRange!.end)
                  .orderBy("hour_start_ms", "asc")
                  .get();
                return [
                  key,
                  snapshot.docs.map((document) => document.data()),
                ] as const;
              }),
            ),
          );
    const count = (value: unknown): number => {
      const result = value ?? 0;
      if (!Number.isSafeInteger(result) || (result as number) < 0) {
        throw new FirebaseDatabaseConstraintError(
          "insights_release_activity.invalid",
        );
      }
      return result as number;
    };
    return {
      coverage: { kind: "complete" as const, sinceMs: 0 },
      data: input.releases.map((release, index) => {
        const key = insightsReleaseKey(release);
        const summary = summaries.get(summaryDocuments[index]!.id);
        return {
          release,
          summary: {
            activeInstallations: count(summary?.active_installations),
            pendingInstallations: count(summary?.pending_installations),
            downloadedInstallations: count(summary?.downloaded_installations),
            recoveredInstallations: count(summary?.recovered_installations),
          },
          ...(input.timeRange === undefined
            ? {}
            : {
                series: (series.get(key) ?? []).map((point) => ({
                  startMs: count(point.hour_start_ms),
                  downloadedReports: count(point.downloaded_reports),
                  appliedReports: count(point.applied_reports),
                  recoveredReports: count(point.recovered_reports),
                })),
              }),
          measuredAtMs: Date.now(),
        };
      }),
    };
  },
});

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
    const nativeInsightsProjection = createFirebaseInsightsProjection(
      db,
      collections,
    );
    let migration: Promise<void> | undefined;

    const ensureMigrated = (): Promise<void> => {
      migration ??= migrateFirebaseDatabase(collections).catch((error) => {
        migration = undefined;
        throw error;
      });
      return migration;
    };
    const insightsProjection: InsightsProjectionBackend = {
      async readRecordContext(input) {
        await ensureMigrated();
        return nativeInsightsProjection.readRecordContext(input);
      },
      async commitPreparedEvent(input) {
        await ensureMigrated();
        return nativeInsightsProjection.commitPreparedEvent(input);
      },
      async getReleaseActivity(input) {
        await ensureMigrated();
        return nativeInsightsProjection.getReleaseActivity(input);
      },
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
      recordInsights: (input) =>
        recordProjectedInsightsEvent(insightsProjection, input),
      getReleaseActivity: (input) =>
        insightsProjection.getReleaseActivity(input),
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
