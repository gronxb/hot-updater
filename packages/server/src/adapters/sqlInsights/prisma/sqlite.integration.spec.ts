import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BundleEventRow } from "@hot-updater/plugin-core";
import {
  createInsightsReportPageCursor,
  createInsightsReportProjection,
} from "@hot-updater/plugin-core/internal";
import { registerInsightsModelTests } from "@hot-updater/test-utils";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../../../test-utils/src/databaseTestFixtures";
import { assertPrismaInsightsClient } from "./client";
import { prismaInsightsInstallKey } from "./codec";
import {
  captureEvidencePrismaQueries,
  type EvidencePrismaClient,
  type GeneratedEvidenceClient,
  generateEvidencePrismaClient,
} from "./fixtures/evidenceRuntime";
import { createPrismaInsightsConformanceFixture } from "./fixtures/insightsConformance";
import {
  createPrismaInsightsMaintenance,
  preparePrismaInsights,
} from "./maintenance";
import { createPrismaInsightsModel } from "./model";
import { runPrismaInsightsReportStep } from "./reports";
import {
  createPrismaInsightsLayout,
  hasCompletePrismaInsightsLayout,
} from "./schema";
import { runPrismaInsightsSearchStep } from "./search";
import { prismaInsightsDigest } from "./utils";

const insightsDatabaseNamespace = "00000000-0000-7000-8000-00000000d001";
const fixtureDirectory = fileURLToPath(
  new URL("./fixtures/sqlite", import.meta.url),
);
const generatedClientPath = join(
  fixtureDirectory,
  `runtime-acceptance-${process.pid}`,
);
let generated: GeneratedEvidenceClient | undefined;

const clients: EvidencePrismaClient[] = [];
const directories: string[] = [];

const legacySchema = `create table bundle_events (
  id text primary key, type text not null, install_id text not null,
  user_id text null, username text null, from_release_id text null,
  from_bundle_id text null, to_release_id text null,
  to_bundle_id text not null, platform text not null,
  app_version text not null, channel text not null, cohort text not null,
  update_strategy text null, fingerprint_hash text null,
  sdk_version text null, received_at_ms real not null
)`;

const insertLegacyEvents = (
  client: EvidencePrismaClient,
  rows: readonly BundleEventRow[],
): Promise<number> => {
  const placeholders = rows
    .map(() => `(${Array.from({ length: 17 }, () => "?").join(",")})`)
    .join(",");
  const values = rows.flatMap((row) => [
    row.id,
    row.type,
    row.install_id,
    row.user_id,
    row.username,
    row.from_release_id,
    row.from_bundle_id,
    row.to_release_id,
    row.to_bundle_id,
    row.platform,
    row.app_version,
    row.channel,
    row.cohort,
    row.update_strategy,
    row.fingerprint_hash,
    row.sdk_version,
    row.received_at_ms,
  ]);
  return client.$executeRawUnsafe(
    `insert into bundle_events (
      id,type,install_id,user_id,username,from_release_id,from_bundle_id,
      to_release_id,to_bundle_id,platform,app_version,channel,cohort,
      update_strategy,fingerprint_hash,sdk_version,received_at_ms
    ) values ${placeholders}`,
    ...values,
  );
};

type SqliteQueryPlanRow = { readonly detail: string };

const explainSqlite = (
  client: EvidencePrismaClient,
  query: string,
  ...values: readonly unknown[]
): Promise<SqliteQueryPlanRow[]> =>
  client.$queryRawUnsafe<SqliteQueryPlanRow[]>(
    `explain query plan ${query}`,
    ...values,
  );

const expectIndexedSqlitePlan = (
  plan: readonly SqliteQueryPlanRow[],
  index: string | RegExp,
): void => {
  const details = plan.map(({ detail }) => detail);
  expect(
    details.some((detail) =>
      typeof index === "string" ? detail.includes(index) : index.test(detail),
    ),
  ).toBe(true);
  expect(details.filter((detail) => /\bscan\b/i.test(detail))).toEqual([]);
  expect(
    details.filter((detail) =>
      /(?:temp b-tree|temporary b-tree)/i.test(detail),
    ),
  ).toEqual([]);
};

const assertSqlitePlanMatrix = async (
  client: EvidencePrismaClient,
  input: {
    readonly lowerLegacyId: string;
    readonly upperLegacyId: string;
    readonly installId: string;
    readonly searchJobId: string;
    readonly reportJobId: string;
    readonly upperGeneration: number;
    readonly beforeReceivedAtMs: number;
  },
): Promise<void> => {
  const cases: readonly {
    readonly query: string;
    readonly values: readonly unknown[];
    readonly index: string | RegExp;
  }[] = [
    {
      query: `select id from bundle_events
        where cast(id as blob)>cast(? as blob)
          and cast(id as blob)<=cast(? as blob)
        order by cast(id as blob) asc limit 200`,
      values: [input.lowerLegacyId, input.upperLegacyId],
      index: "private_hot_updater_prisma_insights_legacy_id_idx",
    },
    {
      query: `select source_generation,event_json
        from private_hot_updater_prisma_insights_events
        where source_generation>? and source_generation<=?
        order by source_generation asc limit 200`,
      values: [0, input.upperGeneration],
      index:
        /sqlite_autoindex_private_hot_updater_prisma_insights_events_\d+.*source_generation/i,
    },
    {
      query: `select event_id,received_at_ms,event_order,install_key,install_id,event_json
        from private_hot_updater_prisma_insights_events
        where received_at_ms>=? and received_at_ms<?
        order by received_at_ms desc,event_order desc limit 101`,
      values: [0, input.beforeReceivedAtMs],
      index: "private_hot_updater_prisma_insights_events_global_idx",
    },
    {
      query: `select event_id,received_at_ms,event_order,install_key,install_id,event_json
        from private_hot_updater_prisma_insights_events
        where install_key=? and type=? and received_at_ms>=?
          and received_at_ms<?
        order by received_at_ms desc,event_order desc limit 101`,
      values: [
        prismaInsightsInstallKey(input.installId),
        "UPDATE_APPLIED",
        0,
        input.beforeReceivedAtMs,
      ],
      index: "private_hot_updater_prisma_insights_events_install_idx",
    },
    {
      query: `select install_key,install_id,event_id,received_at_ms,event_order,
          source_generation,event_json
        from private_hot_updater_prisma_insights_live
        where install_key>?
        order by install_key asc limit 101`,
      values: [Buffer.alloc(32)],
      index:
        /sqlite_autoindex_private_hot_updater_prisma_insights_live_\d+.*install_key/i,
    },
    {
      query: `select install_key,install_id,event_id,received_at_ms,event_order,event_json
        from private_hot_updater_prisma_insights_search_rows
        where job_id=? and install_key>? and event_json is not null
        order by install_key asc limit 101`,
      values: [input.searchJobId, Buffer.alloc(32)],
      index:
        /sqlite_autoindex_private_hot_updater_prisma_insights_search_rows_\d+.*job_id.*install_key/i,
    },
    {
      query: `select count_key,label,label_order,value
        from private_hot_updater_prisma_insights_report_counts
        where job_id=? and section=? and metric=? and bucket_start_ms=?
          and count_key>?
        order by count_key asc limit 200`,
      values: [
        input.reportJobId,
        "bundleDistribution",
        "",
        -1,
        Buffer.alloc(32),
      ],
      index: "private_hot_updater_prisma_report_counts_source_idx",
    },
    {
      query: `select ordinal,label,value
        from private_hot_updater_prisma_insights_report_order
        where job_id=? and order_kind=? and metric=? and ordinal>=?
        order by ordinal asc limit 100`,
      values: [input.reportJobId, "bundleDistribution", "", 0],
      index:
        /(?:private_hot_updater_prisma_report_order_page_idx|sqlite_autoindex_private_hot_updater_prisma_insights_report_order_\d+)/i,
    },
    {
      query: `select id from private_hot_updater_prisma_insights_search_jobs
        where state=? order by id asc limit 1`,
      values: ["queued"],
      index: "private_hot_updater_prisma_search_jobs_state_idx",
    },
    {
      query: `select id from private_hot_updater_prisma_insights_report_jobs
        where state=? order by id asc limit 1`,
      values: ["queued"],
      index: "private_hot_updater_prisma_report_jobs_state_idx",
    },
  ];
  for (const evidence of cases) {
    expectIndexedSqlitePlan(
      await explainSqlite(client, evidence.query, ...evidence.values),
      evidence.index,
    );
  }
};

beforeAll(async () => {
  generated = await generateEvidencePrismaClient(
    join(fixtureDirectory, "schema.prisma"),
    generatedClientPath,
    "file:./runtime-acceptance.db",
  );
}, 180_000);

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.$disconnect()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  await generated?.cleanup();
  generated = undefined;
}, 180_000);

const insightsFixture = createPrismaInsightsConformanceFixture({
  provider: "sqlite",
  budgets: {
    pageEvents: (input) =>
      input.selector.kind === "bundleId"
        ? (input.limit + 1) * 2
        : input.limit + 1,
    pageInstallations: (input) =>
      input.kind === "installationId" ? 1 : input.limit + 1,
    pageReport: (input) => input.limit * 8 + 16,
  },
  async createNamespace() {
    if (!generated) throw new Error("missing SQLite evidence runtime");
    const Client = generated.PrismaClient;
    const directory = await mkdtemp(
      join(tmpdir(), "prisma-required-conformance-"),
    );
    const databasePath = join(directory, "insights.db");
    let client = new Client({ datasourceUrl: `file:${databasePath}` });
    await client.$executeRawUnsafe(legacySchema);
    return {
      client,
      async reopen() {
        await client.$disconnect();
        client = new Client({ datasourceUrl: `file:${databasePath}` });
        await Reflect.get(client, "$connect").call(client);
        return client;
      },
      async dispose() {
        await client.$disconnect();
        await rm(directory, { recursive: true, force: true });
      },
    };
  },
});

afterEach(() => insightsFixture.dispose());

describe("Prisma SQLite InsightsModel shared conformance", () => {
  registerInsightsModelTests(insightsFixture.createHarness);
});

const openClient = (databasePath: string): EvidencePrismaClient => {
  if (!generated) throw new Error("missing SQLite evidence runtime");
  const client = new generated.PrismaClient({
    datasourceUrl: `file:${databasePath}`,
  });
  clients.push(client);
  assertPrismaInsightsClient(client);
  return client;
};

const createClient = async () => {
  const directory = await mkdtemp(join(tmpdir(), "prisma-insights-sqlite-"));
  directories.push(directory);
  const client = openClient(join(directory, "test.db"));
  await client.$executeRawUnsafe(legacySchema);
  return client;
};

describe("Prisma Insights SQLite evidence", () => {
  it("rejects an unexpected private catalog column", async () => {
    const client = await createClient();
    await createPrismaInsightsLayout(
      client,
      "sqlite",
      insightsDatabaseNamespace,
    );
    await expect(
      hasCompletePrismaInsightsLayout(
        client,
        "sqlite",
        insightsDatabaseNamespace,
      ),
    ).resolves.toBe(true);
    await client.$executeRawUnsafe(
      "alter table private_hot_updater_prisma_insights_report_jobs add column unexpected_value text null",
    );
    await expect(
      hasCompletePrismaInsightsLayout(
        client,
        "sqlite",
        insightsDatabaseNamespace,
      ),
    ).resolves.toBe(false);
  });

  it("accepts low and maximum shared worker budgets", async () => {
    const client = await createClient();
    await preparePrismaInsights(client, "sqlite", insightsDatabaseNamespace, {
      writersDrained: true,
    });

    await expect(
      runPrismaInsightsReportStep(client, "sqlite", {
        maxItems: 1,
        maxRequests: 1,
      }),
    ).resolves.toEqual({ processed: 0, jobId: null });
    await expect(
      runPrismaInsightsReportStep(client, "sqlite", {
        maxItems: 4_096,
        maxRequests: 4_096,
      }),
    ).resolves.toEqual({ processed: 0, jobId: null });
    await expect(
      runPrismaInsightsSearchStep(client, "sqlite", {
        maxItems: 1,
        maxRequests: 1,
      }),
    ).resolves.toEqual({ processed: 0, jobId: null });
    await expect(
      runPrismaInsightsSearchStep(client, "sqlite", {
        maxItems: 4_096,
        maxRequests: 4_096,
      }),
    ).resolves.toEqual({ processed: 0, jobId: null });
    expect(() =>
      runPrismaInsightsReportStep(client, "sqlite", {
        maxItems: 4_097,
        maxRequests: 1,
      }),
    ).toThrow("invalid-query");
  });

  it("accepts every shared maintenance budget and idles below its fixed cost", async () => {
    const client = await createClient();
    await insertLegacyEvents(client, [createBundleEventRowFixture("690", 100)]);
    await preparePrismaInsights(client, "sqlite", insightsDatabaseNamespace, {
      writersDrained: true,
    });
    const measured = captureEvidencePrismaQueries(client);
    const maintenance = createPrismaInsightsMaintenance(
      measured.client,
      "sqlite",
      insightsDatabaseNamespace,
    );

    await expect(
      maintenance.runStep({ maxItems: 1, maxRequests: 1 }),
    ).resolves.toEqual({ processed: 0, ready: false, requestsBudget: 1 });
    expect(measured.queries).toHaveLength(2);
    await expect(
      maintenance.runStep({ maxItems: 4_096, maxRequests: 4_096 }),
    ).resolves.toMatchObject({ processed: 1, ready: true });
    await expect(
      maintenance.runStep({ maxItems: 0, maxRequests: 1 }),
    ).rejects.toThrow("invalid-query");
    await expect(
      maintenance.runStep({ maxItems: 1, maxRequests: 4_097 }),
    ).rejects.toThrow("invalid-query");
  });

  it("fails sealed reports after count material or order rows are deleted", async () => {
    const client = await createClient();
    await preparePrismaInsights(client, "sqlite", insightsDatabaseNamespace, {
      writersDrained: true,
    });
    const model = createPrismaInsightsModel(
      client,
      "sqlite",
      insightsDatabaseNamespace,
    );
    const event = createBundleEventRowFixture("691", 100);
    const summaryEvent = createBundleEventRowFixture("692", 110);
    const extraEvent = createBundleEventRowFixture("693", 120);
    await model.append(event);
    await model.append(summaryEvent);
    await model.append(extraEvent);

    const complete = async (
      query:
        | { readonly kind: "installationOverview" }
        | {
            readonly kind: "bundleDetail";
            readonly bundleId: string;
            readonly window: "all";
          },
    ) => {
      let report = await model.getReport({ query });
      for (let step = 0; step < 50 && report.state !== "ready"; step += 1) {
        await runPrismaInsightsReportStep(client, "sqlite", {
          maxItems: 100,
          maxRequests: 4_096,
        });
        report = await model.getReport({ query });
      }
      expect(report.state).toBe("ready");
      if (report.state !== "ready") throw new Error("report did not publish");
      return report.data.id;
    };

    const detailQuery = {
      kind: "bundleDetail" as const,
      bundleId: event.to_bundle_id,
      window: "all" as const,
    };
    const detailId = await complete(detailQuery);
    const countRows = await client.$queryRawUnsafe<
      { bucket_start_ms: number; count_key: Uint8Array }[]
    >(
      `select bucket_start_ms,count_key from private_hot_updater_prisma_insights_report_counts
       where job_id=? and section='movementSeries' and metric='installed'`,
      detailId,
    );
    const reportRows = await client.$queryRawUnsafe<
      { as_of_ms: number; source_id: string }[]
    >(
      `select jobs.as_of_ms,source.source_id
       from private_hot_updater_prisma_insights_report_jobs jobs
       cross join private_hot_updater_prisma_insights_source source
       where jobs.id=? and source.id=1`,
      detailId,
    );
    const reportRow = reportRows[0]!;
    const projection = createInsightsReportProjection(
      detailQuery,
      Number(reportRow.as_of_ms),
    );
    const countOrdinal = Math.floor(
      (Number(countRows[0]!.bucket_start_ms) - projection.firstBucketMs!) /
        projection.bucketSizeMs,
    );
    const countPageInput = {
      publicationId: detailId,
      section: "movementSeries" as const,
      metric: "installed" as const,
      limit: 1,
      cursor: createInsightsReportPageCursor(
        {
          publicationId: detailId,
          section: "movementSeries",
          metric: "installed",
          limit: 1,
        },
        String(countOrdinal),
        reportRow.source_id,
      ),
    };
    await expect(model.pageReport(countPageInput)).resolves.toMatchObject({
      state: "ready",
      data: { data: [{ value: 1 }] },
    });
    expect(
      await client.$executeRawUnsafe(
        `delete from private_hot_updater_prisma_insights_report_seals
         where job_id=? and seal_kind='count' and seal_key=?`,
        detailId,
        countRows[0]!.count_key,
      ),
    ).toBe(1);
    expect(
      await client.$executeRawUnsafe(
        `delete from private_hot_updater_prisma_insights_report_counts
         where job_id=? and section='movementSeries' and metric='installed'`,
        detailId,
      ),
    ).toBe(1);
    await expect(model.pageReport(countPageInput)).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    await expect(
      model.getReport({ query: detailQuery }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });

    const summaryQuery = {
      kind: "bundleDetail" as const,
      bundleId: summaryEvent.to_bundle_id,
      window: "all" as const,
    };
    const summaryId = await complete(summaryQuery);
    const summaryRows = await client.$queryRawUnsafe<
      { count_key: Uint8Array }[]
    >(
      `select count_key from private_hot_updater_prisma_insights_report_counts
       where job_id=? and section='summary' and metric='installed' and label=?`,
      summaryId,
      summaryEvent.to_bundle_id,
    );
    expect(summaryRows).toHaveLength(1);
    expect(
      await client.$executeRawUnsafe(
        `delete from private_hot_updater_prisma_insights_report_seals
         where job_id=? and seal_kind='count' and seal_key=?`,
        summaryId,
        summaryRows[0]!.count_key,
      ),
    ).toBe(1);
    expect(
      await client.$executeRawUnsafe(
        `delete from private_hot_updater_prisma_insights_report_counts
         where job_id=? and count_key=?`,
        summaryId,
        summaryRows[0]!.count_key,
      ),
    ).toBe(1);
    await expect(
      model.getReport({ query: summaryQuery }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });

    const extraQuery = {
      kind: "bundleDetail" as const,
      bundleId: extraEvent.to_bundle_id,
      window: "all" as const,
    };
    const extraId = await complete(extraQuery);
    const extraKey = prismaInsightsDigest([
      "summary",
      "recovered",
      extraEvent.to_bundle_id,
      -1,
    ]);
    const labelOrder = Buffer.alloc(extraEvent.to_bundle_id.length * 2);
    for (let index = 0; index < extraEvent.to_bundle_id.length; index += 1) {
      labelOrder.writeUInt16BE(
        extraEvent.to_bundle_id.charCodeAt(index),
        index * 2,
      );
    }
    expect(
      await client.$executeRawUnsafe(
        `insert into private_hot_updater_prisma_insights_report_counts
         (job_id,count_key,section,metric,label,label_order,bucket_start_ms,value)
         values (?,?,'summary','recovered',?,?,-1,99)`,
        extraId,
        extraKey,
        extraEvent.to_bundle_id,
        labelOrder,
      ),
    ).toBe(1);
    expect(
      await client.$executeRawUnsafe(
        `insert into private_hot_updater_prisma_insights_report_seals
         (job_id,seal_kind,seal_key,row_digest) values (?,'count',?,?)`,
        extraId,
        extraKey,
        Buffer.alloc(40),
      ),
    ).toBe(1);
    await expect(model.getReport({ query: extraQuery })).resolves.toMatchObject(
      {
        state: "failed",
        error: { code: "storage-corruption" },
      },
    );

    const overviewId = await complete({ kind: "installationOverview" });
    expect(
      await client.$executeRawUnsafe(
        `delete from private_hot_updater_prisma_insights_report_order
         where job_id=? and order_kind='bundleDistribution' and ordinal=0`,
        overviewId,
      ),
    ).toBe(1);
    await expect(
      model.pageReport({
        publicationId: overviewId,
        section: "bundleDistribution",
        limit: 10,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
  });

  it("reports an uninspectable pre-layout report without invented versions", async () => {
    const client = await createClient();

    await expect(
      createPrismaInsightsModel(
        client,
        "sqlite",
        insightsDatabaseNamespace,
      ).getReport({
        query: { kind: "installationOverview" },
      }),
    ).resolves.toEqual({
      state: "failed",
      versions: {
        schemaVersion: null,
        storageVersion: null,
        projectionGeneration: null,
        sourceGeneration: null,
      },
      error: { code: "schema-not-ready" },
    });
  });

  it("keeps append available while a captured legacy prefix is backfilled", async () => {
    const client = await createClient();
    const legacy = createBundleEventRowFixture("799", 100);
    await insertLegacyEvents(client, [legacy]);

    expect(
      await preparePrismaInsights(client, "sqlite", insightsDatabaseNamespace, {
        writersDrained: true,
      }),
    ).toEqual({ ready: false });

    const model = createPrismaInsightsModel(
      client,
      "sqlite",
      insightsDatabaseNamespace,
    );
    const afterCutover = createBundleEventRowFixture("702", 200);
    await model.append(afterCutover);
    expect(
      await createPrismaInsightsMaintenance(
        client,
        "sqlite",
        insightsDatabaseNamespace,
      ).runStep({
        maxItems: 100,
        maxRequests: 1_000,
      }),
    ).toMatchObject({ processed: 2, ready: true });

    const events = await model.pageEvents({
      selector: { kind: "all" },
      sinceReceivedAtMs: 0,
      beforeReceivedAtMs: 1_000,
      limit: 10,
    });
    expect(events.state).toBe("ready");
    if (events.state !== "ready") return;
    expect(events.data.data.map(({ id }) => id)).toEqual([
      afterCutover.id,
      legacy.id,
    ]);
  });

  it("durably poisons an arbitrary noncanonical legacy ID without deleting it", async () => {
    const client = await createClient();
    for (const row of [
      createBundleEventRowFixture("703", 100),
      createBundleEventRowFixture("704", 101),
      createBundleEventRowFixture("705", 102),
      {
        ...createBundleEventRowFixture("706", 103),
        id: "legacy/non-v7",
      },
    ]) {
      await insertLegacyEvents(client, [row]);
    }
    await preparePrismaInsights(client, "sqlite", insightsDatabaseNamespace, {
      writersDrained: true,
    });

    const maintenance = createPrismaInsightsMaintenance(
      client,
      "sqlite",
      insightsDatabaseNamespace,
    );
    let processed = 0;
    let poison: unknown;
    for (let step = 0; step < 3 && poison === undefined; step += 1) {
      try {
        const result = await maintenance.runStep({
          maxItems: 2,
          maxRequests: 100,
        });
        expect(result.processed).toBeLessThanOrEqual(2);
        processed += result.processed;
      } catch (error) {
        poison = error;
      }
    }
    expect(poison).toBeInstanceOf(Error);
    expect((poison as Error).message).toBe(
      "Invalid legacy Insights event legacy/non-v7",
    );
    expect(processed).toBeLessThanOrEqual(3);

    const state = await client.$queryRawUnsafe<
      { ready: number; failed_reason: string | null }[]
    >(
      `select ready,failed_reason from private_hot_updater_prisma_insights_state where id=1`,
    );
    expect(state[0]).toEqual({
      ready: 0,
      failed_reason: "migration-poison:legacy/non-v7",
    });
    const retained = await client.$queryRawUnsafe<
      { readonly count: number | bigint }[]
    >("select count(*) as count from bundle_events");
    expect(Number(retained[0]?.count)).toBe(4);
  });

  it("deduplicates concurrent reservations and rolls back a stale fence", async () => {
    const client = await createClient();
    await preparePrismaInsights(client, "sqlite", insightsDatabaseNamespace, {
      writersDrained: true,
    });
    const model = createPrismaInsightsModel(
      client,
      "sqlite",
      insightsDatabaseNamespace,
    );
    await model.append({
      ...createBundleEventRowFixture("707", 100),
      user_id: "concurrent-user",
    });
    const input = {
      kind: "userId" as const,
      userId: "concurrent-user",
      limit: 10,
    };
    const reservations = await Promise.all([
      model.pageInstallations(input),
      model.pageInstallations(input),
    ]);
    expect(reservations).toEqual([
      expect.objectContaining({ state: "preparing" }),
      expect.objectContaining({ state: "preparing" }),
    ]);
    if (
      reservations[0]?.state !== "preparing" ||
      reservations[1]?.state !== "preparing"
    ) {
      throw new Error("concurrent reservations did not prepare");
    }
    expect(reservations[1].job.id).toBe(reservations[0].job.id);

    await client.$executeRawUnsafe(
      `create trigger private_hot_updater_prisma_insights_stale_fence
       before insert on private_hot_updater_prisma_insights_search_rows
       begin
         update private_hot_updater_prisma_insights_search_jobs
         set lease_version=lease_version+1 where id=new.job_id;
       end`,
    );
    await expect(
      runPrismaInsightsSearchStep(client, "sqlite", {
        maxItems: 10,
        maxRequests: 100,
      }),
    ).rejects.toThrow("invalid-result");
    const jobs = await client.$queryRawUnsafe<
      {
        state: string;
        lease_owner: string | null;
        lease_version: bigint | number;
        after_generation: bigint | number;
      }[]
    >(`select state,lease_owner,lease_version,after_generation
       from private_hot_updater_prisma_insights_search_jobs`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: "queued", lease_owner: null });
    expect(Number(jobs[0]?.lease_version)).toBe(0);
    expect(Number(jobs[0]?.after_generation)).toBe(0);
  });

  it("keeps failed semantic search and report jobs addressable", async () => {
    const client = await createClient();
    await preparePrismaInsights(client, "sqlite", insightsDatabaseNamespace, {
      writersDrained: true,
    });
    const model = createPrismaInsightsModel(
      client,
      "sqlite",
      insightsDatabaseNamespace,
    );
    const event = createBundleEventRowFixture("704", 100);
    await model.append(event);
    const preparing = await model.pageInstallations({
      kind: "contains",
      query: "install-704",
      limit: 10,
    });
    expect(preparing.state).toBe("preparing");
    if (preparing.state !== "preparing") return;
    expect(preparing.versions.sourceGeneration).toBe('["prisma-insights-1",1]');
    const reportPreparing = await model.getReport({
      query: { kind: "installationOverview" },
    });
    expect(reportPreparing.state).toBe("preparing");
    if (reportPreparing.state !== "preparing") return;
    expect(reportPreparing.versions.sourceGeneration).toBe(
      preparing.versions.sourceGeneration,
    );
    await client.$executeRawUnsafe(
      `update private_hot_updater_prisma_insights_events
       set event_json='{}' where event_id=?`,
      event.id,
    );
    await runPrismaInsightsSearchStep(client, "sqlite", {
      maxItems: 100,
      maxRequests: 1_000,
    });
    await runPrismaInsightsReportStep(client, "sqlite", {
      maxItems: 100,
      maxRequests: 4_000,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await model.pageInstallations({
        kind: "contains",
        query: "install-704",
        limit: 10,
      });
      expect(failed).toMatchObject({
        state: "failed",
        error: {
          code: "preparation-failed",
          jobId: preparing.job.id,
        },
      });
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        model.getReport({ query: { kind: "installationOverview" } }),
      ).resolves.toMatchObject({
        state: "failed",
        error: {
          code: "migration-poison",
          jobId: reportPreparing.job.id,
        },
      });
    }
  });

  it(
    "migrates and drains 50,001 native rows across reopen with bounded plans",
    { timeout: 1_800_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "prisma-scale-sqlite-"));
      directories.push(directory);
      const databasePath = join(directory, "scale.db");
      let client = openClient(databasePath);
      await client.$executeRawUnsafe(legacySchema);

      for (let offset = 1; offset <= 50_001; offset += 50) {
        const size = Math.min(50, 50_002 - offset);
        const data = Array.from({ length: size }, (_, index) => {
          const value = offset + index;
          return {
            ...createBundleEventRowFixture(String(value), value),
            user_id: "scale-user",
            username: `Scale installation ${value}`,
          };
        });
        await expect(insertLegacyEvents(client, data)).resolves.toBe(size);
      }

      expect(
        await preparePrismaInsights(
          client,
          "sqlite",
          insightsDatabaseNamespace,
          {
            writersDrained: true,
          },
        ),
      ).toEqual({ ready: false });
      const sourceBefore = await client.$queryRawUnsafe<
        { readonly source_id: string }[]
      >(
        `select source_id from private_hot_updater_prisma_insights_source
         where id=1`,
      );
      expect(sourceBefore).toHaveLength(1);

      let maintenance = createPrismaInsightsMaintenance(
        client,
        "sqlite",
        insightsDatabaseNamespace,
      );
      let migrated = 0;
      let ready = false;
      const writer = {
        ...createBundleEventRowFixture("99001", 60_000),
        user_id: "writer-user",
        username: "Writer during SQLite backfill",
      };
      for (let step = 0; step < 400 && !ready; step += 1) {
        const result = await maintenance.runStep({
          maxItems: 200,
          maxRequests: 2_004,
        });
        expect(result.processed).toBeLessThanOrEqual(200);
        migrated += result.processed;
        ready = result.ready;
        if (step === 72) {
          expect(ready).toBe(false);
          expect(migrated).toBeGreaterThan(0);
          expect(migrated).toBeLessThan(50_001);
          await client.$disconnect();
          client = openClient(databasePath);
          await Reflect.get(client, "$connect").call(client);
          await expect(
            client.$queryRawUnsafe(
              `select source_id
               from private_hot_updater_prisma_insights_source where id=1`,
            ),
          ).resolves.toEqual(sourceBefore);
          maintenance = createPrismaInsightsMaintenance(
            client,
            "sqlite",
            insightsDatabaseNamespace,
          );
          const [concurrentResult] = await Promise.all([
            maintenance.runStep({
              maxItems: 200,
              maxRequests: 2_004,
            }),
            createPrismaInsightsModel(
              client,
              "sqlite",
              insightsDatabaseNamespace,
            ).append(writer),
          ]);
          expect(concurrentResult.processed).toBeLessThanOrEqual(200);
          expect(concurrentResult.ready).toBe(false);
          migrated += concurrentResult.processed;
          ready = concurrentResult.ready;
          expect(migrated).toBeLessThan(50_001);
          const state = await client.$queryRawUnsafe<
            { readonly ready: number }[]
          >(
            `select ready from private_hot_updater_prisma_insights_state
             where id=1`,
          );
          expect(state).toEqual([{ ready: 0 }]);
        }
      }
      expect({ migrated, ready }).toEqual({ migrated: 50_001, ready: true });

      const counts = await client.$queryRawUnsafe<
        {
          readonly legacy_count: bigint | number;
          readonly raw_count: bigint | number;
          readonly event_count: bigint | number;
          readonly live_count: bigint | number;
          readonly source_generation: bigint | number;
        }[]
      >(`select
        (select count(*) from bundle_events where user_id='scale-user') as legacy_count,
        (select count(*) from bundle_events) as raw_count,
        (select count(*) from private_hot_updater_prisma_insights_events) as event_count,
        (select count(*) from private_hot_updater_prisma_insights_live) as live_count,
        (select generation from private_hot_updater_prisma_insights_source where id=1) as source_generation`);
      expect(
        Object.fromEntries(
          Object.entries(counts[0] ?? {}).map(([key, value]) => [
            key,
            Number(value),
          ]),
        ),
      ).toEqual({
        legacy_count: 50_001,
        raw_count: 50_002,
        event_count: 50_002,
        live_count: 50_002,
        source_generation: 50_002,
      });

      const captured = captureEvidencePrismaQueries(client);
      const capturedModel = createPrismaInsightsModel(
        captured.client,
        "sqlite",
        insightsDatabaseNamespace,
      );
      const eventIds = new Set<string>();
      let eventCursor: string | undefined;
      let finalEventCursor: string | null = null;
      let previousEvent:
        | { readonly id: string; readonly receivedAtMs: number }
        | undefined;
      let eventPages = 0;
      for (; eventPages < 502; eventPages += 1) {
        const page = await capturedModel.pageEvents({
          selector: { kind: "all" },
          sinceReceivedAtMs: 0,
          beforeReceivedAtMs: 100_000,
          limit: 100,
          ...(eventCursor === undefined ? {} : { cursor: eventCursor }),
        });
        expect(page.state).toBe("ready");
        if (page.state !== "ready") return;
        expect(page.data.data).toHaveLength(
          Math.min(100, 50_002 - eventIds.size),
        );
        for (const row of page.data.data) {
          if (previousEvent) {
            expect(
              previousEvent.receivedAtMs > row.received_at_ms ||
                (previousEvent.receivedAtMs === row.received_at_ms &&
                  previousEvent.id > row.id),
            ).toBe(true);
          }
          expect(eventIds.has(row.id)).toBe(false);
          eventIds.add(row.id);
          previousEvent = { id: row.id, receivedAtMs: row.received_at_ms };
        }
        finalEventCursor = page.data.nextCursor;
        if (finalEventCursor === null) {
          eventPages += 1;
          break;
        }
        eventCursor = finalEventCursor;
      }
      expect({ eventPages, finalEventCursor, size: eventIds.size }).toEqual({
        eventPages: 501,
        finalEventCursor: null,
        size: 50_002,
      });
      for (let value = 1; value <= 50_001; value += 1) {
        expect(
          eventIds.has(createBundleEventRowFixture(String(value), value).id),
        ).toBe(true);
      }
      expect(eventIds.has(writer.id)).toBe(true);
      expect(captured.queries.some((query) => /\boffset\b/i.test(query))).toBe(
        false,
      );

      captured.queries.length = 0;
      const installIds = new Set<string>();
      let installationCursor: string | undefined;
      let finalInstallationCursor: string | null = null;
      let installationPages = 0;
      for (; installationPages < 502; installationPages += 1) {
        const page = await capturedModel.pageInstallations({
          kind: "all",
          limit: 100,
          ...(installationCursor === undefined
            ? {}
            : { cursor: installationCursor }),
        });
        expect(page.state).toBe("ready");
        if (page.state !== "ready") return;
        expect(page.data.data).toHaveLength(
          Math.min(100, 50_002 - installIds.size),
        );
        for (const row of page.data.data) {
          expect(installIds.has(row.install_id)).toBe(false);
          installIds.add(row.install_id);
        }
        finalInstallationCursor = page.data.nextCursor;
        if (finalInstallationCursor === null) {
          installationPages += 1;
          break;
        }
        installationCursor = finalInstallationCursor;
      }
      expect({
        installationPages,
        finalInstallationCursor,
        size: installIds.size,
      }).toEqual({
        installationPages: 501,
        finalInstallationCursor: null,
        size: 50_002,
      });
      for (let value = 1; value <= 50_001; value += 1) {
        expect(installIds.has(`install-${value}`)).toBe(true);
      }
      expect(installIds.has(writer.install_id)).toBe(true);
      expect(captured.queries.some((query) => /\boffset\b/i.test(query))).toBe(
        false,
      );

      const model = createPrismaInsightsModel(
        client,
        "sqlite",
        insightsDatabaseNamespace,
      );
      let search = await model.pageInstallations({
        kind: "userId",
        userId: "scale-user",
        limit: 100,
      });
      expect(search.state).toBe("preparing");
      if (search.state !== "preparing") return;
      const searchJobId = search.job.id;
      for (let step = 0; step < 600 && search.state !== "ready"; step += 1) {
        await runPrismaInsightsSearchStep(client, "sqlite", {
          jobId: searchJobId,
          maxItems: 200,
          maxRequests: 2_000,
        });
        search = await model.pageInstallations({
          kind: "userId",
          userId: "scale-user",
          limit: 100,
        });
      }
      expect(search.state).toBe("ready");
      if (search.state !== "ready") return;
      expect(search.data.data).toHaveLength(100);
      expect(search.data.hasNext).toBe(true);
      expect(search.data.total).toEqual({
        state: "exact",
        value: 50_001,
        sourceGeneration: '["prisma-insights-1",50002]',
      });

      let report = await model.getReport({
        query: { kind: "installationOverview" },
      });
      expect(report.state).toBe("preparing");
      if (report.state !== "preparing") return;
      const reportJobId = report.job.id;
      let reportSourceProcessed = 0;
      let reportState:
        | {
            readonly phase: string;
            readonly source_generation: bigint | number;
          }
        | undefined;
      for (let step = 0; step < 300; step += 1) {
        const progress = await runPrismaInsightsReportStep(client, "sqlite", {
          jobId: reportJobId,
          maxItems: 200,
          maxRequests: 4_000,
        });
        reportSourceProcessed += progress.processed;
        const rows = await client.$queryRawUnsafe<
          {
            readonly phase: string;
            readonly source_generation: bigint | number;
          }[]
        >(
          `select phase,source_generation
           from private_hot_updater_prisma_insights_report_jobs where id=?`,
          reportJobId,
        );
        reportState = rows[0];
        if (reportState?.phase !== "source") break;
      }
      expect(reportSourceProcessed).toBe(50_002);
      expect(reportState).toEqual({
        phase: "installations",
        source_generation: 50_002,
      });
      const reportLatest = await client.$queryRawUnsafe<
        { readonly value: bigint | number }[]
      >(
        `select count(*) as value
         from private_hot_updater_prisma_insights_report_latest
         where job_id=? and bucket_index=-1`,
        reportJobId,
      );
      expect(Number(reportLatest[0]?.value)).toBe(50_002);

      await assertSqlitePlanMatrix(client, {
        lowerLegacyId: createBundleEventRowFixture("1", 1).id,
        upperLegacyId: createBundleEventRowFixture("50001", 50_001).id,
        installId: "install-25000",
        searchJobId,
        reportJobId,
        upperGeneration: 50_002,
        beforeReceivedAtMs: 100_000,
      });
    },
  );

  it("uses indexed physical plans for every bounded Insights page", async () => {
    const client = await createClient();
    await preparePrismaInsights(client, "sqlite", insightsDatabaseNamespace, {
      writersDrained: true,
    });
    const model = createPrismaInsightsModel(
      client,
      "sqlite",
      insightsDatabaseNamespace,
    );
    const first = {
      ...createBundleEventRowFixture("751", 100),
      user_id: "plan-user",
      username: "Plan account one",
    };
    const second = {
      ...createBundleEventRowFixture("752", 200),
      user_id: "plan-user",
      username: "Plan account two",
    };
    await model.append(first);
    await model.append(second);

    let search = await model.pageInstallations({
      kind: "contains",
      query: "plan-user",
      limit: 10,
    });
    for (let step = 0; step < 10 && search.state !== "ready"; step += 1) {
      await runPrismaInsightsSearchStep(client, "sqlite", {
        maxItems: 100,
        maxRequests: 1_000,
      });
      search = await model.pageInstallations({
        kind: "contains",
        query: "plan-user",
        limit: 10,
      });
    }
    expect(search.state).toBe("ready");
    if (search.state !== "ready") return;
    const searchJobId = search.data.consistency.cutoff.publication.id;

    let report = await model.getReport({
      query: { kind: "installationOverview" },
    });
    for (let step = 0; step < 20 && report.state !== "ready"; step += 1) {
      await runPrismaInsightsReportStep(client, "sqlite", {
        maxItems: 100,
        maxRequests: 4_000,
      });
      report = await model.getReport({
        query: { kind: "installationOverview" },
      });
    }
    expect(report.state).toBe("ready");
    if (report.state !== "ready") return;
    const reportJobId = report.data.id;

    const queuedSearch = await model.pageInstallations({
      kind: "contains",
      query: "queued-plan-search",
      limit: 10,
    });
    expect(queuedSearch.state).toBe("preparing");
    const queuedReport = await model.getReport({
      query: { kind: "activeOverview", window: "24h" },
    });
    expect(queuedReport.state).toBe("preparing");

    await assertSqlitePlanMatrix(client, {
      lowerLegacyId: first.id,
      upperLegacyId: second.id,
      installId: first.install_id,
      searchJobId,
      reportJobId,
      upperGeneration: 2,
      beforeReceivedAtMs: 1_000,
    });
  });
});
