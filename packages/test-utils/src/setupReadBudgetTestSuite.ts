import {
  type DatabaseAdapter,
  type DatabaseReadCount,
  type HotUpdaterCoreApi,
  type PhysicalTable,
  SETTINGS_TABLE,
  targetBaseCandidateKey,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import type {
  BundleEventRow,
  InsightsCountEventsInput,
  InsightsCountEventSeriesInput,
  InsightsCountLatestEventsInput,
  InsightsEventSeriesPoint,
  InsightsFindLatestEventsInput,
  InsightsGetAppUsageInput,
  InsightsGetAppUsageResult,
  InsightsGetReleaseActivityInput,
  InsightsGetReleaseActivityResult,
  InsightsListEventsInput,
} from "@hot-updater/plugin-insights/server";
import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  type ArtifactInfo,
  type Bundle,
  type ReleaseCatalog,
} from "@hot-updater/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMeasuredDatabase,
  type MeasuredDatabase,
  type MeasuredDatabaseStorage,
} from "./createMeasuredDatabase";
import { createBundleFixture } from "./databaseTestFixtures";
import type { RowsExamined } from "./sqlRowsExamined";

/** Core's API with the client routes' reads, which the public API leaves out. */
type ReadBudgetCore = HotUpdaterCoreApi & {
  getReleaseCatalog(input: {
    readonly strategy: "APP_VERSION";
    readonly platform: "ios" | "android";
    readonly channelKey: string;
    readonly appVersion: string;
  }): Promise<ReleaseCatalog | null>;
  getArtifactInfo(
    targetBundleId: string,
    currentBundleId: string,
    artifactProtocolVersion: 1,
  ): Promise<ArtifactInfo | null>;
  latestReleaseId(scopeKey: string): Promise<string | null>;
};

interface ReadBudgetInsights {
  recordEvent(event: BundleEventRow): Promise<void>;
  listEvents(
    input: InsightsListEventsInput,
  ): Promise<readonly BundleEventRow[]>;
  findLatestEvents(
    input: InsightsFindLatestEventsInput,
  ): Promise<readonly BundleEventRow[]>;
  countLatestEvents(input: InsightsCountLatestEventsInput): Promise<number>;
  countEvents(input: InsightsCountEventsInput): Promise<number>;
  countEventSeries(
    input: InsightsCountEventSeriesInput,
  ): Promise<readonly InsightsEventSeriesPoint[]>;
  getReleaseActivity(
    input: InsightsGetReleaseActivityInput,
  ): Promise<InsightsGetReleaseActivityResult>;
  getAppUsage(
    input: InsightsGetAppUsageInput,
  ): Promise<InsightsGetAppUsageResult>;
  getUpdateFailures(input: {
    readonly platform: "ios" | "android";
    readonly channel: string;
    readonly releaseId?: string;
    readonly timeRange?: { readonly start: number; readonly end: number };
  }): Promise<{
    readonly failedUpdates: number;
    readonly failedInstallations: number;
    readonly checks?: { readonly failures: number };
    readonly breakdown?: readonly {
      readonly stage: string;
      readonly reason: string;
      readonly events: number;
    }[];
  }>;
}

interface ReadBudgetApiKeys {
  create(input: {
    readonly name: string;
  }): Promise<{ readonly apiKey: string }>;
}

export interface ReadBudgetAdapterContext {
  /**
   * Core's tables, those of the plugins the suite measures, and the settings
   * table, where the retention passes keep their lease.
   */
  readonly tables: readonly PhysicalTable[];
  /** Test-only: the adapter must fetch at most this many rows per native page. */
  readonly nativePageSize: number;
}

export interface ReadBudgetSuiteOptions {
  readonly name: string;
  /** Returns an adapter over freshly created, empty tables. */
  readonly createAdapter: (context: ReadBudgetAdapterContext) => Promise<{
    readonly adapter: DatabaseAdapter;
    readonly cleanup?: () => Promise<void>;
    /** SQL backends: the rows the database examined for the adapter's reads. */
    readonly examined?: RowsExamined;
    /**
     * Index reads return row copies without `_v`, as the key-value adapter's
     * do, so a transaction reads the rows it guards again, whole.
     */
    readonly indexCopies?: boolean;
  }>;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** The UTC midnight Insights events start at. */
const T0 = Date.UTC(2026, 8, 20);
const NATIVE_PAGE_SIZE = 2;

const bundleOf = (
  suffix: string,
  platform: Bundle["platform"] = "ios",
  bases: readonly string[] = [],
): Bundle => ({
  ...createBundleFixture(suffix),
  platform,
  assetBaseStorageUri: "storage://read-budgets/assets",
  patches: bases.map((base) => ({
    baseBundleId: createBundleFixture(base).id,
    baseFileHash: `base-hash-${base}`,
    patchFileHash: `patch-hash-${suffix}-${base}`,
    patchStorageUri: `storage://patches/${suffix}-${base}.patch`,
    byteSize: 1_000,
  })),
});

/** Insights event `n`, from install `n` by default, `n` × 10 minutes after T0. */
const eventOf = (
  n: number,
  overrides: Partial<BundleEventRow> = {},
): BundleEventRow =>
  ({
    id: createBundleFixture(String(9000 + n)).id,
    type: "UPDATE_APPLIED",
    install_id: `install-${n}`,
    user_id: n % 2 === 0 ? "user-even" : "user-odd",
    from_release_id: "release-a",
    from_bundle_id: "bundle-a",
    to_release_id: "release-b",
    to_bundle_id: "bundle-b",
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    metadata: {
      cohort: "1",
      update_strategy: "appVersion",
      fingerprint_hash: null,
      sdk_version: null,
    },
    received_at_ms: T0 + n * 10 * 60_000,
    ...overrides,
  }) as BundleEventRow;

/**
 * Update failures on day 3, after every other windowed read's range: installs
 * 3 and 5 fail to download release-b, and install 7's update check fails.
 */
const failureOf = (n: number, install: number, check = false) =>
  eventOf(200 + n, {
    type: "UPDATE_FAILED",
    install_id: `install-${install}`,
    from_release_id: "release-a",
    from_bundle_id: "bundle-a",
    to_release_id: check ? null : "release-b",
    to_bundle_id: check ? "bundle-a" : "bundle-b",
    metadata: {
      ...eventOf(0).metadata,
      failure: check
        ? { stage: "check", reason: "http", http_status: 500 }
        : { stage: "download", reason: "http", http_status: 403 },
    },
    received_at_ms: T0 + 3 * DAY + n * 10 * 60_000,
  } as Partial<BundleEventRow>);

/**
 * History event `n` of the day before T0, three an hour, on its own release
 * and bundles: every windowed read, which starts at T0 or later, skips it.
 */
const historyOf = (n: number) =>
  eventOf(100 + n, {
    install_id: `history-${n}`,
    user_id: null,
    from_bundle_id: "bundle-history-a",
    to_release_id: "release-history",
    to_bundle_id: "bundle-history-b",
    received_at_ms:
      T0 - DAY + Math.floor((n - 1) / 3) * HOUR + ((n - 1) % 3) * 600_000,
  });

const production = {
  channel: "production",
  enabled: true,
  fingerprintHash: null,
  message: null,
  shouldForceUpdate: false,
  targetAppVersion: "1.0.0",
};
const scopeKey = createReleaseCatalogScopeKey({
  channelKey: encodeChannelKey("production"),
  platform: "ios",
  strategy: "APP_VERSION",
});
const bundleEvents = {
  kind: "bundle",
  platform: "ios",
  channel: "production",
  type: "UPDATE_APPLIED",
  toBundleId: "bundle-b",
} as const;

/** The target bundle's manifest, which artifact resolution reads from storage. */
const storage: MeasuredDatabaseStorage = {
  readStorageText: async (storageUri) =>
    storageUri === createBundleFixture("106").manifestStorageUri
      ? JSON.stringify({
          bundleId: createBundleFixture("106").id,
          assets: { "index.ios.bundle": { fileHash: "hbc-hash-106" } },
        })
      : null,
  resolveFileUrl: async (storageUri) =>
    `https://storage.example.com/${encodeURIComponent(storageUri)}`,
};

/**
 * Core's bundles, releases, channels, and a client API key, and 25 Insights
 * events: installs 1–24 ten minutes apart from T0, then install 1 again two
 * days later; and the day of history before T0, as a production database
 * holds, so a read that scans beyond its window examines more rows.
 */
const seed = async (database: MeasuredDatabase) => {
  const core = database.core as ReadBudgetCore;
  const api = database.api as {
    readonly insights: ReadBudgetInsights;
    readonly apiKeys: ReadBudgetApiKeys;
  };
  for (const name of ["staging", "beta", "canary", "nightly"]) {
    await core.ensureChannel(name);
  }
  const deploy = async (bundle: Bundle, channel = "production") => {
    const [deployed] = await core.deploy([
      { bundle, release: { ...production, channel } },
    ]);
    return deployed!.release!.id;
  };
  // Production iOS: 101–106, 106 with patches from 105 and 104; 102 and 103
  // disabled, and 105 promoted to beta as well.
  const releases: string[] = [];
  for (const suffix of ["101", "102", "103", "104", "105"]) {
    releases.push(await deploy(bundleOf(suffix)));
  }
  releases.push(await deploy(bundleOf("106", "ios", ["105", "104"])));
  for (const releaseId of releases.slice(1, 3)) {
    await core.updateReleasePolicy({ releaseId, patch: { enabled: false } });
  }
  await core.promoteRelease({ releaseId: releases[4]!, targetChannel: "beta" });
  await deploy(bundleOf("201", "android"));
  await deploy(bundleOf("202", "android"));
  await deploy(bundleOf("091"), "staging");
  await deploy(bundleOf("092"), "staging");
  const { apiKey } = await api.apiKeys.create({ name: "Read budgets" });
  for (let n = 1; n <= 24; n += 1) await api.insights.recordEvent(eventOf(n));
  await api.insights.recordEvent(
    eventOf(25, { install_id: "install-1", received_at_ms: T0 + 2 * DAY }),
  );
  for (let n = 1; n <= 72; n += 1) {
    await api.insights.recordEvent(historyOf(n));
  }
  await api.insights.recordEvent(failureOf(1, 3));
  await api.insights.recordEvent(failureOf(2, 5));
  await api.insights.recordEvent(failureOf(3, 7, true));
  const channel = (name: string) =>
    core.findChannelByName(name).then((found) => found!);
  const productionId = (await channel("production")).id;
  return {
    core,
    insights: api.insights,
    clientAuth: database.clientAuth,
    apiKey,
    productionId,
    nightlyId: (await channel("nightly")).id,
    /** The auto-patch base key of a new production iOS 1.0.0 bundle. */
    candidateKey: targetBaseCandidateKey({
      channel: "production",
      platform: "ios",
      fingerprintHash: null,
      appVersion: "1.0.0",
    })!,
  };
};

type Seeded = Awaited<ReturnType<typeof seed>>;

/** One API's budget; `returned` and `check` take what `read` returns. */
interface ReadBudget<T = unknown> {
  readonly api: string;
  read(seeded: Seeded): Promise<T>;
  /** Point reads (keys asked) and query rows at the adapter; `copies` when index reads return copies. */
  readonly adapter:
    | DatabaseReadCount
    | ((copies: boolean) => DatabaseReadCount);
  /** Calls and logical rows at the engine, where an aggregate row merges its shard rows. */
  readonly engine: { readonly calls: number; readonly rows: number };
  /** The rows the call returns: the engine reads these and no more. */
  returned?(result: T): number;
  /** Committed writes. */
  readonly writes?: number;
  check?(result: T): void;
}

const budget = <T>(entry: ReadBudget<T>): ReadBudget => entry;

const reads = (
  gets: number,
  keys: number,
  queries: number,
  rows: number,
): DatabaseReadCount => ({ gets, keys, queries, rows });

const updateCheck = {
  strategy: "APP_VERSION",
  platform: "ios",
  channelKey: encodeChannelKey("production"),
  appVersion: "1.0.0",
} as const;

/** The PRD's read-budget list, each count exact at both boundaries. */
const READ_BUDGETS: readonly ReadBudget[] = [
  budget({
    api: "update check: 1 catalog point read",
    read: ({ core }) => core.getReleaseCatalog(updateCheck),
    adapter: reads(1, 1, 0, 0),
    engine: { calls: 1, rows: 1 },
    check: (catalog) => expect(catalog?.releases).toHaveLength(4),
  }),
  budget({
    api: "update check with api-keys: 1 catalog point read and 1 API-key read",
    read: async ({ core, clientAuth, apiKey }) => {
      const headers = new Headers({ "x-api-key": apiKey });
      if (!(await clientAuth!.authenticate(headers))) return null;
      return core.getReleaseCatalog(updateCheck);
    },
    adapter: reads(1, 1, 1, 1),
    engine: { calls: 2, rows: 2 },
    check: (catalog) => expect(catalog?.releases).toHaveLength(4),
  }),
  budget({
    api: "artifact resolution: 1 batch get of 2 bundles and 1 unique patch read",
    read: ({ core }) =>
      core.getArtifactInfo(
        createBundleFixture("106").id,
        createBundleFixture("105").id,
        1,
      ),
    adapter: reads(1, 2, 1, 1),
    engine: { calls: 2, rows: 3 },
    check: (artifact) =>
      expect(artifact).toMatchObject({
        artifactProtocolVersion: 1,
        manifestFileHash: createBundleFixture("106").manifestFileHash,
      }),
  }),
  budget({
    api: "bundle list page: limit rows and one byBundle query per returned bundle with patches",
    read: ({ core }) =>
      core.listBundles({ platform: "ios", order: "desc", limit: 3 }),
    adapter: reads(0, 0, 2, 5),
    engine: { calls: 2, rows: 5 },
    returned: (page) =>
      page.reduce((sum, detail) => sum + 1 + detail.patches.length, 0),
    check: (page) =>
      expect(page.map(({ bundle }) => bundle.id)).toEqual(
        ["106", "105", "104"].map((suffix) => createBundleFixture(suffix).id),
      ),
  }),
  budget({
    api: "bundle total: 1 counter row",
    read: ({ core }) => core.countBundles("ios"),
    adapter: reads(0, 0, 1, 1),
    engine: { calls: 1, rows: 1 },
    check: (total) => expect(total).toBe(8),
  }),
  budget({
    api: "bundle children: nothing extra, the count is on the bundle row",
    read: ({ core }) => core.getBundle(createBundleFixture("105").id),
    adapter: reads(1, 1, 0, 0),
    engine: { calls: 1, rows: 1 },
    check: (detail) =>
      expect(detail).toMatchObject({ patches: [], childCount: 1 }),
  }),
  budget({
    api: "release list: limit rows from one enumerated index",
    read: ({ core, productionId }) =>
      core.listReleases({
        filter: {
          kind: "channelPlatform",
          channelId: productionId,
          platform: "ios",
          enabled: true,
        },
        limit: 3,
      }),
    adapter: reads(0, 0, 1, 3),
    engine: { calls: 1, rows: 3 },
    returned: (releases) => releases.length,
  }),
  budget({
    api: "deploy base candidates: 1 catalog point read",
    read: ({ core, candidateKey }) =>
      core.findBaseBundleIds(candidateKey, createBundleFixture("107").id, 2),
    adapter: reads(1, 1, 0, 0),
    engine: { calls: 1, rows: 1 },
    check: (ids) =>
      expect(ids).toEqual(
        ["106", "105"].map((suffix) => createBundleFixture(suffix).id),
      ),
  }),
  budget({
    api: "deploy latest release id: byScope descending, limit 1",
    read: ({ core }) => core.latestReleaseId(scopeKey),
    adapter: reads(0, 0, 1, 1),
    engine: { calls: 1, rows: 1 },
  }),
  budget({
    api: "channel by name: 1 read",
    read: ({ core }) => core.findChannelByName("staging"),
    adapter: reads(0, 0, 1, 1),
    engine: { calls: 1, rows: 1 },
    returned: (channel) => (channel === null ? 0 : 1),
  }),
  budget({
    api: "list events of a dense day: limit rows from one query",
    // The history day holds 72 events: the page reads 5 of them, and no hint.
    read: ({ insights }) =>
      insights.listEvents({
        filter: { kind: "all" },
        sinceMs: T0 - DAY,
        beforeReceivedAtMs: T0,
        limit: 5,
      }),
    adapter: reads(0, 0, 1, 5),
    engine: { calls: 1, rows: 5 },
    returned: (events) => events.length,
  }),
  budget({
    api: "list events across a gap: limit rows, one empty day, and one outcome row",
    // Day 2 holds event 25 and day 1 nothing, so one outcome row, hour 4 of
    // day 0, names the day below it: a query for its newest shard row and a
    // batch get of the 7 others. Day 0 then holds the other four.
    read: ({ insights }) =>
      insights.listEvents({
        filter: bundleEvents,
        sinceMs: T0,
        beforeReceivedAtMs: T0 + 3 * DAY,
        limit: 5,
      }),
    adapter: reads(1, 7, 4, 6),
    engine: { calls: 4, rows: 6 },
    // The events, and the outcome row that named day 0.
    returned: (events) => events.length + 1,
  }),
  budget({
    api: "list events over an empty range: its top day and one outcome read, both empty",
    // The 90 days before the history day hold nothing: the top day reads
    // empty, and the per-day event count finds no day below it.
    read: ({ insights }) =>
      insights.listEvents({
        filter: { kind: "all" },
        sinceMs: T0 - 91 * DAY,
        beforeReceivedAtMs: T0 - DAY,
        limit: 5,
      }),
    adapter: reads(0, 0, 2, 0),
    engine: { calls: 2, rows: 0 },
    returned: (events) => events.length,
  }),
  budget({
    api: "latest events by install: 1 point read",
    read: ({ insights }) =>
      insights.findLatestEvents({ installId: "install-1" }),
    adapter: reads(1, 1, 0, 0),
    engine: { calls: 1, rows: 1 },
    returned: (events) => events.length,
  }),
  budget({
    api: "latest events by user: limit rows",
    read: ({ insights }) =>
      insights.findLatestEvents({ userId: "user-even", limit: 3 }),
    adapter: reads(0, 0, 1, 3),
    engine: { calls: 1, rows: 3 },
    returned: (events) => events.length,
  }),
  budget({
    api: "countEvents: buckets in the window × shards, all used",
    // Hours T0 and T0 + 1h: installs 1–5 on 5 of 8 outcome shards, 6–11 on 6.
    read: ({ insights }) =>
      insights.countEvents({
        filter: bundleEvents,
        sinceMs: T0,
        beforeReceivedAtMs: T0 + 2 * HOUR,
      }),
    adapter: reads(0, 0, 1, 11),
    engine: { calls: 1, rows: 2 },
    check: (count) => expect(count).toBe(11),
  }),
  budget({
    api: "countEventSeries: buckets in the window × shards, all used",
    // The hours with an apply to bundle-b: hours 0–4 of day 0, installs 1–24
    // on 24 outcome shard rows, and hour 0 of day 2, install 1's on 1.
    read: ({ insights }) =>
      insights.countEventSeries({
        filter: bundleEvents,
        timeRange: { start: T0, end: T0 + 3 * DAY },
        intervalMs: DAY,
      }),
    adapter: reads(0, 0, 1, 25),
    engine: { calls: 1, rows: 6 },
    check: (points) =>
      expect(points.map(({ events }) => events)).toEqual([24, 0, 1]),
  }),
  budget({
    api: "countLatestEvents: buckets in the window × shards, all used",
    // Heads from T0, by UTC day: installs 2–24 on 14 gauge shards of day 0,
    // and install 1's on day 2.
    read: ({ insights }) =>
      insights.countLatestEvents({
        platform: "ios",
        channel: "production",
        sinceMs: T0,
      }),
    adapter: reads(0, 0, 1, 15),
    engine: { calls: 1, rows: 2 },
    check: (count) => expect(count).toBe(24),
  }),
  budget({
    api: "countLatestEvents by bundle: buckets in the window × shards, all used",
    // Days 0 and 2, like the distribution: 14 shards and 1.
    read: ({ insights }) =>
      insights.countLatestEvents({
        platform: "ios",
        channel: "production",
        sinceMs: T0,
        bundle: [
          {
            field: "to_bundle_id",
            value: "bundle-b",
            types: ["UPDATE_APPLIED"],
          },
        ],
      }),
    adapter: reads(0, 0, 1, 15),
    engine: { calls: 1, rows: 2 },
    check: (count) => expect(count).toBe(24),
  }),
  budget({
    api: "release activity: buckets × shards, all used",
    // One lifetime row on all 8 counter shards: 24 installs launched it.
    read: ({ insights }) =>
      insights.getReleaseActivity({
        releases: [
          { releaseId: "release-b", platform: "ios", channel: "production" },
        ],
      }),
    adapter: reads(0, 0, 1, 8),
    engine: { calls: 1, rows: 1 },
    check: ({ data }) => expect(data[0]!.metrics.launches).toBe(25),
  }),
  budget({
    api: "app usage: nonzero distribution and usage-sketch rows in the window, all used",
    // Every platform merges the iOS and Android usage sketches: iOS's of days
    // 0 and 2 (14 shards and 1). The iOS latest events of days 0 and 2 (14
    // gauge shards and 1); none on Android.
    read: ({ insights }) =>
      insights.getAppUsage({
        channel: "production",
        platform: "all",
        timeRange: { start: T0, end: T0 + 3 * DAY },
        intervalMs: DAY,
      }),
    adapter: reads(0, 0, 4, 30),
    engine: { calls: 4, rows: 4 },
    check: ({ versions }) =>
      expect(versions).toEqual([{ name: "1.0.0", installations: 24 }]),
  }),
  budget({
    api: "update failures of a release over a window: buckets × shards, all used",
    // Day 3's hour 0: no counters, since nothing but failures happened;
    // release-b's failure sketches on the 2 shards of installs 3 and 5; and
    // the channel's 2 breakdown rows, the check's on 1 shard, of which the
    // release keeps the download's.
    read: ({ insights }) =>
      insights.getUpdateFailures({
        platform: "ios",
        channel: "production",
        releaseId: "release-b",
        timeRange: { start: T0 + 3 * DAY, end: T0 + 4 * DAY },
      }),
    adapter: reads(0, 0, 3, 5),
    engine: { calls: 3, rows: 3 },
    check: (failures) => {
      expect(failures).toMatchObject({ failedUpdates: 2 });
      expect(failures.breakdown).toEqual([
        {
          stage: "download",
          reason: "http",
          events: 2,
          details: [expect.anything()],
        },
      ]);
    },
  }),
  budget({
    api: "update failures of a channel over a window: buckets × shards, all used",
    // Day 3's hour 0: no counters or usage rows, the channel's failure and
    // check sketches on 2 shards and 1, and its 2 breakdown rows.
    read: ({ insights }) =>
      insights.getUpdateFailures({
        platform: "ios",
        channel: "production",
        timeRange: { start: T0 + 3 * DAY, end: T0 + 4 * DAY },
      }),
    adapter: reads(0, 0, 5, 6),
    engine: { calls: 5, rows: 4 },
    check: (failures) =>
      expect(failures).toMatchObject({
        failedUpdates: 2,
        checks: { failures: 1 },
      }),
  }),
  budget({
    api: "update failures of a release since its first: two kept rows × shards, all used",
    // The lifetime counters on all 8 shards, and the failure sketch on 2.
    read: ({ insights }) =>
      insights.getUpdateFailures({
        platform: "ios",
        channel: "production",
        releaseId: "release-b",
      }),
    adapter: reads(0, 0, 2, 10),
    engine: { calls: 2, rows: 2 },
    check: (failures) =>
      expect(failures).toMatchObject({
        failedUpdates: 2,
        failedInstallations: 2,
      }),
  }),
  budget({
    api: "catalog compile: the scope's enabled releases, all used",
    // A deploy reads the channel, the scope's catalog (once, then as the root
    // of each range), its 4 enabled releases, and its latest release; with
    // copies, it reads those 5 releases whole.
    read: ({ core }) =>
      core.deploy([{ bundle: bundleOf("107"), release: production }]),
    adapter: (copies) => reads(copies ? 5 : 3, copies ? 8 : 3, 3, 6),
    engine: { calls: 6, rows: 9 },
    writes: 1,
  }),
  budget({
    api: "channel insert: 1 write, after the name's read finds nothing",
    read: ({ core }) => core.ensureChannel("read-budgets"),
    adapter: reads(0, 0, 1, 0),
    engine: { calls: 1, rows: 0 },
    writes: 1,
  }),
  budget({
    api: "channel delete: 1 read and 1 write",
    read: ({ core, nightlyId }) => core.deleteChannel(nightlyId),
    adapter: reads(1, 1, 0, 0),
    engine: { calls: 1, rows: 1 },
    writes: 1,
    check: (result) => expect(result).toEqual({ deleted: true }),
  }),
  budget({
    api: "record an insights event: 2 dependent rounds of batch gets and 1 write",
    // The event and install 2's head; then the event's 4 sketch rows, in one
    // batch get per aggregate: its platform's usage of every app version and
    // of its own by hour, and by day, which keeps its own retention. The head
    // moves within its UTC day, so its gauge rows stay as they are and none
    // is read.
    read: ({ insights }) =>
      insights.recordEvent(
        eventOf(26, { install_id: "install-2", received_at_ms: T0 + 3 * HOUR }),
      ),
    adapter: reads(4, 6, 0, 0),
    engine: { calls: 2, rows: 1 },
    writes: 1,
  }),
];

/**
 * The read-budget suite (PRD S4) on one backend: core and the server's
 * built-in plugins on `createMeasuredDatabase` over the backend's adapter,
 * native pages capped at two rows. Every API in the read-budget list reads
 * exactly its budget at the adapter and at the engine; with `examined`, the
 * database examines no more rows than the adapter read, within the backend's
 * native multipliers. It loads `@hot-updater/server`, an optional peer.
 */
export const setupReadBudgetTestSuite = (
  options: ReadBudgetSuiteOptions,
): void => {
  describe(`${options.name} read budgets`, () => {
    let created: Awaited<ReturnType<ReadBudgetSuiteOptions["createAdapter"]>>;
    let database: MeasuredDatabase;
    let seeded: Seeded;
    let writes = 0;

    beforeAll(async () => {
      // The server's built-in plugins, whose reads have budgets.
      const [{ insights }, { apiKeys }] = await Promise.all([
        import("@hot-updater/server/plugins/insights"),
        import("@hot-updater/server/plugins/api-keys"),
      ]);
      const plugins = [insights(), apiKeys()];
      created = await options.createAdapter({
        tables: [...toolingTargetOf(plugins).schema.tables, SETTINGS_TABLE],
        nativePageSize: NATIVE_PAGE_SIZE,
      });
      const { adapter } = created;
      database = await createMeasuredDatabase(
        {
          ...adapter,
          write: (ops) => {
            writes += 1;
            return adapter.write(ops);
          },
        },
        plugins,
        { now: () => T0 + 10 * DAY, storage },
      );
      // Seeding also passes the schema fence of a fenced adapter, such as
      // D1's, so no budget pays for it.
      seeded = await seed(database);
    }, 300_000);

    afterAll(async () => {
      await created?.cleanup?.();
    });

    for (const budget of READ_BUDGETS) {
      it(budget.api, async () => {
        const { examined, indexCopies = false } = created;
        writes = 0;
        examined?.reset();
        const measured = await database.measureReads(() => budget.read(seeded));
        const adapter =
          typeof budget.adapter === "function"
            ? budget.adapter(indexCopies)
            : budget.adapter;
        expect({ adapter: measured.adapter, engine: measured.engine }).toEqual({
          adapter,
          engine: budget.engine,
        });
        expect(writes, "writes").toBe(budget.writes ?? 0);
        if (budget.returned) {
          expect(budget.returned(measured.result), "rows returned").toBe(
            measured.engine.rows,
          );
        }
        budget.check?.(measured.result);
        if (examined) {
          const { gets, keys, queries, rows } = measured.adapter;
          expect(await examined.total(), "rows examined").toBeLessThanOrEqual(
            (examined.perRow ?? 1) * (keys + rows) +
              (examined.perRead ?? 0) * (gets + queries),
          );
        }
      });
    }
  });
};
