import {
  insightsHourlyBucketKey,
  insightsLifetimeMarkerKey,
  insightsReleaseKey,
} from "@hot-updater/plugin-core/internal";
import type {
  InsightsProjectionBackend,
  PreparedInsightsEvent,
} from "@hot-updater/plugin-core/internal";

import type { ORMSQLProvider } from "../db/types";
import { insightsSqlKey, prepareInsightsSqlKeys } from "./insightsSqlKeys";
import { updatePrismaEventHead } from "./prismaInsights";
import { PrismaAdapterError, type PrismaDelegate } from "./prismaRows";

type TransactionClient = object & {
  readonly $transaction: <T>(
    callback: (client: object) => Promise<T>,
    options?: { readonly isolationLevel: "Serializable" },
  ) => Promise<T>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const delegate = (client: object, name: string): PrismaDelegate => {
  const value = Reflect.get(client, name);
  if (
    !isRecord(value) ||
    typeof value["findFirst"] !== "function" ||
    typeof value["findMany"] !== "function" ||
    typeof value["create"] !== "function" ||
    typeof value["update"] !== "function" ||
    typeof value["upsert"] !== "function"
  ) {
    throw new PrismaAdapterError(`missing model delegate "${name}"`);
  }
  return value as PrismaDelegate;
};

const row = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

const count = (value: unknown): number => {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new PrismaAdapterError("invalid Insights aggregate");
  }
  return result;
};

class ProjectionConflictError extends Error {}

const commit = async (
  client: object,
  provider: ORMSQLProvider,
  prepared: PreparedInsightsEvent,
  keys: ReadonlyMap<string, string>,
): Promise<"committed" | "duplicate" | "conflict"> => {
  const events = delegate(client, "bundle_events");
  if (await events.findFirst({ where: { id: prepared.event.id } })) {
    return "duplicate";
  }
  const states = delegate(client, "insights_install_states");
  const current = row(
    await states.findFirst({
      where: { install_id: prepared.event.install_id },
    }),
  );
  const revision = count(current?.["revision"]);
  if (String(revision) !== prepared.expectedRevision) return "conflict";

  const markers = delegate(client, "insights_lifetime_markers");
  const markerKey =
    prepared.firstLifetime === null
      ? null
      : keys.get(insightsLifetimeMarkerKey(prepared.firstLifetime))!;
  if (
    markerKey !== null &&
    (await markers.findFirst({ where: { marker_key: markerKey } }))
  ) {
    return "conflict";
  }

  await events.create({ data: prepared.event });
  await updatePrismaEventHead(client, provider, prepared.event);
  if (current === undefined) {
    await states.create({
      data: {
        install_id: prepared.event.install_id,
        revision: 1,
        state: prepared.nextState,
      },
    });
  } else {
    const updated = await states.updateMany?.({
      where: {
        install_id: prepared.event.install_id,
        revision,
      },
      data: { revision: revision + 1, state: prepared.nextState },
    });
    if (updated?.count !== 1) throw new ProjectionConflictError();
  }

  if (prepared.firstLifetime !== null) {
    const lifetime = prepared.firstLifetime;
    await markers.create({
      data: {
        marker_key: markerKey,
        release_id: lifetime.release.releaseId,
        platform: lifetime.release.platform,
        channel: lifetime.release.channel,
        install_id: lifetime.installId,
        metric: lifetime.metric,
      },
    });
  }

  const summaries = delegate(client, "insights_release_summaries");
  for (const delta of prepared.summaryDeltas) {
    const logicalKey = insightsReleaseKey(delta.release);
    const releaseKey = keys.get(logicalKey)!;
    await summaries.upsert({
      where: { release_key: releaseKey },
      create: {
        release_key: releaseKey,
        release_id: delta.release.releaseId,
        platform: delta.release.platform,
        channel: delta.release.channel,
        active_installations: 0,
        pending_installations: 0,
        downloaded_installations: 0,
        recovered_installations: 0,
      },
      update: {},
    });
    await summaries.update({
      where: { release_key: releaseKey },
      data: {
        active_installations: { increment: delta.active },
        pending_installations: { increment: delta.pending },
        downloaded_installations: { increment: delta.downloaded },
        recovered_installations: { increment: delta.recovered },
      },
    });
  }

  if (prepared.hourly !== null) {
    const activity = prepared.hourly;
    const downloaded = activity.metric === "downloaded" ? 1 : 0;
    const applied = activity.metric === "applied" ? 1 : 0;
    const recovered = activity.metric === "recovered" ? 1 : 0;
    const bucketKey = keys.get(
      insightsHourlyBucketKey(activity.release, activity.hourStartMs),
    )!;
    await delegate(client, "insights_hourly_activity").upsert({
      where: { bucket_key: bucketKey },
      create: {
        bucket_key: bucketKey,
        release_id: activity.release.releaseId,
        platform: activity.release.platform,
        channel: activity.release.channel,
        hour_start_ms: activity.hourStartMs,
        downloaded_reports: downloaded,
        applied_reports: applied,
        recovered_reports: recovered,
      },
      update: {
        downloaded_reports: { increment: downloaded },
        applied_reports: { increment: applied },
        recovered_reports: { increment: recovered },
      },
    });
  }
  return "committed";
};

const isRetryable = (error: unknown): boolean => {
  if (!isRecord(error)) return false;
  const code = String(error["code"] ?? "");
  if (["P2002", "P2034"].includes(code)) return true;
  const metadata = error["meta"];
  return code === "P2010" && isRecord(metadata) && metadata["code"] === "40001";
};

export const createPrismaInsightsProjection = (
  client: TransactionClient,
  provider: ORMSQLProvider,
): InsightsProjectionBackend => ({
  async readRecordContext({ installId, lifetimeKey }) {
    const markerKey =
      lifetimeKey === null
        ? null
        : await insightsSqlKey(insightsLifetimeMarkerKey(lifetimeKey));
    const [stateValue, marker] = await Promise.all([
      delegate(client, "insights_install_states").findFirst({
        where: { install_id: installId },
      }),
      lifetimeKey === null
        ? null
        : delegate(client, "insights_lifetime_markers").findFirst({
            where: {
              marker_key: markerKey,
            },
          }),
    ]);
    const state = row(stateValue);
    return {
      revision: String(count(state?.["revision"])),
      state: typeof state?.["state"] === "string" ? state["state"] : null,
      lifetimeExists: marker !== null,
    };
  },
  async commitPreparedEvent(prepared) {
    const keys = await prepareInsightsSqlKeys(prepared);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const status = await client.$transaction(
          (transaction) => commit(transaction, provider, prepared, keys),
          { isolationLevel: "Serializable" },
        );
        return { status };
      } catch (error) {
        if (error instanceof ProjectionConflictError) {
          return { status: "conflict" as const };
        }
        if (attempt >= 2 || !isRetryable(error)) throw error;
      }
    }
  },
  async getReleaseActivity(input) {
    const keys = await Promise.all(
      input.releases.map((release) =>
        insightsSqlKey(insightsReleaseKey(release)),
      ),
    );
    const summaryRows = await delegate(
      client,
      "insights_release_summaries",
    ).findMany({
      where: { release_key: { in: keys } },
    });
    const pointRows =
      input.timeRange === undefined
        ? []
        : await delegate(client, "insights_hourly_activity").findMany({
            where: {
              OR: input.releases.map((release) => ({
                release_id: release.releaseId,
                platform: release.platform,
                channel: release.channel,
              })),
              hour_start_ms: {
                gte: input.timeRange.start,
                lt: input.timeRange.end,
              },
            },
            orderBy: { hour_start_ms: "asc" },
          });
    const summaries = new Map(
      summaryRows.flatMap((value) => {
        const item = row(value);
        return item === undefined ? [] : [[String(item["release_key"]), item]];
      }),
    );
    const measuredAtMs = Date.now();
    return {
      coverage: { kind: "complete" as const, sinceMs: 0 },
      data: input.releases.map((release, index) => {
        const summary = summaries.get(keys[index]!);
        return {
          release,
          summary: {
            activeInstallations: count(summary?.["active_installations"]),
            pendingInstallations: count(summary?.["pending_installations"]),
            downloadedInstallations: count(
              summary?.["downloaded_installations"],
            ),
            recoveredInstallations: count(summary?.["recovered_installations"]),
          },
          ...(input.timeRange === undefined
            ? {}
            : {
                series: pointRows.flatMap((value) => {
                  const point = row(value);
                  return point?.["release_id"] === release.releaseId &&
                    point["platform"] === release.platform &&
                    point["channel"] === release.channel
                    ? [
                        {
                          startMs: count(point["hour_start_ms"]),
                          downloadedReports: count(point["downloaded_reports"]),
                          appliedReports: count(point["applied_reports"]),
                          recoveredReports: count(point["recovered_reports"]),
                        },
                      ]
                    : [];
                }),
              }),
          measuredAtMs,
        };
      }),
    };
  },
});
