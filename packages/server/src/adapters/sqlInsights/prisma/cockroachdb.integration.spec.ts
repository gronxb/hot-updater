import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerInsightsModelTests } from "@hot-updater/test-utils";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../../../test-utils/src/databaseTestFixtures";
import { assertPrismaInsightsClient } from "./client";
import { runPrismaInsightsTransaction } from "./client";
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
import {
  createPrismaInsightsLayout,
  hasCompletePrismaInsightsLayout,
  PRISMA_INSIGHTS_MIGRATION_COLUMN,
  PRISMA_INSIGHTS_MIGRATION_INDEX,
  PRISMA_INSIGHTS_REQUIRED_INDEXES,
} from "./schema";
import { runPrismaInsightsSearchStep } from "./search";

const insightsDatabaseNamespace = "00000000-0000-7000-8000-00000000d005";

const databaseUrl = process.env.PRISMA_INSIGHTS_COCKROACH_URL;
const fixtureDirectory = fileURLToPath(
  new URL("./fixtures/cockroachdb", import.meta.url),
);
const generatedClientPath = join(
  fixtureDirectory,
  `runtime-acceptance-${process.pid}-${randomUUID()}`,
);
let generated: GeneratedEvidenceClient | undefined;

interface CockroachEvidenceDatabase {
  readonly admin: EvidencePrismaClient;
  readonly clients: EvidencePrismaClient[];
  readonly schema: string;
  readonly url: string;
  disposed: boolean;
}

const evidenceDatabases = new Set<CockroachEvidenceDatabase>();

const indexOwner = (name: string): string => {
  if (name === PRISMA_INSIGHTS_MIGRATION_INDEX) return "bundle_events";
  if (name.includes("insights_events_"))
    return "private_hot_updater_prisma_insights_events";
  if (name.includes("insights_aliases_"))
    return "private_hot_updater_prisma_insights_aliases";
  if (name.includes("search_jobs_"))
    return "private_hot_updater_prisma_insights_search_jobs";
  if (name.includes("report_jobs_"))
    return "private_hot_updater_prisma_insights_report_jobs";
  if (name.includes("report_members_"))
    return "private_hot_updater_prisma_insights_report_members";
  if (name.includes("report_order_"))
    return "private_hot_updater_prisma_insights_report_order";
  if (name.includes("report_counts_"))
    return "private_hot_updater_prisma_insights_report_counts";
  if (name.includes("report_sort_"))
    return "private_hot_updater_prisma_insights_report_sort";
  throw new Error(`Unknown required CockroachDB index ${name}`);
};

const requiredIndexOwners = new Map(
  PRISMA_INSIGHTS_REQUIRED_INDEXES.map((name) => [name, indexOwner(name)]),
);

const requiredIndexColumns: Readonly<
  Record<string, readonly (readonly [string, "ASC" | "DESC"])[]>
> = {
  private_hot_updater_prisma_insights_events_global_idx: [
    ["received_at_ms", "DESC"],
    ["event_order", "DESC"],
  ],
  private_hot_updater_prisma_insights_events_install_idx: [
    ["install_key", "ASC"],
    ["type", "ASC"],
    ["received_at_ms", "DESC"],
    ["event_order", "DESC"],
  ],
  private_hot_updater_prisma_insights_events_to_bundle_idx: [
    ["type", "ASC"],
    ["to_bundle_id", "ASC"],
    ["received_at_ms", "DESC"],
    ["event_order", "DESC"],
  ],
  private_hot_updater_prisma_insights_events_from_bundle_idx: [
    ["type", "ASC"],
    ["from_bundle_id", "ASC"],
    ["received_at_ms", "DESC"],
    ["event_order", "DESC"],
  ],
  private_hot_updater_prisma_insights_aliases_source_idx: [
    ["source_generation", "ASC"],
    ["alias_key", "ASC"],
  ],
  private_hot_updater_prisma_search_jobs_state_idx: [
    ["state", "ASC"],
    ["id", "ASC"],
  ],
  private_hot_updater_prisma_report_jobs_state_idx: [
    ["state", "ASC"],
    ["id", "ASC"],
  ],
  private_hot_updater_prisma_report_members_page_idx: [
    ["job_id", "ASC"],
    ["section", "ASC"],
    ["metric", "ASC"],
    ["member_key", "ASC"],
  ],
  private_hot_updater_prisma_report_order_page_idx: [
    ["job_id", "ASC"],
    ["order_kind", "ASC"],
    ["metric", "ASC"],
    ["ordinal", "ASC"],
  ],
  private_hot_updater_prisma_report_counts_source_idx: [
    ["job_id", "ASC"],
    ["section", "ASC"],
    ["metric", "ASC"],
    ["bucket_start_ms", "ASC"],
    ["count_key", "ASC"],
  ],
  private_hot_updater_prisma_report_sort_page_idx: [
    ["job_id", "ASC"],
    ["order_kind", "ASC"],
    ["metric", "ASC"],
    ["sort_pass", "ASC"],
    ["sort_run", "ASC"],
    ["ordinal", "ASC"],
  ],
};

const quoteIdentifier = (value: string): string => `"${value}"`;

const createBundleEventsTable = (client: EvidencePrismaClient) =>
  client.$executeRawUnsafe(`create table bundle_events (
    id uuid primary key, type string not null, install_id string not null,
    user_id string null, username string null, from_release_id uuid null,
    from_bundle_id uuid null, to_release_id uuid null,
    to_bundle_id uuid not null, platform string not null,
    app_version string not null, channel string not null, cohort string not null,
    update_strategy string null, fingerprint_hash string null,
    sdk_version string null, received_at_ms float8 not null
  )`);

const createDatabase = async (): Promise<CockroachEvidenceDatabase> => {
  if (!databaseUrl || !generated) {
    throw new Error("missing CockroachDB evidence runtime");
  }
  const schema = `prisma_insights_${randomUUID().replaceAll("-", "")}`;
  const admin = new generated.PrismaClient({ datasourceUrl: databaseUrl });
  assertPrismaInsightsClient(admin);
  await admin.$executeRawUnsafe(`create schema ${quoteIdentifier(schema)}`);
  const url = new URL(databaseUrl);
  url.searchParams.set("schema", schema);
  const client = new generated.PrismaClient({ datasourceUrl: url.toString() });
  assertPrismaInsightsClient(client);
  const resource: CockroachEvidenceDatabase = {
    admin,
    clients: [client],
    schema,
    url: url.toString(),
    disposed: false,
  };
  evidenceDatabases.add(resource);
  await createBundleEventsTable(client);
  return resource;
};

const addClient = (
  resource: CockroachEvidenceDatabase,
): EvidencePrismaClient => {
  if (!generated) throw new Error("missing CockroachDB evidence runtime");
  const client = new generated.PrismaClient({ datasourceUrl: resource.url });
  assertPrismaInsightsClient(client);
  resource.clients.push(client);
  return client;
};

const disposeDatabase = async (
  resource: CockroachEvidenceDatabase,
): Promise<void> => {
  if (resource.disposed) return;
  resource.disposed = true;
  evidenceDatabases.delete(resource);
  await Promise.allSettled(
    resource.clients.map((client) => client.$disconnect()),
  );
  await resource.admin.$executeRawUnsafe(
    `drop schema if exists ${quoteIdentifier(resource.schema)} cascade`,
  );
  await resource.admin.$disconnect();
};

const insightsConformance = createPrismaInsightsConformanceFixture({
  provider: "cockroachdb",
  budgets: {
    pageEvents: (input) =>
      input.selector.kind === "all" ? input.limit + 1 : (input.limit + 1) * 2,
    pageInstallations: (input) =>
      input.kind === "installationId" ? 1 : input.limit + 1,
    pageReport: (input) => input.limit * 8 + 16,
  },
  async createNamespace() {
    const resource = await createDatabase();
    let client = resource.clients[0]!;
    return {
      client,
      async reopen() {
        await client.$disconnect();
        client = addClient(resource);
        await client.$queryRawUnsafe("select 1");
        return client;
      },
      dispose: () => disposeDatabase(resource),
    };
  },
});

const insertScaleRows = (client: EvidencePrismaClient, count = 50_001) =>
  client.$executeRawUnsafe(`insert into bundle_events (
      id,type,install_id,user_id,username,from_release_id,from_bundle_id,
      to_release_id,to_bundle_id,platform,app_version,channel,cohort,
      update_strategy,fingerprint_hash,sdk_version,received_at_ms
    )
    select
      ('00000000-0000-7000-8000-' || lpad(g::string,12,'0'))::uuid,
      'UPDATE_APPLIED', 'scale-install-' || g::string, 'scale-user',
      'Scale installation ' || g::string, null,
      ('00000000-0000-7000-9000-' || lpad((100000+g)::string,12,'0'))::uuid,
      null,
      ('00000000-0000-7000-a000-' || lpad((200000+g)::string,12,'0'))::uuid,
      'ios','1.0.0','production','0','appVersion',null,null,g::float8
    from generate_series(1,${count}) as series(g)`);

const finishScaleMigration = async (
  resource: CockroachEvidenceDatabase,
  initialClient: EvidencePrismaClient,
): Promise<{
  readonly client: EvidencePrismaClient;
  readonly processed: number;
  readonly writerId: string;
}> => {
  let client = initialClient;
  let total = 0;
  let writerId: string | undefined;
  for (let step = 0; step < 300; step += 1) {
    const result = await createPrismaInsightsMaintenance(
      client,
      "cockroachdb",
      insightsDatabaseNamespace,
    ).runStep({
      maxItems: 200,
      maxRequests: 2_004,
    });
    total += result.processed;
    if (step + 1 === 73) {
      expect(result.ready).toBe(false);
      await client.$disconnect();
      client = addClient(resource);
      await client.$queryRawUnsafe("select 1");
      const writer = {
        ...createBundleEventRowFixture("9601", 60_000),
        id: "10000000-0000-7000-8000-000000009601",
        install_id: "scale-writer-installation",
        user_id: "scale-writer",
      };
      await createPrismaInsightsModel(
        client,
        "cockroachdb",
        insightsDatabaseNamespace,
      ).append(writer);
      if (total !== 14_600) {
        throw new Error(`unexpected CockroachDB step-73 total ${total}`);
      }
      writerId = writer.id;
    }
    if (result.ready) {
      if (writerId === undefined) {
        throw new Error("CockroachDB scale writer was not appended");
      }
      return { client, processed: total, writerId };
    }
  }
  throw new Error(
    "CockroachDB migration did not finish within its bounded steps",
  );
};

const uuid = (value: number): string =>
  `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`;

const cockroachStringLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

const cockroachBytesLiteral = (value: Uint8Array): string =>
  `decode('${Buffer.from(value).toString("hex")}','hex')`;

const drainScaleEvents = async (
  client: EvidencePrismaClient,
  writerId: string,
): Promise<void> => {
  const captured = captureEvidencePrismaQueries(client);
  const model = createPrismaInsightsModel(
    captured.client,
    "cockroachdb",
    insightsDatabaseNamespace,
  );
  const seen = new Set<string>();
  let cursor: string | undefined;
  let lastCursor: string | null = null;
  let pages = 0;
  for (; pages < 502; pages += 1) {
    const page = await model.pageEvents({
      selector: { kind: "all" },
      sinceReceivedAtMs: 0,
      beforeReceivedAtMs: 100_000,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    expect(page.state).toBe("ready");
    if (page.state !== "ready") return;
    expect(page.data.consistency).toEqual({
      kind: "live",
      cutoff: { kind: "event-time", beforeReceivedAtMs: 100_000 },
    });
    for (const event of page.data.data) {
      expect(seen.has(event.id)).toBe(false);
      seen.add(event.id);
    }
    lastCursor = page.data.nextCursor;
    if (lastCursor === null) {
      pages += 1;
      break;
    }
    cursor = lastCursor;
  }
  expect(pages).toBe(501);
  expect(lastCursor).toBeNull();
  expect(seen.size).toBe(50_002);
  expect(seen.has(writerId)).toBe(true);
  for (let value = 1; value <= 50_001; value += 1) {
    expect(seen.has(uuid(value))).toBe(true);
  }
  expect(captured.queries.some((query) => /\boffset\b/i.test(query))).toBe(
    false,
  );
};

const finishSearch = async (
  client: EvidencePrismaClient,
  read: () => ReturnType<
    ReturnType<typeof createPrismaInsightsModel>["pageInstallations"]
  >,
) => {
  let result = await read();
  for (let step = 0; step < 800 && result.state !== "ready"; step += 1) {
    await runPrismaInsightsSearchStep(client, "cockroachdb", {
      maxItems: 200,
      maxRequests: 2_000,
    });
    result = await read();
  }
  return result;
};

const textFromRows = (rows: readonly Record<string, unknown>[]): string =>
  rows
    .flatMap((row) => Object.values(row))
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();

const assertCockroachBoundedPlan = async (
  client: EvidencePrismaClient,
  input: {
    readonly expectedIndexes: readonly string[];
    readonly limit: number;
    readonly query: string;
  },
): Promise<void> => {
  const plan = textFromRows(
    await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `explain analyze ${input.query}`,
    ),
  );
  expect(
    input.expectedIndexes.some((index) => plan.includes(`@${index}`)),
    plan,
  ).toBe(true);
  expect(
    plan.includes(`limit: ${input.limit}`) ||
      new RegExp(`• limit\\s+(?:│\\s+)?count: ${input.limit}\\b`).test(plan),
    plan,
  ).toBe(true);
  expect(plan).not.toContain("full scan");
  expect(plan).not.toContain("• sort");
  expect(plan).not.toContain("• top-k");
};

const seedCockroachPlanRows = async (
  client: EvidencePrismaClient,
): Promise<void> => {
  await client.$executeRawUnsafe(`insert into
    private_hot_updater_prisma_insights_report_counts
    (job_id,count_key,section,metric,label,label_order,bucket_start_ms,value)
    select 'plan-report',decode(sha256(g::string::bytes),'hex'),
      'bundleDistribution','','bundle-' || g::string,
      decode(sha256(g::string::bytes),'hex'),-1,1
    from generate_series(1,1000) as series(g)`);
  await client.$executeRawUnsafe(`insert into
    private_hot_updater_prisma_insights_report_order
    (job_id,order_kind,metric,ordinal,label,value)
    select 'plan-report','bundleDistribution','',g,'bundle-' || g::string,1
    from generate_series(0,999) as series(g)`);
  await client.$executeRawUnsafe(`insert into
    private_hot_updater_prisma_insights_search_jobs
    (id,query_key,query_json,state,phase,source_generation,as_of_ms,
     completed_at_ms,after_generation,total,failure_json,lease_owner,lease_version)
    select ('20000000-0000-7000-8000-' || lpad(g::string,12,'0')),
      decode(sha256(g::string::bytes),'hex'),'{}',
      case when g<=500 then 'queued' else 'preparing' end,
      'membership',50002,0,null,0,0,null,null,0
    from generate_series(1,1000) as series(g)`);
  await client.$executeRawUnsafe(
    "analyze private_hot_updater_prisma_insights_report_counts",
  );
  await client.$executeRawUnsafe(
    "analyze private_hot_updater_prisma_insights_report_order",
  );
  await client.$executeRawUnsafe(
    "analyze private_hot_updater_prisma_insights_search_jobs",
  );
};

const assertCockroachReadyPlanMatrix = async (
  client: EvidencePrismaClient,
  input: {
    readonly installKey: Uint8Array;
    readonly publicationId: string;
    readonly upperGeneration: number;
  },
): Promise<void> => {
  await client.$executeRawUnsafe(
    "analyze private_hot_updater_prisma_insights_events",
  );
  await client.$executeRawUnsafe(
    "analyze private_hot_updater_prisma_insights_live",
  );
  await client.$executeRawUnsafe(
    "analyze private_hot_updater_prisma_insights_search_rows",
  );
  await assertCockroachBoundedPlan(client, {
    expectedIndexes: ["private_hot_updater_prisma_insights_events_global_idx"],
    limit: 101,
    query: `select event_id from private_hot_updater_prisma_insights_events
      where received_at_ms>=0 and received_at_ms<60000
      order by received_at_ms desc,event_order desc limit 101`,
  });
  await assertCockroachBoundedPlan(client, {
    expectedIndexes: ["private_hot_updater_prisma_insights_events_install_idx"],
    limit: 101,
    query: `select event_id from private_hot_updater_prisma_insights_events
      where install_key=${cockroachBytesLiteral(input.installKey)}
        and type='UPDATE_APPLIED' and received_at_ms>=0
        and received_at_ms<60000
      order by received_at_ms desc,event_order desc limit 101`,
  });
  await assertCockroachBoundedPlan(client, {
    expectedIndexes: [
      "private_hot_updater_prisma_insights_events_source_generation_key",
    ],
    limit: 200,
    query: `select source_generation,event_json
      from private_hot_updater_prisma_insights_events
      where source_generation>100
        and source_generation<=${input.upperGeneration}
      order by source_generation asc limit 200`,
  });
  await assertCockroachBoundedPlan(client, {
    expectedIndexes: ["private_hot_updater_prisma_insights_live_pkey"],
    limit: 101,
    query: `select install_key,event_json
      from private_hot_updater_prisma_insights_live
      where install_key>${cockroachBytesLiteral(Buffer.alloc(32))}
      order by install_key asc limit 101`,
  });
  await assertCockroachBoundedPlan(client, {
    expectedIndexes: ["private_hot_updater_prisma_insights_search_rows_pkey"],
    limit: 101,
    query: `select install_key,event_json
      from private_hot_updater_prisma_insights_search_rows
      where job_id=${cockroachStringLiteral(input.publicationId)}
        and install_key>${cockroachBytesLiteral(Buffer.alloc(32))}
        and event_json is not null
      order by install_key asc limit 101`,
  });

  await seedCockroachPlanRows(client);
  await assertCockroachBoundedPlan(client, {
    expectedIndexes: ["private_hot_updater_prisma_report_counts_source_idx"],
    limit: 200,
    query: `select count_key,label,label_order,value
      from private_hot_updater_prisma_insights_report_counts@private_hot_updater_prisma_report_counts_source_idx
      where job_id='plan-report' and section='bundleDistribution'
        and metric='' and bucket_start_ms=-1
        and count_key>${cockroachBytesLiteral(Buffer.alloc(32))}
      order by count_key asc limit 200`,
  });
  await assertCockroachBoundedPlan(client, {
    expectedIndexes: [
      "private_hot_updater_prisma_insights_report_order_pkey",
      "private_hot_updater_prisma_report_order_page_idx",
    ],
    limit: 100,
    query: `select ordinal,label,value
      from private_hot_updater_prisma_insights_report_order
      where job_id='plan-report' and order_kind='bundleDistribution'
        and metric='' and ordinal>=100
      order by ordinal asc limit 100`,
  });
  for (const state of ["queued", "preparing"] as const) {
    await assertCockroachBoundedPlan(client, {
      expectedIndexes: ["private_hot_updater_prisma_search_jobs_state_idx"],
      limit: 1,
      query: `select id,query_key,query_json,state,phase,source_generation,
          as_of_ms,completed_at_ms,after_generation,total,failure_json,
          lease_owner,lease_version
        from private_hot_updater_prisma_insights_search_jobs
        where state=${cockroachStringLiteral(state)} order by id asc limit 1`,
    });
  }
};

const observeTransactionConflicts = (
  client: EvidencePrismaClient,
  onConflict: () => void,
): EvidencePrismaClient => ({
  $disconnect: () => client.$disconnect(),
  $executeRawUnsafe(query, ...values) {
    return client.$executeRawUnsafe(query, ...values);
  },
  $queryRawUnsafe(query, ...values) {
    return client.$queryRawUnsafe(query, ...values);
  },
  async $transaction(callback, options) {
    try {
      return await client.$transaction(callback, options);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2034"
      ) {
        onConflict();
      }
      throw error;
    }
  },
});

const assertLayoutCatalog = async (
  client: EvidencePrismaClient,
): Promise<void> => {
  const createTable = await client.$queryRawUnsafe<Record<string, unknown>[]>(
    "show create table bundle_events",
  );
  const createTableText = textFromRows(createTable);
  expect(createTableText).toContain(
    PRISMA_INSIGHTS_MIGRATION_INDEX.toLowerCase(),
  );
  expect(createTableText.replaceAll(/\s/g, "")).toContain(
    `${PRISMA_INSIGHTS_MIGRATION_COLUMN}bytesnullas(id::string::bytes)stored`,
  );

  const indexes = await client.$queryRawUnsafe<
    {
      column_name: string;
      direction: "ASC" | "DESC" | "N/A";
      implicit: "YES" | "NO";
      index_name: string;
      storing: "YES" | "NO";
      table_name: string;
    }[]
  >(`select index_name,table_name,column_name,direction,implicit,storing
       from information_schema.statistics where table_schema=current_schema()
       order by index_name,seq_in_index`);
  const ownedIndexNames = new Set(
    indexes.map(({ index_name, table_name }) => `${table_name}:${index_name}`),
  );
  expect(
    [...requiredIndexOwners].filter(
      ([name, table]) => !ownedIndexNames.has(`${table}:${name}`),
    ),
  ).toEqual([]);
  for (const [name, expected] of Object.entries(requiredIndexColumns)) {
    const owner = indexOwner(name);
    expect(
      indexes
        .filter(
          (row) =>
            row.index_name === name &&
            row.table_name === owner &&
            row.implicit === "NO" &&
            row.storing === "NO",
        )
        .map(({ column_name, direction }) => [column_name, direction]),
    ).toEqual(expected);
  }
  expect(
    indexes
      .filter(
        (row) =>
          row.index_name === PRISMA_INSIGHTS_MIGRATION_INDEX &&
          row.table_name === "bundle_events" &&
          row.implicit === "NO" &&
          row.storing === "NO",
      )
      .map(({ column_name, direction }) => [column_name, direction]),
  ).toEqual([[PRISMA_INSIGHTS_MIGRATION_COLUMN, "ASC"]]);
  const ready = await hasCompletePrismaInsightsLayout(
    client,
    "cockroachdb",
    insightsDatabaseNamespace,
  );
  expect(
    ready,
    JSON.stringify({
      createTableText,
      indexes: indexes.filter(
        ({ index_name }) =>
          index_name === PRISMA_INSIGHTS_MIGRATION_INDEX ||
          index_name === "private_hot_updater_prisma_report_sort_page_idx",
      ),
    }),
  ).toBe(true);
};

beforeAll(async () => {
  if (!databaseUrl) return;
  generated = await generateEvidencePrismaClient(
    join(fixtureDirectory, "schema.prisma"),
    generatedClientPath,
    databaseUrl,
  );
}, 180_000);

afterEach(async () => {
  await insightsConformance.dispose();
  await Promise.all([...evidenceDatabases].map(disposeDatabase));
}, 180_000);

afterAll(async () => {
  await generated?.cleanup();
  generated = undefined;
}, 180_000);

describe.skipIf(!databaseUrl)("Prisma Insights CockroachDB evidence", () => {
  it("rejects an unexpected private catalog column", async () => {
    const resource = await createDatabase();
    const client = resource.clients[0]!;
    await createPrismaInsightsLayout(
      client,
      "cockroachdb",
      insightsDatabaseNamespace,
    );
    await expect(
      hasCompletePrismaInsightsLayout(
        client,
        "cockroachdb",
        insightsDatabaseNamespace,
      ),
    ).resolves.toBe(true);
    await client.$executeRawUnsafe(
      "alter table private_hot_updater_prisma_insights_report_jobs add column unexpected_value int8 null",
    );
    await expect(
      hasCompletePrismaInsightsLayout(
        client,
        "cockroachdb",
        insightsDatabaseNamespace,
      ),
    ).resolves.toBe(false);
  });

  it(
    "backfills 50,001 installations with exact totals and bounded plans",
    { timeout: 900_000 },
    async () => {
      const resource = await createDatabase();
      let client = resource.clients[0]!;
      expect(await insertScaleRows(client)).toBe(50_001);
      await client.$executeRawUnsafe(
        `create table migration_index_decoy (
          id uuid primary key
        )`,
      );
      await client.$executeRawUnsafe(
        `create index ${PRISMA_INSIGHTS_MIGRATION_INDEX}
         on migration_index_decoy (id)`,
      );
      const concurrent = addClient(resource);

      await Promise.all([
        createPrismaInsightsLayout(
          client,
          "cockroachdb",
          insightsDatabaseNamespace,
        ),
        createPrismaInsightsLayout(
          concurrent,
          "cockroachdb",
          insightsDatabaseNamespace,
        ),
      ]);

      await assertLayoutCatalog(client);
      await assertCockroachBoundedPlan(client, {
        expectedIndexes: [PRISMA_INSIGHTS_MIGRATION_INDEX],
        limit: 200,
        query: `select id from bundle_events
          where ${PRISMA_INSIGHTS_MIGRATION_COLUMN}>
              ${cockroachStringLiteral(uuid(100))}::bytes
            and ${PRISMA_INSIGHTS_MIGRATION_COLUMN}<=
              ${cockroachStringLiteral(uuid(50_001))}::bytes
          order by ${PRISMA_INSIGHTS_MIGRATION_COLUMN} asc limit 200`,
      });
      await expect(
        Promise.all([
          preparePrismaInsights(
            client,
            "cockroachdb",
            insightsDatabaseNamespace,
            {
              writersDrained: true,
            },
          ),
          preparePrismaInsights(
            concurrent,
            "cockroachdb",
            insightsDatabaseNamespace,
            {
              writersDrained: true,
            },
          ),
        ]),
      ).resolves.toEqual([{ ready: false }, { ready: false }]);
      const sourceBeforeReopen = await client.$queryRawUnsafe<
        { source_id: string }[]
      >(
        "select source_id from private_hot_updater_prisma_insights_source where id=1",
      );

      const migrated = await finishScaleMigration(resource, client);
      client = migrated.client;
      expect(migrated.processed).toBe(50_001);
      await expect(
        client.$queryRawUnsafe(
          "select source_id from private_hot_updater_prisma_insights_source where id=1",
        ),
      ).resolves.toEqual(sourceBeforeReopen);
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
          (select count(*) from private_hot_updater_prisma_insights_events) as events,
          (select count(*) from private_hot_updater_prisma_insights_live) as installations,
          (select count(distinct source_generation) from private_hot_updater_prisma_insights_events) as generations,
          (select min(source_generation) from private_hot_updater_prisma_insights_events) as min_generation,
          (select max(source_generation) from private_hot_updater_prisma_insights_events) as max_generation,
          (select count(*) from bundle_events) as raw_events,
          (select count(*) from bundle_events where substring(id::string,1,9)='00000000-') as legacy_events,
          (select generation from private_hot_updater_prisma_insights_source where id=1) as source_generation`);
      expect(counts[0]).toMatchObject({
        events: 50_002n,
        generations: 50_002n,
        installations: 50_002n,
        legacy_events: 50_001n,
        max_generation: 50_002n,
        min_generation: 1n,
        raw_events: 50_002n,
        source_generation: 50_002n,
      });

      await drainScaleEvents(client, migrated.writerId);

      const model = createPrismaInsightsModel(
        client,
        "cockroachdb",
        insightsDatabaseNamespace,
      );
      const readSearch = () =>
        model.pageInstallations({
          kind: "userId" as const,
          userId: "scale-user",
          limit: 100,
        });
      const search = await finishSearch(client, readSearch);
      expect(search.state).toBe("ready");
      if (search.state !== "ready") return;
      expect(search.data.data).toHaveLength(100);
      expect(search.data.hasNext).toBe(true);
      expect(search.data.total).toMatchObject({
        state: "exact",
        value: 50_001,
      });
      const cutoff = search.data.consistency.cutoff;
      expect(cutoff.kind).toBe("publication");
      if (cutoff.kind !== "publication") return;
      const liveKeys = await client.$queryRawUnsafe<
        { install_key: Uint8Array }[]
      >(`select install_key from private_hot_updater_prisma_insights_live
         where install_id='scale-install-1'`);
      const installKey = Buffer.from(liveKeys[0]!.install_key);
      await assertCockroachReadyPlanMatrix(client, {
        installKey,
        publicationId: cutoff.publication.id,
        upperGeneration: 50_002,
      });
    },
  );

  it(
    "uses bounded native plans for every CockroachDB page and worker path",
    { timeout: 600_000 },
    async () => {
      const resource = await createDatabase();
      const client = resource.clients[0]!;
      expect(await insertScaleRows(client, 1_000)).toBe(1_000);
      await createPrismaInsightsLayout(
        client,
        "cockroachdb",
        insightsDatabaseNamespace,
      );
      await assertCockroachBoundedPlan(client, {
        expectedIndexes: [PRISMA_INSIGHTS_MIGRATION_INDEX],
        limit: 200,
        query: `select id from bundle_events
          where ${PRISMA_INSIGHTS_MIGRATION_COLUMN}>
              ${cockroachStringLiteral(uuid(100))}::bytes
            and ${PRISMA_INSIGHTS_MIGRATION_COLUMN}<=
              ${cockroachStringLiteral(uuid(1_000))}::bytes
          order by ${PRISMA_INSIGHTS_MIGRATION_COLUMN} asc limit 200`,
      });
      await expect(
        preparePrismaInsights(
          client,
          "cockroachdb",
          insightsDatabaseNamespace,
          {
            writersDrained: true,
          },
        ),
      ).resolves.toEqual({ ready: false });

      let migrated = 0;
      for (let step = 0; step < 10; step += 1) {
        const result = await createPrismaInsightsMaintenance(
          client,
          "cockroachdb",
          insightsDatabaseNamespace,
        ).runStep({ maxItems: 200, maxRequests: 2_004 });
        migrated += result.processed;
        if (result.ready) break;
      }
      expect(migrated).toBe(1_000);

      const model = createPrismaInsightsModel(
        client,
        "cockroachdb",
        insightsDatabaseNamespace,
      );
      const readSearch = () =>
        model.pageInstallations({
          kind: "userId" as const,
          userId: "scale-user",
          limit: 100,
        });
      const search = await finishSearch(client, readSearch);
      expect(search.state).toBe("ready");
      if (search.state !== "ready") return;
      const cutoff = search.data.consistency.cutoff;
      expect(cutoff.kind).toBe("publication");
      if (cutoff.kind !== "publication") return;
      const liveKeys = await client.$queryRawUnsafe<
        { install_key: Uint8Array }[]
      >(`select install_key from private_hot_updater_prisma_insights_live
         where install_id='scale-install-1'`);
      await assertCockroachReadyPlanMatrix(client, {
        installKey: Buffer.from(liveKeys[0]!.install_key),
        publicationId: cutoff.publication.id,
        upperGeneration: 1_000,
      });
    },
  );

  it(
    "retries a real CockroachDB serializable conflict without partial writes",
    { timeout: 240_000 },
    async () => {
      const resource = await createDatabase();
      const first = resource.clients[0]!;
      const second = addClient(resource);
      await createPrismaInsightsLayout(
        first,
        "cockroachdb",
        insightsDatabaseNamespace,
      );
      await expect(
        preparePrismaInsights(first, "cockroachdb", insightsDatabaseNamespace, {
          writersDrained: true,
        }),
      ).resolves.toEqual({ ready: true });
      await first.$executeRawUnsafe(`create table contention_probe (
        id int primary key,
        observed_generation int not null
      )`);
      await first.$executeRawUnsafe(
        "insert into contention_probe (id,observed_generation) values (1,0),(2,0)",
      );

      let conflictCount = 0;
      let invocationCount = 0;
      let gatedInvocations = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const contend = (client: EvidencePrismaClient, id: number) =>
        runPrismaInsightsTransaction(
          observeTransactionConflicts(client, () => {
            conflictCount += 1;
          }),
          "cockroachdb",
          async (transaction) => {
            invocationCount += 1;
            const rows = await transaction.$queryRawUnsafe<
              { generation: bigint }[]
            >(
              "select sum(observed_generation) as generation from contention_probe",
            );
            const generation = Number(rows[0]?.generation);
            if (gatedInvocations < 2) {
              gatedInvocations += 1;
              if (gatedInvocations === 2) release();
              await gate;
            }
            await transaction.$executeRawUnsafe(
              `update contention_probe
               set observed_generation=observed_generation+1 where id=$1`,
              id,
            );
            return generation + 1;
          },
        );

      const committed = await Promise.all([
        contend(first, 1),
        contend(second, 2),
      ]);
      expect([...committed].sort((left, right) => left - right)).toEqual([
        1, 2,
      ]);
      expect(
        conflictCount,
        JSON.stringify({ committed, gatedInvocations, invocationCount }),
      ).toBeGreaterThanOrEqual(1);
      expect(conflictCount).toBeLessThanOrEqual(8);
      expect(invocationCount).toBeGreaterThanOrEqual(3);
      expect(invocationCount).toBeLessThanOrEqual(10);
      await expect(
        first.$queryRawUnsafe(
          `select generation,
             (select count(*) from contention_probe) as probe_count,
             (select sum(observed_generation)::int8 from contention_probe) as observed_sum,
             (select min(observed_generation) from contention_probe) as observed_min,
             (select max(observed_generation) from contention_probe) as observed_max
           from private_hot_updater_prisma_insights_source where id=1`,
        ),
      ).resolves.toMatchObject([
        {
          generation: 0n,
          observed_max: 1n,
          observed_min: 1n,
          observed_sum: 2n,
          probe_count: 2n,
        },
      ]);
    },
  );

  it(
    "preflights and durably records oversized CockroachDB legacy poison",
    { timeout: 240_000 },
    async () => {
      const resource = await createDatabase();
      const client = resource.clients[0]!;
      const poison = {
        ...createBundleEventRowFixture("9701", 100),
        username: "x".repeat(20_481),
      };
      await client.$executeRawUnsafe(
        `insert into bundle_events (
          id,type,install_id,user_id,username,from_release_id,from_bundle_id,
          to_release_id,to_bundle_id,platform,app_version,channel,cohort,
          update_strategy,fingerprint_hash,sdk_version,received_at_ms
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        poison.id,
        poison.type,
        poison.install_id,
        poison.user_id,
        poison.username,
        poison.from_release_id,
        poison.from_bundle_id,
        poison.to_release_id,
        poison.to_bundle_id,
        poison.platform,
        poison.app_version,
        poison.channel,
        poison.cohort,
        poison.update_strategy,
        poison.fingerprint_hash,
        poison.sdk_version,
        poison.received_at_ms,
      );
      await expect(
        preparePrismaInsights(
          client,
          "cockroachdb",
          insightsDatabaseNamespace,
          {
            writersDrained: true,
          },
        ),
      ).resolves.toEqual({ ready: false });
      const maintenance = createPrismaInsightsMaintenance(
        client,
        "cockroachdb",
        insightsDatabaseNamespace,
      );
      await expect(
        maintenance.runStep({ maxItems: 200, maxRequests: 2_004 }),
      ).rejects.toThrow(`Invalid legacy Insights event ${poison.id}`);
      await expect(
        maintenance.runStep({ maxItems: 200, maxRequests: 2_004 }),
      ).rejects.toThrow(`Invalid legacy Insights event ${poison.id}`);
      await expect(
        client.$queryRawUnsafe(
          `select ready,failed_reason,
             (select count(*) from private_hot_updater_prisma_insights_events) as private_events
           from private_hot_updater_prisma_insights_state where id=1`,
        ),
      ).resolves.toMatchObject([
        {
          ready: false,
          failed_reason: `migration-poison:${poison.id}`,
          private_events: 0n,
        },
      ]);
    },
  );

  it(
    "rejects a same-owner CockroachDB index with a malformed key shape",
    { timeout: 240_000 },
    async () => {
      const resource = await createDatabase();
      const client = resource.clients[0]!;
      await createPrismaInsightsLayout(
        client,
        "cockroachdb",
        insightsDatabaseNamespace,
      );
      await client.$executeRawUnsafe(
        "drop index private_hot_updater_prisma_insights_events@private_hot_updater_prisma_insights_events_global_idx",
      );
      await client.$executeRawUnsafe(
        "create index private_hot_updater_prisma_insights_events_global_idx on private_hot_updater_prisma_insights_events (event_order)",
      );
      const actual = await client.$queryRawUnsafe<
        { column_name: string; direction: string }[]
      >(`select column_name,direction from information_schema.statistics
         where table_schema=current_schema()
           and table_name='private_hot_updater_prisma_insights_events'
           and index_name='private_hot_updater_prisma_insights_events_global_idx'
           and implicit='NO' and storing='NO' order by seq_in_index`);
      expect(actual).toEqual([
        { column_name: "event_order", direction: "ASC" },
      ]);
      await expect(
        hasCompletePrismaInsightsLayout(
          client,
          "cockroachdb",
          insightsDatabaseNamespace,
        ),
      ).resolves.toBe(false);
    },
  );
});

describe.skipIf(!databaseUrl)(
  "Prisma CockroachDB InsightsModel shared conformance",
  { timeout: 600_000 },
  () => {
    registerInsightsModelTests(insightsConformance.createHarness);
  },
);
