import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerInsightsModelTests } from "@hot-updater/test-utils";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../../../test-utils/src/databaseTestFixtures";
import { assertPrismaInsightsClient } from "./client";
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
  PRISMA_INSIGHTS_EVENTS,
  PRISMA_INSIGHTS_LIVE,
  PRISMA_INSIGHTS_MIGRATION_INDEX,
  PRISMA_INSIGHTS_REPORT_COUNTS,
  PRISMA_INSIGHTS_REPORT_JOBS,
  PRISMA_INSIGHTS_REPORT_ORDER,
  PRISMA_INSIGHTS_SEARCH_JOBS,
  PRISMA_INSIGHTS_SEARCH_ROWS,
} from "./schema";
import { runPrismaInsightsSearchStep } from "./search";

const insightsDatabaseNamespace = "00000000-0000-7000-8000-00000000d002";

const databaseUrl = process.env.PRISMA_INSIGHTS_POSTGRES_URL;
const fixtureDirectory = fileURLToPath(
  new URL("./fixtures/postgresql", import.meta.url),
);
const generatedClientPath = join(
  fixtureDirectory,
  `runtime-acceptance-${process.pid}-${randomUUID()}`,
);
let generated: GeneratedEvidenceClient | undefined;

type PostgreSQLNamespace = {
  readonly client: EvidencePrismaClient;
  reopen(): Promise<EvidencePrismaClient>;
  dispose(): Promise<void>;
};

const namespaces = new Set<PostgreSQLNamespace>();

beforeAll(async () => {
  if (!databaseUrl) return;
  generated = await generateEvidencePrismaClient(
    join(fixtureDirectory, "schema.prisma"),
    generatedClientPath,
    databaseUrl,
  );
}, 180_000);

afterEach(async () => {
  await conformance.dispose();
  await Promise.all([...namespaces].map((namespace) => namespace.dispose()));
  namespaces.clear();
});

afterAll(async () => {
  await generated?.cleanup();
  generated = undefined;
}, 180_000);

const createNamespace = async (): Promise<PostgreSQLNamespace> => {
  if (!databaseUrl || !generated) {
    throw new Error("missing PostgreSQL evidence runtime");
  }
  const Client = generated.PrismaClient;
  const schema = `prisma_insights_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ datasourceUrl: databaseUrl });
  await admin.$executeRawUnsafe(`create schema "${schema}"`);
  const url = new URL(databaseUrl);
  url.searchParams.set("schema", schema);
  let client = new Client({ datasourceUrl: url.toString() });
  await client.$executeRawUnsafe(`create table bundle_events (
    id text primary key, type text not null, install_id text not null,
    user_id text null, username text null, from_release_id text null,
    from_bundle_id text null, to_release_id text null,
    to_bundle_id text not null, platform text not null,
    app_version text not null, channel text not null, cohort text not null,
    update_strategy text null, fingerprint_hash text null,
    sdk_version text null, received_at_ms double precision not null
  )`);
  assertPrismaInsightsClient(client);
  let disposed = false;
  const namespace: PostgreSQLNamespace = {
    client,
    async reopen() {
      await client.$disconnect();
      client = new Client({ datasourceUrl: url.toString() });
      await Reflect.get(client, "$connect").call(client);
      return client;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await client.$disconnect();
      await admin.$executeRawUnsafe(`drop schema "${schema}" cascade`);
      await admin.$disconnect();
    },
  };
  namespaces.add(namespace);
  return namespace;
};

const conformance = createPrismaInsightsConformanceFixture({
  provider: "postgresql",
  createNamespace,
  budgets: {
    pageEvents: (input) =>
      input.selector.kind === "all" ? input.limit + 1 : (input.limit + 1) * 2,
    pageInstallations: (input) =>
      input.kind === "installationId" ? 1 : input.limit + 1,
    pageReport: (input) => input.limit * 8 + 16,
  },
});

type PostgreSQLPlanNode = Readonly<Record<string, unknown>>;

const planNodes = (node: PostgreSQLPlanNode): PostgreSQLPlanNode[] => {
  const children = Array.isArray(node.Plans)
    ? node.Plans.filter(
        (value): value is PostgreSQLPlanNode =>
          typeof value === "object" && value !== null,
      )
    : [];
  return [node, ...children.flatMap(planNodes)];
};

const explain = async (
  prisma: EvidencePrismaClient,
  query: string,
): Promise<PostgreSQLPlanNode[]> => {
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `explain (analyze, buffers, format json) ${query}`,
  );
  const value = rows[0]?.["QUERY PLAN"];
  if (!Array.isArray(value)) throw new Error("missing PostgreSQL JSON plan");
  const root = value[0];
  if (typeof root !== "object" || root === null)
    throw new Error("missing PostgreSQL plan root");
  const plan = Reflect.get(root, "Plan");
  if (typeof plan !== "object" || plan === null)
    throw new Error("missing PostgreSQL plan node");
  return planNodes(plan as PostgreSQLPlanNode);
};

const expectBoundedIndexPlan = async (
  prisma: EvidencePrismaClient,
  evidence: {
    readonly name: string;
    readonly query: string;
    readonly relation: string;
    readonly indexes: readonly (string | RegExp)[];
    readonly limit: number;
  },
): Promise<void> => {
  const nodes = await explain(prisma, evidence.query);
  const indexes = nodes.flatMap((node) =>
    typeof node["Index Name"] === "string"
      ? [node["Index Name"] as string]
      : [],
  );
  const matchesExpectedIndex = indexes.some((name) =>
    evidence.indexes.some((expected) =>
      typeof expected === "string" ? name === expected : expected.test(name),
    ),
  );
  expect(matchesExpectedIndex, `${evidence.name}: ${indexes.join(", ")}`).toBe(
    true,
  );
  expect(
    nodes.some(
      (node) =>
        node["Node Type"] === "Seq Scan" &&
        node["Relation Name"] === evidence.relation,
    ),
    `${evidence.name}: target relation must not use a sequential scan`,
  ).toBe(false);
  expect(
    nodes.some((node) => node["Node Type"] === "Sort"),
    `${evidence.name}: matching index must preserve page order`,
  ).toBe(false);
  const limit = nodes.find((node) => node["Node Type"] === "Limit");
  expect(limit, `${evidence.name}: plan must retain LIMIT`).toBeDefined();
  expect(Number(limit?.["Actual Rows"]), evidence.name).toBeLessThanOrEqual(
    evidence.limit,
  );
  expect(
    nodes.some(
      (node) => "Shared Hit Blocks" in node || "Shared Read Blocks" in node,
    ),
    `${evidence.name}: BUFFERS evidence is missing`,
  ).toBe(true);
};

const scaleId = (value: number, variant = "8"): string =>
  `00000000-0000-7000-${variant}000-${String(value).padStart(12, "0")}`;

const insertScaleLegacyRows = (prisma: EvidencePrismaClient) =>
  prisma.$executeRawUnsafe(`insert into bundle_events (
    id,type,install_id,user_id,username,from_release_id,from_bundle_id,
    to_release_id,to_bundle_id,platform,app_version,channel,cohort,
    update_strategy,fingerprint_hash,sdk_version,received_at_ms)
  select '00000000-0000-7000-8000-'||lpad(value::text,12,'0'),
    'UPDATE_APPLIED','scale-install-'||value,'scale-user',
    'Scale installation '||value,null,
    '00000000-0000-7000-9000-'||lpad((100000+value)::text,12,'0'),null,
    '00000000-0000-7000-a000-'||lpad((200000+value)::text,12,'0'),
    'ios','1.0.0','production','0','appVersion',null,null,
    value::double precision from generate_series(1,50001) as value`);

const finishScaleMigration = async (
  namespace: PostgreSQLNamespace,
  initialClient: EvidencePrismaClient,
): Promise<{
  readonly client: EvidencePrismaClient;
  readonly writerId: string;
}> => {
  let client = initialClient;
  let processed = 0;
  let appended = false;
  const writer = {
    ...createBundleEventRowFixture("9801", 60_000),
    id: "10000000-0000-7000-8000-000000009801",
    install_id: "scale-writer-installation",
    user_id: "scale-writer",
  };
  for (let step = 1; step <= 300; step += 1) {
    const maintenance = createPrismaInsightsMaintenance(
      client,
      "postgresql",
      insightsDatabaseNamespace,
    );
    const result =
      step === 74
        ? (
            await Promise.all([
              maintenance.runStep({ maxItems: 200, maxRequests: 2_004 }),
              createPrismaInsightsModel(
                client,
                "postgresql",
                insightsDatabaseNamespace,
              ).append(writer),
            ])
          )[0]
        : await maintenance.runStep({
            maxItems: 200,
            maxRequests: 2_004,
          });
    if (step === 74) appended = true;
    expect(result.processed).toBeLessThanOrEqual(200);
    expect(result.requestsBudget).toBe(2_004);
    processed += result.processed;
    if (step === 73) {
      expect(result.ready).toBe(false);
      expect(processed).toBe(14_600);
      const source = await client.$queryRawUnsafe<{ source_id: string }[]>(
        "select source_id from private_hot_updater_prisma_insights_source where id=1",
      );
      client = await namespace.reopen();
      await expect(
        client.$queryRawUnsafe(
          "select source_id from private_hot_updater_prisma_insights_source where id=1",
        ),
      ).resolves.toEqual(source);
    }
    if (result.ready) {
      expect(processed).toBe(50_001);
      expect(appended).toBe(true);
      return { client, writerId: writer.id };
    }
  }
  throw new Error("PostgreSQL scale migration exceeded 300 bounded steps");
};

const drainScaleCursor = async (
  read: (cursor: string | undefined) => Promise<{
    readonly ids: readonly string[];
    readonly next: string | null;
  }>,
): Promise<Set<string>> => {
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  for (; pages < 502; pages += 1) {
    const page = await read(cursor);
    expect(page.ids).toHaveLength(page.next === null ? 2 : 100);
    for (const id of page.ids) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    if (page.next === null) {
      pages += 1;
      break;
    }
    cursor = page.next;
  }
  expect(pages).toBe(501);
  expect(seen.size).toBe(50_002);
  return seen;
};

const finishScaleSearch = async (
  client: EvidencePrismaClient,
): Promise<string> => {
  const model = createPrismaInsightsModel(
    client,
    "postgresql",
    insightsDatabaseNamespace,
  );
  const read = () =>
    model.pageInstallations({
      kind: "userId",
      userId: "scale-user",
      limit: 100,
    });
  let result = await read();
  if (result.state !== "preparing")
    throw new Error(`unexpected initial search state ${result.state}`);
  const jobId = result.job.id;
  for (let step = 0; step < 800 && result.state !== "ready"; step += 1) {
    const progress = await runPrismaInsightsSearchStep(client, "postgresql", {
      maxItems: 200,
      maxRequests: 2_000,
      jobId,
    });
    expect(progress.jobId).toBe(jobId);
    result = await read();
  }
  if (result.state !== "ready")
    throw new Error(`search did not become ready: ${result.state}`);
  expect(result.data.data).toHaveLength(100);
  expect(result.data.hasNext).toBe(true);
  expect(result.data.total).toMatchObject({ state: "exact", value: 50_001 });
  const rows = await client.$queryRawUnsafe<{ count: bigint }[]>(
    `select count(*) as count from ${PRISMA_INSIGHTS_SEARCH_ROWS}
     where job_id=$1 and event_json is not null`,
    jobId,
  );
  expect(rows).toEqual([{ count: 50_001n }]);
  const cutoff = result.data.consistency.cutoff;
  if (cutoff.kind !== "publication")
    throw new Error(`unexpected search cutoff ${cutoff.kind}`);
  return cutoff.publication.id;
};

const consumeScaleReportSource = async (
  client: EvidencePrismaClient,
): Promise<void> => {
  const report = await createPrismaInsightsModel(
    client,
    "postgresql",
    insightsDatabaseNamespace,
  ).getReport({
    query: {
      kind: "bundleSummaries",
      bundleIds: ["ffffffff-ffff-7fff-8fff-ffffffffffff"],
      window: "all",
    },
  });
  if (report.state !== "preparing")
    throw new Error(`unexpected initial report state ${report.state}`);
  const jobId = report.job.id;
  let consumed = 0;
  let phase = "source";
  for (let step = 0; step < 300 && phase === "source"; step += 1) {
    const progress = await runPrismaInsightsReportStep(client, "postgresql", {
      maxItems: 200,
      maxRequests: 4_000,
      jobId,
    });
    expect(progress.jobId).toBe(jobId);
    consumed += progress.processed;
    const rows = await client.$queryRawUnsafe<
      {
        after_generation: bigint;
        phase: string;
        source_generation: bigint;
        state: string;
      }[]
    >(
      `select state,phase,source_generation,after_generation
       from ${PRISMA_INSIGHTS_REPORT_JOBS} where id=$1`,
      jobId,
    );
    phase = rows[0]?.phase ?? "missing";
    if (phase !== "source") {
      expect(rows[0]).toEqual({
        after_generation: 50_002n,
        phase: "members",
        source_generation: 50_002n,
        state: "preparing",
      });
    }
  }
  expect(consumed).toBe(50_002);
  expect(phase).toBe("members");
};

const seedScalePlanRows = async (
  client: EvidencePrismaClient,
): Promise<void> => {
  const statements = [
    `insert into ${PRISMA_INSIGHTS_REPORT_COUNTS}
      (job_id,count_key,section,metric,label,label_order,bucket_start_ms,value)
     select 'plan-report',decode(lpad(to_hex(value),64,'0'),'hex'),
       case when value%2=0 then 'bundleDistribution' else 'other' end,'',
       'bundle-'||value,decode(lpad(to_hex(value),64,'0'),'hex'),-1,1
     from generate_series(1,50001) as value`,
    `insert into ${PRISMA_INSIGHTS_REPORT_ORDER}
      (job_id,order_kind,metric,ordinal,label,value)
     select 'plan-report','bundleDistribution','',value,'bundle-'||value,1
     from generate_series(1,50001) as value`,
    `insert into ${PRISMA_INSIGHTS_SEARCH_JOBS}
      (id,query_key,query_json,state,phase,source_generation,as_of_ms,
       completed_at_ms,after_generation,total,failure_json,lease_owner,
       lease_version)
     select '20000000-0000-7000-8000-'||lpad(value::text,12,'0'),
       decode(lpad(to_hex(value),64,'0'),'hex'),'{}',
       case when value=50001 then 'queued' else 'ready' end,'membership',
       50002,0,null,0,0,null,null,0
     from generate_series(1,50001) as value`,
    `insert into ${PRISMA_INSIGHTS_REPORT_JOBS}
      (id,query_key,query_json,state,phase,source_generation,as_of_ms,
       completed_at_ms,after_generation,after_key,order_phase,
       order_totals_json,publication_json,failure_json,lease_owner,
       lease_version)
     select '30000000-0000-7000-8000-'||lpad(value::text,12,'0'),
       decode(lpad(to_hex(value),64,'0'),'hex'),'{}',
       case when value=50001 then 'queued' else 'ready' end,'source',
       50002,0,null,0,null,0,'{}',null,null,null,0
     from generate_series(1,50001) as value`,
  ];
  for (const statement of statements) {
    await client.$executeRawUnsafe(statement);
  }
  await client.$executeRawUnsafe(
    `analyze bundle_events,${PRISMA_INSIGHTS_EVENTS},${PRISMA_INSIGHTS_LIVE},
       ${PRISMA_INSIGHTS_SEARCH_ROWS},${PRISMA_INSIGHTS_REPORT_COUNTS},
       ${PRISMA_INSIGHTS_REPORT_ORDER},${PRISMA_INSIGHTS_SEARCH_JOBS},
       ${PRISMA_INSIGHTS_REPORT_JOBS}`,
  );
};

const postgresBytes = (value: Uint8Array): string =>
  `decode('${Buffer.from(value).toString("hex")}','hex')`;

const assertScalePlanMatrix = async (
  client: EvidencePrismaClient,
  installKey: Uint8Array,
  publicationId: string,
): Promise<void> => {
  const evidence = [
    {
      name: "legacy keyset page",
      query: `select id,type,install_id,user_id,username,from_release_id,
        from_bundle_id,to_release_id,to_bundle_id,platform,app_version,
        channel,cohort,update_strategy,fingerprint_hash,sdk_version,
        received_at_ms from bundle_events
        where id collate "C">'${scaleId(100)}' collate "C"
          and id collate "C"<='${scaleId(50_001)}' collate "C"
        order by id collate "C" asc limit 200`,
      relation: "bundle_events",
      indexes: [PRISMA_INSIGHTS_MIGRATION_INDEX],
      limit: 200,
    },
    {
      name: "source generation worker page",
      query: `select source_generation,event_json from ${PRISMA_INSIGHTS_EVENTS}
        where source_generation>100 and source_generation<=50002
        order by source_generation asc limit 200`,
      relation: PRISMA_INSIGHTS_EVENTS,
      indexes: [
        "private_hot_updater_prisma_insights_event_source_generation_key",
      ],
      limit: 200,
    },
    {
      name: "global event page",
      query: `select event_id,received_at_ms,event_order,install_key,
        install_id,event_json from ${PRISMA_INSIGHTS_EVENTS}
        where received_at_ms>=0 and received_at_ms<100000
        order by received_at_ms desc,event_order desc limit 101`,
      relation: PRISMA_INSIGHTS_EVENTS,
      indexes: ["private_hot_updater_prisma_insights_events_global_idx"],
      limit: 101,
    },
    {
      name: "installation event page",
      query: `select event_id,received_at_ms,event_order,install_key,
        install_id,event_json from ${PRISMA_INSIGHTS_EVENTS}
        where install_key=${postgresBytes(installKey)}
          and type='UPDATE_APPLIED' and received_at_ms>=0
          and received_at_ms<100000
        order by received_at_ms desc,event_order desc limit 101`,
      relation: PRISMA_INSIGHTS_EVENTS,
      indexes: ["private_hot_updater_prisma_insights_events_install_idx"],
      limit: 101,
    },
    {
      name: "live installation key page",
      query: `select install_key,install_id,event_id,received_at_ms,event_order,
        source_generation,event_json from ${PRISMA_INSIGHTS_LIVE}
        where install_key>${postgresBytes(Buffer.alloc(32))}
        order by install_key asc limit 101`,
      relation: PRISMA_INSIGHTS_LIVE,
      indexes: [`${PRISMA_INSIGHTS_LIVE}_pkey`],
      limit: 101,
    },
    {
      name: "search result row page",
      query: `select install_key,install_id,event_id,received_at_ms,event_order,
        event_json from ${PRISMA_INSIGHTS_SEARCH_ROWS}
        where job_id='${publicationId}'
          and install_key>${postgresBytes(Buffer.alloc(32))}
          and event_json is not null
        order by install_key asc limit 101`,
      relation: PRISMA_INSIGHTS_SEARCH_ROWS,
      indexes: [`${PRISMA_INSIGHTS_SEARCH_ROWS}_pkey`],
      limit: 101,
    },
    {
      name: "report count source page",
      query: `select count_key,label,label_order,value
        from ${PRISMA_INSIGHTS_REPORT_COUNTS}
        where job_id='plan-report' and section='bundleDistribution'
          and metric='' and bucket_start_ms=-1
          and count_key>decode(lpad(to_hex(100),64,'0'),'hex')
        order by count_key asc limit 200`,
      relation: PRISMA_INSIGHTS_REPORT_COUNTS,
      indexes: ["private_hot_updater_prisma_report_counts_source_idx"],
      limit: 200,
    },
    {
      name: "report order page",
      query: `select ordinal,label,value from ${PRISMA_INSIGHTS_REPORT_ORDER}
        where job_id='plan-report' and order_kind='bundleDistribution'
          and metric='' and ordinal>=100 order by ordinal asc limit 100`,
      relation: PRISMA_INSIGHTS_REPORT_ORDER,
      indexes: [
        "private_hot_updater_prisma_report_order_page_idx",
        `${PRISMA_INSIGHTS_REPORT_ORDER}_pkey`,
      ],
      limit: 100,
    },
    {
      name: "queued search job claim",
      query: `select id,state,lease_owner,lease_version
        from ${PRISMA_INSIGHTS_SEARCH_JOBS} where state='queued'
        order by id asc limit 1 for update skip locked`,
      relation: PRISMA_INSIGHTS_SEARCH_JOBS,
      indexes: ["private_hot_updater_prisma_search_jobs_state_idx"],
      limit: 1,
    },
    {
      name: "queued report job claim",
      query: `select id,state,lease_owner,lease_version
        from ${PRISMA_INSIGHTS_REPORT_JOBS} where state='queued'
        order by id asc limit 1 for update skip locked`,
      relation: PRISMA_INSIGHTS_REPORT_JOBS,
      indexes: ["private_hot_updater_prisma_report_jobs_state_idx"],
      limit: 1,
    },
  ] as const;
  for (const item of evidence) {
    await expectBoundedIndexPlan(client, item);
  }
};

describe.skipIf(!databaseUrl)("Prisma Insights PostgreSQL evidence", () => {
  it("rejects an unexpected private catalog column", async () => {
    const namespace = await createNamespace();
    const client = namespace.client;
    await createPrismaInsightsLayout(
      client,
      "postgresql",
      insightsDatabaseNamespace,
    );
    await expect(
      hasCompletePrismaInsightsLayout(
        client,
        "postgresql",
        insightsDatabaseNamespace,
      ),
    ).resolves.toBe(true);
    await client.$executeRawUnsafe(
      "alter table private_hot_updater_prisma_insights_report_jobs add column unexpected_value text null",
    );
    await expect(
      hasCompletePrismaInsightsLayout(
        client,
        "postgresql",
        insightsDatabaseNamespace,
      ),
    ).resolves.toBe(false);
  });

  it(
    "persists 50,001 legacy rows across reopen, concurrent append, and bounded reads",
    { timeout: 1_800_000 },
    async () => {
      const namespace = await createNamespace();
      let client = namespace.client;
      expect(await insertScaleLegacyRows(client)).toBe(50_001);
      await createPrismaInsightsLayout(
        client,
        "postgresql",
        insightsDatabaseNamespace,
      );
      await expect(
        preparePrismaInsights(client, "postgresql", insightsDatabaseNamespace, {
          writersDrained: true,
        }),
      ).resolves.toEqual({ ready: false });

      const migrated = await finishScaleMigration(namespace, client);
      client = migrated.client;
      const counts = await client.$queryRawUnsafe<
        {
          events: bigint;
          generations: bigint;
          installations: bigint;
          legacy_events: bigint;
          max_generation: bigint;
          min_generation: bigint;
          raw_events: bigint;
          source_generation: bigint;
        }[]
      >(`select
        (select count(*) from ${PRISMA_INSIGHTS_EVENTS}) as events,
        (select count(*) from ${PRISMA_INSIGHTS_LIVE}) as installations,
        (select count(distinct source_generation) from ${PRISMA_INSIGHTS_EVENTS}) as generations,
        (select min(source_generation) from ${PRISMA_INSIGHTS_EVENTS}) as min_generation,
        (select max(source_generation) from ${PRISMA_INSIGHTS_EVENTS}) as max_generation,
        (select count(*) from bundle_events) as raw_events,
        (select count(*) from bundle_events where id like '00000000-%') as legacy_events,
        (select generation from private_hot_updater_prisma_insights_source where id=1) as source_generation`);
      expect(counts[0]).toEqual({
        events: 50_002n,
        generations: 50_002n,
        installations: 50_002n,
        legacy_events: 50_001n,
        max_generation: 50_002n,
        min_generation: 1n,
        raw_events: 50_002n,
        source_generation: 50_002n,
      });

      const captured = captureEvidencePrismaQueries(client);
      const model = createPrismaInsightsModel(
        captured.client,
        "postgresql",
        insightsDatabaseNamespace,
      );
      const eventIds = await drainScaleCursor(async (cursor) => {
        const page = await model.pageEvents({
          selector: { kind: "all" },
          sinceReceivedAtMs: 0,
          beforeReceivedAtMs: 100_000,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (page.state !== "ready")
          throw new Error(`unexpected event page state ${page.state}`);
        expect(page.data.consistency).toEqual({
          kind: "live",
          cutoff: { kind: "event-time", beforeReceivedAtMs: 100_000 },
        });
        return {
          ids: page.data.data.map(({ id }) => id),
          next: page.data.nextCursor,
        };
      });
      const installationIds = await drainScaleCursor(async (cursor) => {
        const page = await model.pageInstallations({
          kind: "all",
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (page.state !== "ready")
          throw new Error(`unexpected installation page state ${page.state}`);
        expect(page.data.consistency.kind).toBe("live");
        return {
          ids: page.data.data.map(({ install_id }) => install_id),
          next: page.data.nextCursor,
        };
      });
      expect(eventIds.has(migrated.writerId)).toBe(true);
      expect(installationIds.has("scale-writer-installation")).toBe(true);
      for (let value = 1; value <= 50_001; value += 1) {
        expect(eventIds.has(scaleId(value))).toBe(true);
        expect(installationIds.has(`scale-install-${value}`)).toBe(true);
      }
      expect(captured.queries.some((query) => /\boffset\b/i.test(query))).toBe(
        false,
      );

      const publicationId = await finishScaleSearch(client);
      await consumeScaleReportSource(client);
      await seedScalePlanRows(client);
      const keys = await client.$queryRawUnsafe<{ install_key: Uint8Array }[]>(
        `select install_key from ${PRISMA_INSIGHTS_LIVE}
         where install_id='scale-install-1'`,
      );
      await assertScalePlanMatrix(client, keys[0]!.install_key, publicationId);
    },
  );
});

describe.skipIf(!databaseUrl)(
  "Prisma PostgreSQL InsightsModel shared conformance",
  () => {
    registerInsightsModelTests(conformance.createHarness);
  },
);
