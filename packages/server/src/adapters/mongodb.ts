import {
  createDatabasePlugin,
  type ReleaseReference,
} from "@hot-updater/plugin-core";
import {
  insightsHourlyBucketKey,
  insightsLifetimeMarkerKey,
  insightsReleaseKey,
  recordProjectedInsightsEvent,
} from "@hot-updater/plugin-core/internal";
import {
  createDatabasePluginAdapter,
  type DatabasePluginImplementation,
  type TransactionDatabasePluginImplementation,
  type InsightsProjectionBackend,
  type PreparedInsightsEvent,
} from "@hot-updater/plugin-core/internal";
import {
  MongoServerError,
  type ClientSession,
  type MongoClient,
} from "mongodb";

import { createMongoMigrator } from "../db/fixedMigrator";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import { createMongoCollections } from "./mongodbCollections";
import { createMongoReads } from "./mongodbReads";
import { createMongoWrites } from "./mongodbWrites";

const createMongoInsightsProjection = (
  client: MongoClient,
): InsightsProjectionBackend => {
  const collections = createMongoCollections(client);
  return {
    async readRecordContext({ installId, lifetimeKey }) {
      const [state, marker] = await Promise.all([
        collections.insightsInstallStates.findOne({ install_id: installId }),
        lifetimeKey === null
          ? null
          : collections.insightsLifetimeMarkers.findOne({
              marker_key: insightsLifetimeMarkerKey(lifetimeKey),
            }),
      ]);
      return {
        revision: String(state?.revision ?? 0),
        state: state?.state ?? null,
        lifetimeExists: marker !== null,
      };
    },
    async commitPreparedEvent(prepared: PreparedInsightsEvent) {
      try {
        return await client.withSession((session) =>
          session.withTransaction(async () => {
            const collections = createMongoCollections(client);
            const options = { session };
            if (
              (await collections.bundleEvents.findOne(
                { id: prepared.event.id },
                options,
              )) !== null
            ) {
              return { status: "duplicate" as const };
            }
            const state = await collections.insightsInstallStates.findOne(
              { install_id: prepared.event.install_id },
              options,
            );
            if (String(state?.revision ?? 0) !== prepared.expectedRevision) {
              return { status: "conflict" as const };
            }
            const markerKey =
              prepared.firstLifetime === null
                ? null
                : insightsLifetimeMarkerKey(prepared.firstLifetime);
            if (
              markerKey !== null &&
              (await collections.insightsLifetimeMarkers.findOne(
                { marker_key: markerKey },
                options,
              )) !== null
            ) {
              return { status: "conflict" as const };
            }
            const event = prepared.event;
            await collections.bundleEvents.insertOne({ ...event }, options);
            const head = await collections.bundleEventHeads.findOne(
              { install_id: event.install_id },
              options,
            );
            if (
              head === null ||
              event.received_at_ms > head.received_at_ms ||
              (event.received_at_ms === head.received_at_ms &&
                event.id > head.id)
            ) {
              await collections.bundleEventHeads.updateOne(
                { install_id: event.install_id },
                {
                  $set: {
                    install_id: event.install_id,
                    id: event.id,
                    received_at_ms: event.received_at_ms,
                    user_id: event.user_id,
                    platform: event.platform,
                    channel: event.channel,
                    type: event.type,
                    from_bundle_id: event.from_bundle_id,
                    to_bundle_id: event.to_bundle_id,
                  },
                },
                { ...options, upsert: true },
              );
            }
            await collections.insightsInstallStates.updateOne(
              { install_id: event.install_id },
              {
                $set: {
                  install_id: event.install_id,
                  revision: Number(prepared.expectedRevision) + 1,
                  state: prepared.nextState,
                },
              },
              { ...options, upsert: true },
            );
            type Delta = {
              release: ReleaseReference;
              active: number;
              pending: number;
              downloaded: number;
              recovered: number;
            };
            const deltas = new Map<string, Delta>();
            const add = (
              release: ReleaseReference,
              metric: "active" | "pending" | "downloaded" | "recovered",
              delta: number,
            ) => {
              const key = insightsReleaseKey(release);
              const value = deltas.get(key) ?? {
                release,
                active: 0,
                pending: 0,
                downloaded: 0,
                recovered: 0,
              };
              value[metric] += delta;
              deltas.set(key, value);
            };
            for (const delta of prepared.currentDeltas) {
              add(delta.release, delta.metric, delta.delta);
            }
            if (prepared.firstLifetime !== null) {
              await collections.insightsLifetimeMarkers.insertOne(
                {
                  marker_key: markerKey!,
                  release_id: prepared.firstLifetime.release.releaseId,
                  platform: prepared.firstLifetime.release.platform,
                  channel: prepared.firstLifetime.release.channel,
                  install_id: prepared.firstLifetime.installId,
                  metric: prepared.firstLifetime.metric,
                },
                options,
              );
              add(
                prepared.firstLifetime.release,
                prepared.firstLifetime.metric,
                1,
              );
            }
            for (const [key, delta] of deltas) {
              await collections.insightsReleaseSummaries.updateOne(
                { release_key: key },
                {
                  $setOnInsert: {
                    release_key: key,
                    release_id: delta.release.releaseId,
                    platform: delta.release.platform,
                    channel: delta.release.channel,
                    active_installations: 0,
                    pending_installations: 0,
                    downloaded_installations: 0,
                    recovered_installations: 0,
                  },
                },
                { ...options, upsert: true },
              );
              await collections.insightsReleaseSummaries.updateOne(
                { release_key: key },
                {
                  $inc: {
                    active_installations: delta.active,
                    pending_installations: delta.pending,
                    downloaded_installations: delta.downloaded,
                    recovered_installations: delta.recovered,
                  },
                },
                options,
              );
            }
            if (prepared.hourly !== null) {
              const hourly = prepared.hourly;
              const bucketKey = insightsHourlyBucketKey(
                hourly.release,
                hourly.hourStartMs,
              );
              await collections.insightsHourlyActivity.updateOne(
                { bucket_key: bucketKey },
                {
                  $setOnInsert: {
                    bucket_key: bucketKey,
                    release_id: hourly.release.releaseId,
                    platform: hourly.release.platform,
                    channel: hourly.release.channel,
                    hour_start_ms: hourly.hourStartMs,
                  },
                  $inc: {
                    downloaded_reports: hourly.metric === "downloaded" ? 1 : 0,
                    applied_reports: hourly.metric === "applied" ? 1 : 0,
                    recovered_reports: hourly.metric === "recovered" ? 1 : 0,
                  },
                },
                { ...options, upsert: true },
              );
            }
            return { status: "committed" as const };
          }),
        );
      } catch (error) {
        if (!(error instanceof MongoServerError) || error.code !== 11000) {
          throw error;
        }
        const duplicate = await collections.bundleEvents.findOne({
          id: prepared.event.id,
        });
        return {
          status:
            duplicate === null ? ("conflict" as const) : ("duplicate" as const),
        };
      }
    },
    async getReleaseActivity(input) {
      const keys = input.releases.map(insightsReleaseKey);
      const summaries = await collections.insightsReleaseSummaries
        .find({ release_key: { $in: keys } })
        .toArray();
      const summaryByKey = new Map(
        summaries.map((summary) => [summary.release_key, summary]),
      );
      const points =
        input.timeRange === undefined
          ? []
          : await collections.insightsHourlyActivity
              .find({
                $or: input.releases.map((release) => ({
                  release_id: release.releaseId,
                  platform: release.platform,
                  channel: release.channel,
                })),
                hour_start_ms: {
                  $gte: input.timeRange.start,
                  $lt: input.timeRange.end,
                },
              })
              .sort({
                platform: 1,
                channel: 1,
                release_id: 1,
                hour_start_ms: 1,
              })
              .toArray();
      const count = (value: number | undefined) => value ?? 0;
      return {
        coverage: { kind: "complete" as const, sinceMs: 0 },
        data: input.releases.map((release) => {
          const key = insightsReleaseKey(release);
          const summary = summaryByKey.get(key);
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
                  series: points
                    .filter(
                      (point) =>
                        point.release_id === release.releaseId &&
                        point.platform === release.platform &&
                        point.channel === release.channel,
                    )
                    .map((point) => ({
                      startMs: point.hour_start_ms,
                      downloadedReports: point.downloaded_reports,
                      appliedReports: point.applied_reports,
                      recoveredReports: point.recovered_reports,
                    })),
                }),
            measuredAtMs: Date.now(),
          };
        }),
      };
    },
  };
};

export interface MongoDBConfig {
  readonly client: MongoClient;
  /** Enables atomic catalog commits. Insights always requires MongoDB 5+ on a replica set or sharded cluster. */
  readonly transactions?: boolean;
}

const createMongoImplementation = (
  client: MongoClient,
  session?: ClientSession,
): DatabasePluginImplementation => {
  const collections = createMongoCollections(client);
  const insightsProjection = createMongoInsightsProjection(client);
  return {
    recordInsights: (input) =>
      recordProjectedInsightsEvent(insightsProjection, input),
    getReleaseActivity: (input) => insightsProjection.getReleaseActivity(input),
    ...createMongoWrites(collections, session),
    ...createMongoReads(collections, session),
  };
};

const createTransactionalMongoImplementation = (
  client: MongoClient,
): DatabasePluginImplementation => ({
  ...createMongoImplementation(client),
  deleteChannel: (input) =>
    client.withSession((session) =>
      session.withTransaction(() =>
        createMongoImplementation(client, session).deleteChannel(input),
      ),
    ),
  transaction: <TResult>(
    callback: (
      transaction: TransactionDatabasePluginImplementation,
    ) => Promise<TResult>,
  ): Promise<TResult> =>
    client.withSession((session) =>
      session.withTransaction(() =>
        callback(createMongoImplementation(client, session)),
      ),
    ),
});

export const mongoAdapter = (
  config: MongoDBConfig,
): DatabaseAdapterWithCapabilities => {
  const adapter = createDatabasePluginAdapter(
    "mongodb",
    config.transactions === true
      ? createTransactionalMongoImplementation(config.client)
      : createMongoImplementation(config.client),
  );
  return Object.assign(
    createDatabasePlugin({
      name: "mongodb",
      models: adapter.models,
      commit: adapter.commit,
    }),
    {
      adapterName: "mongodb",
      provider: "mongodb" as const,
      createMigrator: () => createMongoMigrator(config.client),
    },
  );
};
