import { createHash } from "node:crypto";

import {
  BatchGetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type {
  BundleEventRow,
  InsightsGetAppUsageInput,
  InsightsGetAppUsageResult,
  InsightsGetReleaseActivityInput,
  InsightsGetReleaseActivityResult,
  ReleaseReference,
} from "@hot-updater/plugin-core";
import {
  addInsightsDistinct,
  countInsightsDistinct,
  insightsDistributionIdentity,
  insightsOverviewDeltas,
  insightsOverviewId,
  mergeInsightsDistinct,
  type InsightsOverviewIdentity,
} from "@hot-updater/plugin-core/internal";

type TransactionAction = NonNullable<
  TransactWriteCommandInput["TransactItems"]
>[number];

export type InsightsOverviewStore = {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
};

type OverviewItem = {
  readonly pk: string;
  readonly sk: string;
  readonly id: string;
  readonly version: number;
  readonly identity: InsightsOverviewIdentity;
  readonly downloads: number;
  readonly launches: number;
  readonly failed_launches: number;
  readonly latest_installations: number;
  readonly launch_users: string | null;
  readonly activity_users: string | null;
};

const OVERVIEW_PREFIX = "_hot-updater#insights-overview#";

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

const partition = (identity: InsightsOverviewIdentity): string => {
  const parts =
    identity.scopeKind === "release"
      ? ["release", identity.releaseId, identity.platform, identity.channel]
      : identity.scopeKind === "channel"
        ? ["channel", identity.platform, identity.channel]
        : identity.scopeKind === "usage"
          ? [
              "usage",
              identity.platform,
              identity.channel,
              identity.appVersionKind,
              identity.appVersion,
            ]
          : ["distribution", identity.channel];
  return `${OVERVIEW_PREFIX}${digest(parts)}`;
};

const sortKey = (identity: InsightsOverviewIdentity): string =>
  identity.periodKind === "lifetime"
    ? "lifetime"
    : identity.periodKind === "hour"
      ? `hour#${String(identity.bucketStartMs).padStart(16, "0")}`
      : `latest#${String(identity.bucketStartMs).padStart(16, "0")}#${insightsOverviewId(identity)}`;

const key = (identity: InsightsOverviewIdentity) => ({
  pk: partition(identity),
  sk: sortKey(identity),
});

const empty = (identity: InsightsOverviewIdentity): OverviewItem => ({
  ...key(identity),
  id: insightsOverviewId(identity),
  version: 0,
  identity,
  downloads: 0,
  launches: 0,
  failed_launches: 0,
  latest_installations: 0,
  launch_users: null,
  activity_users: null,
});

const parse = (value: Record<string, unknown>): OverviewItem => {
  const identity = value.identity;
  if (
    typeof value.pk !== "string" ||
    typeof value.sk !== "string" ||
    typeof value.id !== "string" ||
    typeof value.version !== "number" ||
    typeof identity !== "object" ||
    identity === null ||
    typeof value.downloads !== "number" ||
    typeof value.launches !== "number" ||
    typeof value.failed_launches !== "number" ||
    typeof value.latest_installations !== "number" ||
    (value.launch_users !== null && typeof value.launch_users !== "string") ||
    (value.activity_users !== null && typeof value.activity_users !== "string")
  ) {
    throw new Error("DynamoDB contains an invalid Insights overview item");
  }
  return value as OverviewItem;
};

const load = async (
  store: InsightsOverviewStore,
  identities: readonly InsightsOverviewIdentity[],
): Promise<Map<string, OverviewItem>> => {
  if (identities.length === 0) return new Map();
  const items: Record<string, unknown>[] = [];
  const keys = identities.map(key);
  for (let offset = 0; offset < keys.length; offset += 100) {
    let pending = keys.slice(offset, offset + 100);
    for (let attempt = 0; attempt < 5 && pending.length > 0; attempt += 1) {
      const response = await store.client.send(
        new BatchGetCommand({
          RequestItems: {
            [store.tableName]: { ConsistentRead: true, Keys: pending },
          },
        }),
      );
      items.push(...(response?.Responses?.[store.tableName] ?? []));
      pending = (response?.UnprocessedKeys?.[store.tableName]?.Keys ?? []) as {
        readonly pk: string;
        readonly sk: string;
      }[];
      if (pending.length > 0 && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
    if (pending.length > 0) {
      throw new Error(
        `DynamoDB did not process ${pending.length} Insights overview keys`,
      );
    }
  }
  return new Map(
    items.map((value) => {
      const item = parse(value);
      return [item.id, item];
    }),
  );
};

const put = (
  store: InsightsOverviewStore,
  previous: OverviewItem | undefined,
  item: OverviewItem,
): TransactionAction => ({
  Put: {
    TableName: store.tableName,
    Item: item,
    ConditionExpression:
      previous === undefined
        ? "attribute_not_exists(#pk)"
        : "#version = :version",
    ExpressionAttributeNames:
      previous === undefined ? { "#pk": "pk" } : { "#version": "version" },
    ...(previous === undefined
      ? {}
      : { ExpressionAttributeValues: { ":version": previous.version } }),
  },
});

const distribution = (
  event: BundleEventRow,
  current: BundleEventRow | null,
): readonly {
  readonly identity: InsightsOverviewIdentity;
  readonly amount: number;
}[] => {
  if (
    current !== null &&
    (event.received_at_ms < current.received_at_ms ||
      (event.received_at_ms === current.received_at_ms &&
        event.id <= current.id))
  ) {
    return [];
  }
  const next = insightsDistributionIdentity(event);
  if (current === null) return [{ identity: next, amount: 1 }];
  const previous = insightsDistributionIdentity(current);
  if (insightsOverviewId(previous) === insightsOverviewId(next)) return [];
  return [
    { identity: previous, amount: -1 },
    { identity: next, amount: 1 },
  ];
};

export const createDynamoDBOverviewActions = async (
  store: InsightsOverviewStore,
  event: BundleEventRow,
  current: BundleEventRow | null,
): Promise<readonly TransactionAction[]> => {
  const deltas = insightsOverviewDeltas(event);
  const movements = distribution(event, current);
  const identities = [
    ...deltas.map(({ identity }) => identity),
    ...movements.map(({ identity }) => identity),
  ];
  const existing = await load(store, identities);
  const next = new Map<string, OverviewItem>();
  for (const delta of deltas) {
    const id = insightsOverviewId(delta.identity);
    const previous = next.get(id) ?? existing.get(id);
    next.set(id, {
      ...(previous ?? empty(delta.identity)),
      version: (previous?.version ?? 0) + 1,
      downloads: (previous?.downloads ?? 0) + delta.downloads,
      launches: (previous?.launches ?? 0) + delta.launches,
      failed_launches: (previous?.failed_launches ?? 0) + delta.failedLaunches,
      launch_users:
        delta.launchIdentity === undefined
          ? (previous?.launch_users ?? null)
          : addInsightsDistinct(previous?.launch_users, delta.launchIdentity),
      activity_users:
        delta.activityIdentity === undefined
          ? (previous?.activity_users ?? null)
          : addInsightsDistinct(
              previous?.activity_users,
              delta.activityIdentity,
            ),
    });
  }
  for (const movement of movements) {
    const id = insightsOverviewId(movement.identity);
    const previous = next.get(id) ?? existing.get(id);
    const installations =
      (previous?.latest_installations ?? 0) + movement.amount;
    if (installations < 0) {
      throw new Error("DynamoDB Insights distribution is inconsistent");
    }
    next.set(id, {
      ...(previous ?? empty(movement.identity)),
      version: (previous?.version ?? 0) + 1,
      latest_installations: installations,
    });
  }
  return [...next.values()].map((item) =>
    put(store, existing.get(item.id), item),
  );
};

const query = async (
  store: InsightsOverviewStore,
  partitionKey: string,
  range?: { readonly start: number; readonly end: number },
  period: "hour" | "latest" = "hour",
): Promise<OverviewItem[]> => {
  const items: OverviewItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await store.client.send(
      new QueryCommand({
        TableName: store.tableName,
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
        KeyConditionExpression:
          range === undefined
            ? "#pk = :pk"
            : "#pk = :pk AND #sk BETWEEN :start AND :end",
        ExpressionAttributeNames:
          range === undefined ? { "#pk": "pk" } : { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": partitionKey,
          ...(range === undefined
            ? {}
            : {
                ":start": `${period}#${String(range.start).padStart(16, "0")}`,
                ":end": `${period}#${String(range.end - 1).padStart(16, "0")}~`,
              }),
        },
      }),
    );
    items.push(...(page.Items ?? []).map(parse));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return items;
};

const releaseIdentity = (
  release: ReleaseReference,
  periodKind: "lifetime" | "hour" = "lifetime",
): InsightsOverviewIdentity => ({
  scopeKind: "release",
  releaseKind: "specific",
  releaseId: release.releaseId,
  channel: release.channel,
  platform: release.platform,
  appVersionKind: "all",
  appVersion: "",
  periodKind,
  bucketStartMs: 0,
});

const metrics = (rows: readonly OverviewItem[], ranged: boolean) => {
  const days = new Map<number, { launches: number; failedLaunches: number }>();
  for (const row of rows) {
    const startMs =
      Math.floor(row.identity.bucketStartMs / 86_400_000) * 86_400_000;
    const point = days.get(startMs) ?? { launches: 0, failedLaunches: 0 };
    point.launches += row.launches;
    point.failedLaunches += row.failed_launches;
    days.set(startMs, point);
  }
  return {
    downloads: rows.reduce((sum, row) => sum + row.downloads, 0),
    launches: rows.reduce((sum, row) => sum + row.launches, 0),
    failedLaunches: rows.reduce((sum, row) => sum + row.failed_launches, 0),
    ...(ranged
      ? {
          uniqueUsers: countInsightsDistinct(
            mergeInsightsDistinct(rows.map(({ launch_users }) => launch_users)),
          ),
          series: [...days]
            .sort(([left], [right]) => left - right)
            .map(([startMs, point]) => ({ startMs, ...point })),
        }
      : {}),
  };
};

export const getDynamoDBReleaseActivity = async (
  store: InsightsOverviewStore,
  input: InsightsGetReleaseActivityInput,
): Promise<InsightsGetReleaseActivityResult> => {
  let rows: OverviewItem[];
  if (input.scope !== undefined) {
    const identity: InsightsOverviewIdentity = {
      scopeKind: "channel",
      releaseKind: "all",
      releaseId: "",
      channel: input.scope.channel,
      platform: input.scope.platform,
      appVersionKind: "all",
      appVersion: "",
      periodKind: "hour",
      bucketStartMs: 0,
    };
    rows = await query(store, partition(identity), input.timeRange);
  } else if (input.timeRange === undefined) {
    rows = [
      ...(
        await load(
          store,
          input.releases.map((release) => releaseIdentity(release)),
        )
      ).values(),
    ];
  } else {
    rows = (
      await Promise.all(
        input.releases.map((release) =>
          query(
            store,
            partition(releaseIdentity(release, "hour")),
            input.timeRange,
          ),
        ),
      )
    ).flat();
  }
  return {
    coverage: { kind: "complete", sinceMs: 0 },
    data:
      input.scope !== undefined
        ? [{ scope: input.scope, metrics: metrics(rows, true) }]
        : input.releases.map((release) => ({
            release,
            metrics: metrics(
              rows.filter(
                ({ identity }) =>
                  identity.releaseId === release.releaseId &&
                  identity.channel === release.channel &&
                  identity.platform === release.platform,
              ),
              input.timeRange !== undefined,
            ),
          })),
    measuredAtMs: Date.now(),
  };
};

export const getDynamoDBAppUsage = async (
  store: InsightsOverviewStore,
  input: InsightsGetAppUsageInput,
): Promise<InsightsGetAppUsageResult> => {
  const usageIdentity: InsightsOverviewIdentity = {
    scopeKind: "usage",
    releaseKind: "all",
    releaseId: "",
    channel: input.channel,
    platform: input.platform,
    appVersionKind: input.appVersion === undefined ? "all" : "specific",
    appVersion: input.appVersion ?? "",
    periodKind: "hour",
    bucketStartMs: 0,
  };
  const distributionIdentity: InsightsOverviewIdentity = {
    scopeKind: "distribution",
    releaseKind: "all",
    releaseId: "",
    channel: input.channel,
    platform: "all",
    appVersionKind: "all",
    appVersion: "",
    periodKind: "latest",
    bucketStartMs: 0,
  };
  const [usage, allDistribution] = await Promise.all([
    query(store, partition(usageIdentity), input.timeRange),
    query(store, partition(distributionIdentity), input.timeRange, "latest"),
  ]);
  const distribution = allDistribution.filter(
    ({ identity, latest_installations }) =>
      latest_installations > 0 &&
      identity.bucketStartMs >= input.timeRange.start &&
      identity.bucketStartMs < input.timeRange.end &&
      (input.platform === "all" || identity.platform === input.platform) &&
      (input.appVersion === undefined ||
        identity.appVersion === input.appVersion),
  );
  const points = [];
  for (
    let startMs = input.timeRange.start;
    startMs < input.timeRange.end;
    startMs += input.intervalMs
  ) {
    points.push({
      startMs,
      installations: countInsightsDistinct(
        mergeInsightsDistinct(
          usage
            .filter(
              ({ identity }) =>
                identity.bucketStartMs >= startMs &&
                identity.bucketStartMs < startMs + input.intervalMs,
            )
            .map(({ activity_users }) => activity_users),
        ),
      ),
    });
  }
  const group = (field: "appVersion" | "platform") => {
    const values = new Map<string, number>();
    for (const row of distribution) {
      const name = row.identity[field];
      values.set(name, (values.get(name) ?? 0) + row.latest_installations);
    }
    return [...values]
      .map(([name, installations]) => ({ name, installations }))
      .sort(
        (left, right) =>
          right.installations - left.installations ||
          left.name.localeCompare(right.name),
      );
  };
  const bundles = new Map<
    string,
    InsightsGetAppUsageResult["bundleDistribution"][number]
  >();
  for (const row of distribution) {
    const releaseId =
      row.identity.releaseKind === "specific" ? row.identity.releaseId : null;
    const value = row.identity;
    const itemKey = JSON.stringify([
      value.appVersion,
      value.platform,
      releaseId,
    ]);
    const previous = bundles.get(itemKey);
    bundles.set(itemKey, {
      appVersion: value.appVersion,
      platform: value.platform as "ios" | "android",
      releaseId,
      installations: (previous?.installations ?? 0) + row.latest_installations,
    });
  }
  const versions = group("appVersion");
  return {
    coverage: { kind: "complete", sinceMs: 0 },
    activeInstallations: countInsightsDistinct(
      mergeInsightsDistinct(usage.map(({ activity_users }) => activity_users)),
    ),
    points,
    appVersions: versions.map(({ name }) => name),
    versions,
    platforms: group("platform"),
    bundleDistribution: [...bundles.values()],
    measuredAtMs: Date.now(),
  };
};
