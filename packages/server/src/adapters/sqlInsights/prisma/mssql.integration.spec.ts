import { createHash, randomUUID } from "node:crypto";

import { registerInsightsModelTests } from "@hot-updater/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../../../test-utils/src/databaseTestFixtures";
import { getPrismaBundleEventDelegate } from "../../prismaRows";
import {
  assertPrismaInsightsClient,
  runPrismaInsightsTransaction,
  type PrismaInsightsRawClient,
} from "./client";
import { prismaInsightsInstallKey } from "./codec";
import { createPrismaInsightsConformanceFixture } from "./fixtures/insightsConformance";
import {
  createMssqlEvidenceDatabase,
  type MssqlEvidenceDatabase,
} from "./fixtures/mssql/runtime";
import {
  createPrismaInsightsMaintenance,
  preparePrismaInsights,
} from "./maintenance";
import { createPrismaInsightsModel } from "./model";
import {
  deletePrismaInsightsRows,
  insertPrismaInsightsIgnore,
  updatePrismaInsightsRows,
} from "./rawStore";
import { runPrismaInsightsReportStep } from "./reports";
import {
  createPrismaInsightsLayout,
  hasCompletePrismaInsightsLayout,
  PRISMA_INSIGHTS_ALIASES,
  PRISMA_INSIGHTS_EVENTS,
  PRISMA_INSIGHTS_LIVE,
  PRISMA_INSIGHTS_MIGRATION_INDEX,
  PRISMA_INSIGHTS_REPORT_COUNTS,
  PRISMA_INSIGHTS_REPORT_JOBS,
  PRISMA_INSIGHTS_REPORT_MEMBERS,
  PRISMA_INSIGHTS_REPORT_ORDER,
  PRISMA_INSIGHTS_REPORT_SORT,
  PRISMA_INSIGHTS_REQUIRED_INDEXES,
  PRISMA_INSIGHTS_SEARCH_HEADS,
  PRISMA_INSIGHTS_SEARCH_JOBS,
  PRISMA_INSIGHTS_SEARCH_ROWS,
  PRISMA_INSIGHTS_SOURCE,
} from "./schema";
import { runPrismaInsightsSearchStep } from "./search";

const insightsDatabaseNamespace = "00000000-0000-7000-8000-00000000d004";

const connectionString = process.env.PRISMA_INSIGHTS_MSSQL_URL;
const databases: MssqlEvidenceDatabase[] = [];
const requiredIndexOwners = new Map<string, string>([
  [
    "private_hot_updater_prisma_insights_events_global_idx",
    PRISMA_INSIGHTS_EVENTS,
  ],
  [
    "private_hot_updater_prisma_insights_events_install_idx",
    PRISMA_INSIGHTS_EVENTS,
  ],
  [
    "private_hot_updater_prisma_insights_events_to_bundle_idx",
    PRISMA_INSIGHTS_EVENTS,
  ],
  [
    "private_hot_updater_prisma_insights_events_from_bundle_idx",
    PRISMA_INSIGHTS_EVENTS,
  ],
  [
    "private_hot_updater_prisma_insights_aliases_source_idx",
    PRISMA_INSIGHTS_ALIASES,
  ],
  [
    "private_hot_updater_prisma_search_jobs_state_idx",
    PRISMA_INSIGHTS_SEARCH_JOBS,
  ],
  [
    "private_hot_updater_prisma_report_jobs_state_idx",
    PRISMA_INSIGHTS_REPORT_JOBS,
  ],
  [
    "private_hot_updater_prisma_report_members_page_idx",
    PRISMA_INSIGHTS_REPORT_MEMBERS,
  ],
  [
    "private_hot_updater_prisma_report_order_page_idx",
    PRISMA_INSIGHTS_REPORT_ORDER,
  ],
  [
    "private_hot_updater_prisma_report_counts_source_idx",
    PRISMA_INSIGHTS_REPORT_COUNTS,
  ],
  [
    "private_hot_updater_prisma_report_sort_page_idx",
    PRISMA_INSIGHTS_REPORT_SORT,
  ],
  [PRISMA_INSIGHTS_MIGRATION_INDEX, "bundle_events"],
]);
const requiredIndexKeys = new Map<
  string,
  readonly (readonly [column: string, descending: boolean])[]
>([
  [
    "private_hot_updater_prisma_insights_events_global_idx",
    [
      ["received_at_ms", true],
      ["event_order", true],
    ],
  ],
  [
    "private_hot_updater_prisma_insights_events_install_idx",
    [
      ["install_key", false],
      ["type", false],
      ["received_at_ms", true],
      ["event_order", true],
    ],
  ],
  [
    "private_hot_updater_prisma_insights_events_to_bundle_idx",
    [
      ["type", false],
      ["to_bundle_id", false],
      ["received_at_ms", true],
      ["event_order", true],
    ],
  ],
  [
    "private_hot_updater_prisma_insights_events_from_bundle_idx",
    [
      ["type", false],
      ["from_bundle_id", false],
      ["received_at_ms", true],
      ["event_order", true],
    ],
  ],
  [
    "private_hot_updater_prisma_insights_aliases_source_idx",
    [
      ["source_generation", false],
      ["alias_key", false],
    ],
  ],
  [
    "private_hot_updater_prisma_search_jobs_state_idx",
    [
      ["state", false],
      ["id", false],
    ],
  ],
  [
    "private_hot_updater_prisma_report_jobs_state_idx",
    [
      ["state", false],
      ["id", false],
    ],
  ],
  [
    "private_hot_updater_prisma_report_members_page_idx",
    [
      ["job_id", false],
      ["section", false],
      ["metric", false],
      ["member_key", false],
    ],
  ],
  [
    "private_hot_updater_prisma_report_order_page_idx",
    [
      ["job_id", false],
      ["order_kind", false],
      ["metric", false],
      ["ordinal", false],
    ],
  ],
  [
    "private_hot_updater_prisma_report_counts_source_idx",
    [
      ["job_id", false],
      ["section", false],
      ["metric", false],
      ["bucket_start_ms", false],
      ["count_key", false],
    ],
  ],
  [
    "private_hot_updater_prisma_report_sort_page_idx",
    [
      ["job_id", false],
      ["order_kind", false],
      ["metric", false],
      ["sort_pass", false],
      ["sort_run", false],
      ["ordinal", false],
    ],
  ],
  [
    PRISMA_INSIGHTS_MIGRATION_INDEX,
    [["private_hot_updater_prisma_insights_migration_id", false]],
  ],
]);

const createDatabase = async (): Promise<MssqlEvidenceDatabase> => {
  if (connectionString === undefined) {
    throw new Error("missing SQL Server evidence URL");
  }
  const database = await createMssqlEvidenceDatabase(connectionString);
  databases.push(database);
  assertPrismaInsightsClient(database.client);
  return database;
};

const insightsConformance = createPrismaInsightsConformanceFixture({
  provider: "mssql",
  budgets: {
    pageEvents: (input) =>
      input.selector.kind === "all" ? input.limit + 1 : (input.limit + 1) * 2,
    pageInstallations: (input) =>
      input.kind === "installationId" ? 1 : input.limit + 1,
    pageReport: (input) => input.limit * 8 + 16,
  },
  async createNamespace() {
    if (connectionString === undefined) {
      throw new Error("missing SQL Server evidence URL");
    }
    const resource = await createMssqlEvidenceDatabase(connectionString);
    let client = resource.client;
    return {
      client,
      async reopen() {
        await client.$disconnect();
        client = resource.reopen();
        await client.$queryRawUnsafe("select 1");
        return client;
      },
      dispose: () => resource.dispose(),
    };
  },
});

const readRequiredIndexOwners = async (
  client: MssqlEvidenceDatabase["client"],
): Promise<Map<string, string>> => {
  const rows = await client.$queryRawUnsafe<
    { name: string; owner: string }[]
  >(`select indexes.name,object_name(indexes.object_id) as owner
     from sys.indexes indexes
     where indexes.name in (${PRISMA_INSIGHTS_REQUIRED_INDEXES.map(
       (name) => `'${name}'`,
     ).join(",")})`);
  return new Map(rows.map(({ name, owner }) => [name, owner]));
};

const readRequiredIndexKeys = async (
  client: MssqlEvidenceDatabase["client"],
): Promise<typeof requiredIndexKeys> => {
  const rows = await client.$queryRawUnsafe<
    {
      index_name: string;
      column_name: string;
      key_ordinal: number;
      is_descending_key: boolean;
    }[]
  >(`select indexes.name as index_name,columns.name as column_name,
       index_columns.key_ordinal,index_columns.is_descending_key
     from sys.indexes indexes
     join sys.index_columns index_columns
       on index_columns.object_id=indexes.object_id
       and index_columns.index_id=indexes.index_id
     join sys.columns columns on columns.object_id=index_columns.object_id
       and columns.column_id=index_columns.column_id
     where index_columns.key_ordinal>0
       and indexes.name in (${PRISMA_INSIGHTS_REQUIRED_INDEXES.map(
         (name) => `'${name}'`,
       ).join(",")})
     order by indexes.name,index_columns.key_ordinal`);
  const result = new Map<
    string,
    (readonly [column: string, descending: boolean])[]
  >();
  for (const row of rows) {
    const keys = result.get(row.index_name) ?? [];
    keys.push([row.column_name, row.is_descending_key]);
    result.set(row.index_name, keys);
  }
  return result;
};

afterEach(async () => {
  await insightsConformance.dispose();
  while (databases.length > 0) {
    await databases.pop()!.dispose();
  }
}, 120_000);

const safeInteger = (value: unknown): number => {
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("unsafe SQL integer");
  return number;
};

const mssqlSha256 = (value: string): Buffer =>
  createHash("sha256").update(Buffer.from(value, "utf16le")).digest();

const eventOrder = (eventId: string): Buffer =>
  Buffer.from(eventId.replaceAll("-", ""), "hex");

const scaleEventId = (value: number): string =>
  `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`;

const readShowplan = async (
  client: MssqlEvidenceDatabase["client"],
  query: string,
): Promise<string> => {
  const marker = `prisma_plan_${randomUUID().replaceAll("-", "")}`;
  await client.$queryRawUnsafe(`${query} /* ${marker} */`);
  const rows = await client.$queryRawUnsafe<{ plan_xml: string }[]>(
    `select convert(nvarchar(max),query_plan.query_plan) as plan_xml
     from sys.dm_exec_cached_plans cached_plan
     cross apply sys.dm_exec_sql_text(cached_plan.plan_handle) sql_text
     cross apply sys.dm_exec_query_plan(cached_plan.plan_handle) query_plan
     where sql_text.dbid=db_id() and sql_text.text like '%${marker}%'
       and sql_text.text not like '%sys.dm_exec_cached_plans%'`,
  );
  const plan = rows.map(({ plan_xml: planXml }) => planXml).join("\n");
  if (plan.length === 0) throw new Error(`missing SQL Server plan ${marker}`);
  return plan;
};

const readPrimaryKeyIndexName = async (
  client: MssqlEvidenceDatabase["client"],
  table: string,
): Promise<string> => {
  const rows = await client.$queryRawUnsafe<{ name: string }[]>(
    `select indexes.name
     from sys.indexes indexes
     join sys.key_constraints constraints
       on constraints.parent_object_id=indexes.object_id
       and constraints.unique_index_id=indexes.index_id
     where constraints.type='PK' and indexes.object_id=object_id(N'${table}')`,
  );
  if (rows.length !== 1 || typeof rows[0]?.name !== "string") {
    throw new Error(`missing SQL Server primary key for ${table}`);
  }
  return rows[0].name;
};

const assertMssqlPlanMatrix = async (
  client: MssqlEvidenceDatabase["client"],
  input: {
    readonly lowerLegacyId: string;
    readonly upperLegacyId: string;
    readonly installationId: string;
    readonly eventId: string;
    readonly sourceGeneration: number;
  },
): Promise<void> => {
  const legacyPlan = await readShowplan(
    client,
    `select top (200) id from bundle_events
     where private_hot_updater_prisma_insights_migration_id>
       convert(binary(32),hashbytes('SHA2_256',convert(nvarchar(max),N'${input.lowerLegacyId}')))
       and private_hot_updater_prisma_insights_migration_id<=
       convert(binary(32),hashbytes('SHA2_256',convert(nvarchar(max),N'${input.upperLegacyId}')))
     order by private_hot_updater_prisma_insights_migration_id asc`,
  );
  expect(legacyPlan).toContain(PRISMA_INSIGHTS_MIGRATION_INDEX);
  expect(legacyPlan).toMatch(/Index (Seek|Scan)/);

  const globalPlan = await readShowplan(
    client,
    `select top (101) event_id,received_at_ms,event_order,install_key,
       install_id,event_json from ${PRISMA_INSIGHTS_EVENTS}
     where received_at_ms>=0 and received_at_ms<2000000000000
     order by received_at_ms desc,event_order desc`,
  );
  expect(globalPlan).toContain(
    "private_hot_updater_prisma_insights_events_global_idx",
  );
  expect(globalPlan).toMatch(/Index (Seek|Scan)/);

  const sourcePlan = await readShowplan(
    client,
    `select top (200) source_generation,event_json
     from ${PRISMA_INSIGHTS_EVENTS} with (forceseek)
     where source_generation>0 and source_generation<=${input.sourceGeneration}
     order by source_generation asc`,
  );
  expect(sourcePlan).toContain("source_generation");
  expect(sourcePlan).toMatch(/Index Seek/);
  expect(sourcePlan).not.toMatch(/Table Scan|PhysicalOp="Sort"/);

  const installKey = prismaInsightsInstallKey(input.installationId).toString(
    "hex",
  );
  const installationPlan = await readShowplan(
    client,
    `select top (101) event_id,received_at_ms,event_order,install_key,
       install_id,event_json from ${PRISMA_INSIGHTS_EVENTS}
     where install_key=0x${installKey} and type='UPDATE_APPLIED'
       and received_at_ms>=0 and received_at_ms<2000000000000
     order by received_at_ms desc,event_order desc`,
  );
  expect(installationPlan).toContain(
    "private_hot_updater_prisma_insights_events_install_idx",
  );
  expect(installationPlan).toMatch(/Index Seek/);

  const searchPlanJobId = randomUUID();
  const searchPlanInstallId = "scale-install-plan";
  const searchPlanInstallKey =
    prismaInsightsInstallKey(searchPlanInstallId).toString("hex");
  await client.$executeRawUnsafe(
    `insert into ${PRISMA_INSIGHTS_SEARCH_ROWS}
     (job_id,install_key,install_id,event_id,received_at_ms,event_order,event_json)
     values ('${searchPlanJobId}',0x${searchPlanInstallKey},
       N'${searchPlanInstallId}','${input.eventId}',1800000000000,
       0x${eventOrder(input.eventId).toString("hex")},N'{}')`,
  );
  const searchRowsPrimaryKey = await readPrimaryKeyIndexName(
    client,
    PRISMA_INSIGHTS_SEARCH_ROWS,
  );
  const searchPlan = await readShowplan(
    client,
    `select top (101) install_key,event_json
     from ${PRISMA_INSIGHTS_SEARCH_ROWS}
     where job_id='${searchPlanJobId}'
       and install_key>0x${Buffer.alloc(32).toString("hex")}
       and event_json is not null
     order by install_key asc`,
  );
  expect(searchPlan).toContain(searchRowsPrimaryKey);
  expect(searchPlan).toMatch(/Index Seek/);
  expect(searchPlan).not.toMatch(/Table Scan|PhysicalOp="Sort"/);

  const livePrimaryKey = await readPrimaryKeyIndexName(
    client,
    PRISMA_INSIGHTS_LIVE,
  );
  const livePlan = await readShowplan(
    client,
    `select top (101) install_key,install_id,event_json
     from ${PRISMA_INSIGHTS_LIVE}
     where install_key>0x${Buffer.alloc(32).toString("hex")}
     order by install_key asc`,
  );
  expect(livePlan).toContain(livePrimaryKey);
  expect(livePlan).toMatch(/Index Seek/);
  expect(livePlan).not.toMatch(/Table Scan|PhysicalOp="Sort"/);

  const reportPlanJobId = randomUUID();
  await client.$executeRawUnsafe(
    `insert into ${PRISMA_INSIGHTS_REPORT_ORDER}
     (job_id,order_kind,metric,ordinal,label,value)
     values ('${reportPlanJobId}','bundleDistribution','',0,N'scale',${input.sourceGeneration})`,
  );
  const reportOrderPrimaryKey = await readPrimaryKeyIndexName(
    client,
    PRISMA_INSIGHTS_REPORT_ORDER,
  );
  const reportOrderPlan = await readShowplan(
    client,
    `select top (101) ordinal,label,value
     from ${PRISMA_INSIGHTS_REPORT_ORDER}
     where job_id='${reportPlanJobId}'
       and order_kind='bundleDistribution' and metric=''
       and ordinal>=0 order by ordinal asc`,
  );
  expect(reportOrderPlan).toContain(reportOrderPrimaryKey);
  expect(reportOrderPlan).toMatch(/Index Seek/);
  expect(reportOrderPlan).not.toMatch(/Table Scan|PhysicalOp="Sort"/);

  for (const [table, index] of [
    [
      PRISMA_INSIGHTS_SEARCH_JOBS,
      "private_hot_updater_prisma_search_jobs_state_idx",
    ],
    [
      PRISMA_INSIGHTS_REPORT_JOBS,
      "private_hot_updater_prisma_report_jobs_state_idx",
    ],
  ] as const) {
    for (const state of ["queued", "preparing"] as const) {
      const claimPlan = await readShowplan(
        client,
        `select top (1) id from ${table} with (updlock,rowlock,holdlock)
         where state='${state}' order by id asc`,
      );
      expect(claimPlan).toContain(index);
      expect(claimPlan).toMatch(/Index Seek/);
      expect(claimPlan).not.toMatch(/Table Scan|PhysicalOp="Sort"/);
    }
  }
};

const runSearchUntilReady = async (
  client: MssqlEvidenceDatabase["client"],
  model: ReturnType<typeof createPrismaInsightsModel>,
) => {
  let result = await model.pageInstallations({
    kind: "userId" as const,
    userId: "mssql-user",
    limit: 10,
  });
  for (let step = 0; step < 6 && result.state !== "ready"; step += 1) {
    await runPrismaInsightsSearchStep(client, "mssql", {
      maxItems: 100,
      maxRequests: 1_000,
    });
    result = await model.pageInstallations({
      kind: "userId",
      userId: "mssql-user",
      limit: 10,
    });
  }
  return result;
};

const runReportUntilReady = async (
  client: MssqlEvidenceDatabase["client"],
  model: ReturnType<typeof createPrismaInsightsModel>,
) => {
  let result = await model.getReport({
    query: { kind: "installationOverview" },
  });
  for (let step = 0; step < 40 && result.state !== "ready"; step += 1) {
    await runPrismaInsightsReportStep(client, "mssql", {
      maxItems: 100,
      maxRequests: 4_000,
    });
    result = await model.getReport({
      query: { kind: "installationOverview" },
    });
  }
  return result;
};

const seedScaleEvents = async (
  client: PrismaInsightsRawClient,
  rowCount = 50_001,
): Promise<void> => {
  const inserted = await client.$executeRawUnsafe(`
    with source_rows as (
      select top (${rowCount})
        row_number() over (order by first_source.object_id,second_source.object_id) as row_number
      from sys.all_objects first_source
      cross join sys.all_objects second_source
    )
    insert into bundle_events (
      id,type,install_id,user_id,username,from_release_id,from_bundle_id,
      to_release_id,to_bundle_id,platform,app_version,channel,cohort,
      update_strategy,fingerprint_hash,sdk_version,received_at_ms
    )
    select
      concat('00000000-0000-7000-8000-',
        right(replicate('0',12) + convert(varchar(12),row_number),12)),
      'UPDATE_APPLIED',concat('scale-install-',row_number),'scale-user',
      concat('Scale installation ',row_number),null,
      '00000000-0000-7000-8000-000000900001',null,
      '00000000-0000-7000-8000-000000900002','ios','1.0.0',
      'production','0','appVersion',null,null,1700000000000 + row_number
    from source_rows
  `);
  expect(inserted).toBe(rowCount);
};

describe.skipIf(connectionString === undefined)(
  "Prisma Insights SQL Server 2022 evidence",
  () => {
    it("rejects an unexpected private catalog column", async () => {
      const resource = await createDatabase();
      const client = resource.client;
      await createPrismaInsightsLayout(
        client,
        "mssql",
        insightsDatabaseNamespace,
      );
      await expect(
        hasCompletePrismaInsightsLayout(
          client,
          "mssql",
          insightsDatabaseNamespace,
        ),
      ).resolves.toBe(true);
      await client.$executeRawUnsafe(
        "alter table private_hot_updater_prisma_insights_report_jobs add unexpected_value bigint null",
      );
      await expect(
        hasCompletePrismaInsightsLayout(
          client,
          "mssql",
          insightsDatabaseNamespace,
        ),
      ).resolves.toBe(false);
    });

    it(
      "runs the native lifecycle with object-owned indexes and fenced OUTPUT concurrency",
      { timeout: 180_000 },
      async () => {
        const resource = await createDatabase();
        const client = resource.client;
        await createPrismaInsightsLayout(
          client,
          "mssql",
          insightsDatabaseNamespace,
        );
        expect(await readRequiredIndexOwners(client)).toEqual(
          requiredIndexOwners,
        );
        expect(await readRequiredIndexKeys(client)).toEqual(requiredIndexKeys);
        expect(
          await preparePrismaInsights(
            client,
            "mssql",
            insightsDatabaseNamespace,
            {
              writersDrained: true,
            },
          ),
        ).toEqual({ ready: true });
        expect(
          await hasCompletePrismaInsightsLayout(
            client,
            "mssql",
            insightsDatabaseNamespace,
          ),
        ).toBe(true);

        await client.$executeRawUnsafe(
          "drop index private_hot_updater_prisma_insights_events_global_idx on private_hot_updater_prisma_insights_events",
        );
        await client.$executeRawUnsafe(
          "create table private_hot_updater_prisma_insights_catalog_decoy (received_at_ms float not null,event_order binary(16) not null)",
        );
        await client.$executeRawUnsafe(
          "create index private_hot_updater_prisma_insights_events_global_idx on private_hot_updater_prisma_insights_catalog_decoy (received_at_ms desc,event_order desc)",
        );
        expect(
          await hasCompletePrismaInsightsLayout(
            client,
            "mssql",
            insightsDatabaseNamespace,
          ),
        ).toBe(false);
        await client.$executeRawUnsafe(
          "drop table private_hot_updater_prisma_insights_catalog_decoy",
        );
        await createPrismaInsightsLayout(
          client,
          "mssql",
          insightsDatabaseNamespace,
        );
        expect(
          await hasCompletePrismaInsightsLayout(
            client,
            "mssql",
            insightsDatabaseNamespace,
          ),
        ).toBe(true);

        expect(await readRequiredIndexOwners(client)).toEqual(
          requiredIndexOwners,
        );
        expect(await readRequiredIndexKeys(client)).toEqual(requiredIndexKeys);

        await client.$executeRawUnsafe(
          "drop index private_hot_updater_prisma_insights_events_global_idx on private_hot_updater_prisma_insights_events",
        );
        await client.$executeRawUnsafe(
          "create index private_hot_updater_prisma_insights_events_global_idx on private_hot_updater_prisma_insights_events (event_order asc,received_at_ms asc)",
        );
        expect(
          await hasCompletePrismaInsightsLayout(
            client,
            "mssql",
            insightsDatabaseNamespace,
          ),
        ).toBe(false);
        await client.$executeRawUnsafe(
          "drop index private_hot_updater_prisma_insights_events_global_idx on private_hot_updater_prisma_insights_events",
        );
        await createPrismaInsightsLayout(
          client,
          "mssql",
          insightsDatabaseNamespace,
        );
        expect(
          await hasCompletePrismaInsightsLayout(
            client,
            "mssql",
            insightsDatabaseNamespace,
          ),
        ).toBe(true);
        expect(await readRequiredIndexKeys(client)).toEqual(requiredIndexKeys);

        const model = createPrismaInsightsModel(
          client,
          "mssql",
          insightsDatabaseNamespace,
        );
        const first = {
          ...createBundleEventRowFixture("9101", 100),
          user_id: "mssql-user",
        };
        const second = {
          ...createBundleEventRowFixture("9102", 200),
          user_id: "mssql-user",
        };
        await Promise.all([model.append(first), model.append(second)]);
        const generations = await client.$queryRawUnsafe<
          { source_generation: bigint }[]
        >(`select source_generation from ${PRISMA_INSIGHTS_EVENTS}
           order by source_generation asc`);
        expect(
          generations.map(({ source_generation }) => source_generation),
        ).toEqual([1n, 2n]);

        const queryKey = createHash("sha256")
          .update(`mssql-output-${randomUUID()}`)
          .digest();
        const insertHead = () =>
          runPrismaInsightsTransaction(client, "mssql", (transaction) =>
            insertPrismaInsightsIgnore(
              transaction,
              "mssql",
              PRISMA_INSIGHTS_SEARCH_HEADS,
              {
                query_key: queryKey,
                query_json: '{"kind":"contains","value":"output"}',
                active_job_id: null,
                publication_job_id: null,
              },
              ["query_key"],
            ),
          );
        const insertedHeads = await Promise.all([insertHead(), insertHead()]);
        expect(insertedHeads.toSorted()).toEqual([0, 1]);
        const outputJobId = randomUUID();
        expect(
          await updatePrismaInsightsRows(
            client,
            "mssql",
            PRISMA_INSIGHTS_SEARCH_HEADS,
            { active_job_id: outputJobId },
            { query_key: queryKey },
          ),
        ).toBe(1);
        expect(
          await deletePrismaInsightsRows(
            client,
            "mssql",
            PRISMA_INSIGHTS_SEARCH_HEADS,
            { query_key: queryKey, active_job_id: outputJobId },
          ),
        ).toBe(1);

        const events = await model.pageEvents({
          selector: { kind: "all" },
          sinceReceivedAtMs: 0,
          beforeReceivedAtMs: 1_000,
          limit: 10,
        });
        if (events.state === "failed") {
          throw new Error(JSON.stringify(events));
        }
        expect(events).toMatchObject({ state: "ready" });
        if (events.state !== "ready") return;
        expect(
          events.data.data.map((event: { readonly id: string }) => event.id),
        ).toEqual([second.id, first.id]);

        const preparingSearch = await model.pageInstallations({
          kind: "userId",
          userId: "mssql-user",
          limit: 10,
        });
        expect(preparingSearch.state).toBe("preparing");
        if (preparingSearch.state !== "preparing") return;
        const leaseBefore = await client.$queryRawUnsafe<
          { lease_version: bigint }[]
        >(`select lease_version from ${PRISMA_INSIGHTS_SEARCH_JOBS}
           where id='${preparingSearch.job.id}'`);
        const concurrentClient = resource.reopen();
        assertPrismaInsightsClient(concurrentClient);
        const workerResults = await Promise.all([
          runPrismaInsightsSearchStep(client, "mssql", {
            maxItems: 100,
            maxRequests: 1_000,
            jobId: preparingSearch.job.id,
          }),
          runPrismaInsightsSearchStep(concurrentClient, "mssql", {
            maxItems: 100,
            maxRequests: 1_000,
            jobId: preparingSearch.job.id,
          }),
        ]);
        expect(
          workerResults.filter(({ jobId }) => jobId === preparingSearch.job.id)
            .length,
        ).toBeGreaterThan(0);
        expect(
          await updatePrismaInsightsRows(
            client,
            "mssql",
            PRISMA_INSIGHTS_SEARCH_JOBS,
            { lease_owner: randomUUID() },
            {
              id: preparingSearch.job.id,
              lease_version: leaseBefore[0]!.lease_version,
            },
          ),
        ).toBe(0);

        const search = await runSearchUntilReady(client, model);
        expect(search.state).toBe("ready");
        if (search.state !== "ready") return;
        expect(search.data.total).toMatchObject({ state: "exact", value: 2 });

        const report = await runReportUntilReady(client, model);
        expect(report.state).toBe("ready");
        if (report.state !== "ready") return;
        expect(report.data.summary).toEqual({ trackedInstallations: 2 });
      },
    );

    it(
      "retains and collision-checks the full-width installation ID domain",
      { timeout: 180_000 },
      async () => {
        const { client } = await createDatabase();
        const commonPrefix = `installation/${"x".repeat(937)}`;
        const installIds = [`${commonPrefix}a`, `${commonPrefix}b`];
        for (const [index, installId] of installIds.entries()) {
          await getPrismaBundleEventDelegate(client).create({
            data: {
              ...createBundleEventRowFixture(`930${index}`, 100 + index),
              install_id: installId,
            },
          });
        }

        expect(
          await preparePrismaInsights(
            client,
            "mssql",
            insightsDatabaseNamespace,
            {
              writersDrained: true,
            },
          ),
        ).toEqual({ ready: false });
        const sourceIdentity = await client.$queryRawUnsafe<
          { install_id: string; id_bytes: number }[]
        >(`select install_id,datalength(install_id) as id_bytes
           from bundle_events`);
        expect(sourceIdentity).toHaveLength(2);
        expect(sourceIdentity.every(({ id_bytes }) => id_bytes > 900)).toBe(
          true,
        );
        expect(
          await createPrismaInsightsMaintenance(
            client,
            "mssql",
            insightsDatabaseNamespace,
          ).runStep({
            maxItems: 200,
            maxRequests: 2_004,
          }),
        ).toMatchObject({ processed: 2, ready: true });
        const stored = await client.$queryRawUnsafe<
          { install_id: string; install_key: Uint8Array }[]
        >(`select install_id,install_key
           from private_hot_updater_prisma_insights_live`);
        expect(stored.map(({ install_id }) => install_id).toSorted()).toEqual(
          installIds.toSorted(),
        );
        expect(
          new Set(
            stored.map(({ install_key }) =>
              Buffer.from(install_key).toString("hex"),
            ),
          ).size,
        ).toBe(2);
        for (const row of stored) {
          expect(Buffer.from(row.install_key)).toEqual(
            prismaInsightsInstallKey(row.install_id),
          );
        }
        const nativeColumn = await client.$queryRawUnsafe<
          { max_length: number }[]
        >(`select max_length from sys.columns
           where object_id=object_id(N'bundle_events') and name=N'install_id'`);
        expect(nativeColumn).toEqual([{ max_length: 2_048 }]);
      },
    );

    it(
      "hashes full event IDs and durably poisons arbitrary legacy values",
      { timeout: 180_000 },
      async () => {
        const { client } = await createDatabase();
        const ids = ["legacy/non-v7-a", "legacy/non-v7-b"];
        for (const [index, id] of ids.entries()) {
          await getPrismaBundleEventDelegate(client).create({
            data: {
              ...createBundleEventRowFixture(`940${index}`, 100 + index),
              id,
            },
          });
        }
        expect(
          await preparePrismaInsights(
            client,
            "mssql",
            insightsDatabaseNamespace,
            {
              writersDrained: true,
            },
          ),
        ).toEqual({ ready: false });
        const identityRows = await client.$queryRawUnsafe<
          { id: string; migration_key: Uint8Array }[]
        >(`select id,
             private_hot_updater_prisma_insights_migration_id as migration_key
           from bundle_events`);
        expect(identityRows).toHaveLength(2);
        for (const row of identityRows) {
          expect(Buffer.from(row.migration_key)).toEqual(mssqlSha256(row.id));
        }
        expect(
          new Set(
            identityRows.map(({ migration_key }) =>
              Buffer.from(migration_key).toString("hex"),
            ),
          ).size,
        ).toBe(2);

        await expect(
          createPrismaInsightsMaintenance(
            client,
            "mssql",
            insightsDatabaseNamespace,
          ).runStep({
            maxItems: 200,
            maxRequests: 2_004,
          }),
        ).rejects.toThrow("Invalid legacy Insights event");
        const state = await client.$queryRawUnsafe<
          {
            ready: boolean;
            failed_reason: string;
            migration_upper_id: string;
          }[]
        >(`select ready,failed_reason,migration_upper_id
           from private_hot_updater_prisma_insights_state where id=1`);
        expect(state[0]?.ready).toBe(false);
        expect(ids).toContain(
          state[0]!.failed_reason.slice("migration-poison:".length),
        );
        expect(ids).toContain(state[0]!.migration_upper_id);
        expect(
          await client.$queryRawUnsafe<{ event_count: bigint }[]>(
            "select count_big(*) as event_count from bundle_events",
          ),
        ).toEqual([{ event_count: 2n }]);
      },
    );

    it(
      "captures the complete bounded native plan matrix",
      { timeout: 300_000 },
      async () => {
        const { client } = await createDatabase();
        await seedScaleEvents(client, 2_000);
        expect(
          await preparePrismaInsights(
            client,
            "mssql",
            insightsDatabaseNamespace,
            {
              writersDrained: true,
            },
          ),
        ).toEqual({ ready: false });
        const maintenance = createPrismaInsightsMaintenance(
          client,
          "mssql",
          insightsDatabaseNamespace,
        );
        let ready = false;
        for (let step = 0; step < 50 && !ready; step += 1) {
          const result = await maintenance.runStep({
            maxItems: 200,
            maxRequests: 2_004,
          });
          expect(result.processed).toBeLessThanOrEqual(50);
          ready = result.ready;
        }
        expect(ready).toBe(true);
        const boundaries = await client.$queryRawUnsafe<
          { id: string; migration_key: Uint8Array }[]
        >(`select id,private_hot_updater_prisma_insights_migration_id as migration_key
           from (
             select id,private_hot_updater_prisma_insights_migration_id,
               row_number() over (order by private_hot_updater_prisma_insights_migration_id asc) as first_row,
               row_number() over (order by private_hot_updater_prisma_insights_migration_id desc) as last_row
             from bundle_events
           ) boundaries where first_row=1 or last_row=1`);
        expect(boundaries).toHaveLength(2);
        const upper = boundaries.reduce((left, right) =>
          Buffer.compare(
            Buffer.from(left.migration_key),
            Buffer.from(right.migration_key),
          ) > 0
            ? left
            : right,
        );
        const lower = boundaries.find(({ id }) => id !== upper.id)!;
        await assertMssqlPlanMatrix(client, {
          lowerLegacyId: lower.id,
          upperLegacyId: upper.id,
          installationId: "scale-install-1000",
          eventId: scaleEventId(1),
          sourceGeneration: 2_000,
        });
      },
    );

    it(
      "migrates 50,001 rows through SHA-256 keysets and proves bounded index plans",
      { timeout: 1_800_000 },
      async () => {
        const resource = await createDatabase();
        let client = resource.client;
        await seedScaleEvents(client);
        expect(
          await preparePrismaInsights(
            client,
            "mssql",
            insightsDatabaseNamespace,
            {
              writersDrained: true,
            },
          ),
        ).toEqual({ ready: false });

        const boundaries = await client.$queryRawUnsafe<
          { id: string; migration_key: Uint8Array }[]
        >(`select id,private_hot_updater_prisma_insights_migration_id as migration_key
           from (
             select id,private_hot_updater_prisma_insights_migration_id,
               row_number() over (order by private_hot_updater_prisma_insights_migration_id asc) as first_row,
               row_number() over (order by private_hot_updater_prisma_insights_migration_id desc) as last_row
             from bundle_events
           ) boundaries where first_row=1 or last_row=1`);
        expect(boundaries).toHaveLength(2);
        for (const boundary of boundaries) {
          expect(Buffer.from(boundary.migration_key)).toEqual(
            mssqlSha256(boundary.id),
          );
        }
        const upper = boundaries.reduce((left, right) =>
          Buffer.compare(
            Buffer.from(left.migration_key),
            Buffer.from(right.migration_key),
          ) > 0
            ? left
            : right,
        );
        const stateBefore = await client.$queryRawUnsafe<
          { migration_upper_id: string; migration_after_id: string | null }[]
        >(
          "select migration_upper_id,migration_after_id from private_hot_updater_prisma_insights_state where id=1",
        );
        expect(stateBefore[0]).toEqual({
          migration_upper_id: upper.id,
          migration_after_id: null,
        });
        const sourceBefore = await client.$queryRawUnsafe<
          { source_id: string }[]
        >(`select source_id from ${PRISMA_INSIGHTS_SOURCE} where id=1`);
        expect(sourceBefore).toHaveLength(1);

        const computedColumn = await client.$queryRawUnsafe<
          { is_persisted: boolean; definition: string }[]
        >(`select computed.is_persisted,computed.definition
           from sys.computed_columns computed
           where computed.object_id=object_id(N'bundle_events')
             and computed.name=N'private_hot_updater_prisma_insights_migration_id'`);
        expect(computedColumn).toHaveLength(1);
        expect(computedColumn[0]?.is_persisted).toBe(true);
        expect(computedColumn[0]?.definition.toLowerCase()).toContain(
          "sha2_256",
        );

        const preflight = await client.$queryRawUnsafe<
          { id_preview: string; raw_bytes: bigint }[]
        >(`select top (200) left(convert(nvarchar(max),id),128) as id_preview,
            ${[
              "id",
              "type",
              "install_id",
              "user_id",
              "username",
              "from_release_id",
              "from_bundle_id",
              "to_release_id",
              "to_bundle_id",
              "platform",
              "app_version",
              "channel",
              "cohort",
              "update_strategy",
              "fingerprint_hash",
              "sdk_version",
            ]
              .map(
                (field) =>
                  `datalength(convert(varchar(max),coalesce(${field},N'') collate Latin1_General_100_BIN2_UTF8))`,
              )
              .join("+")} as raw_bytes
           from bundle_events
           where private_hot_updater_prisma_insights_migration_id<=
             convert(binary(32),hashbytes('SHA2_256',convert(nvarchar(max),N'${upper.id}')))
           order by private_hot_updater_prisma_insights_migration_id asc`);
        expect(preflight).toHaveLength(200);
        expect(
          preflight.reduce(
            (bytes, row) => bytes + safeInteger(row.raw_bytes) * 6 + 4_096,
            0,
          ),
        ).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(
          preflight.every(({ id_preview }) => id_preview.length <= 128),
        ).toBe(true);

        let maintenance = createPrismaInsightsMaintenance(
          client,
          "mssql",
          insightsDatabaseNamespace,
        );
        let processed = 0;
        let ready = false;
        let writerEvent:
          | ReturnType<typeof createBundleEventRowFixture>
          | undefined;
        for (let step = 0; step < 1_200 && !ready; step += 1) {
          const result = await maintenance.runStep({
            maxItems: 200,
            maxRequests: 2_004,
          });
          expect(result.processed).toBeLessThanOrEqual(50);
          processed += result.processed;
          ready = result.ready;
          if (step === 36) {
            const checkpoint = await client.$queryRawUnsafe<
              { migration_after_id: string }[]
            >(`select migration_after_id
               from private_hot_updater_prisma_insights_state where id=1`);
            const afterKey = mssqlSha256(checkpoint[0]!.migration_after_id);
            const upperKey = Buffer.from(upper.migration_key);
            let candidate = 600_000;
            while (candidate < 2_600_000) {
              const candidateKey = mssqlSha256(scaleEventId(candidate));
              if (
                Buffer.compare(candidateKey, afterKey) > 0 &&
                Buffer.compare(candidateKey, upperKey) <= 0
              ) {
                break;
              }
              candidate += 1;
            }
            expect(candidate).toBeLessThan(2_600_000);
            writerEvent = {
              ...createBundleEventRowFixture(
                String(candidate),
                1_800_000_000_000,
              ),
              user_id: "scale-user",
              username: "Writer during backfill",
            };
            await createPrismaInsightsModel(
              client,
              "mssql",
              insightsDatabaseNamespace,
            ).append(writerEvent);
          }
          if (step === 72) {
            await client.$disconnect();
            client = resource.reopen();
            assertPrismaInsightsClient(client);
            expect(
              await client.$queryRawUnsafe<{ source_id: string }[]>(
                `select source_id from ${PRISMA_INSIGHTS_SOURCE} where id=1`,
              ),
            ).toEqual(sourceBefore);
            maintenance = createPrismaInsightsMaintenance(
              client,
              "mssql",
              insightsDatabaseNamespace,
            );
          }
        }
        expect(writerEvent).toBeDefined();
        expect({ processed, ready }).toEqual({
          processed: 50_002,
          ready: true,
        });

        const counts = await client.$queryRawUnsafe<
          {
            legacy_count: bigint;
            raw_count: bigint;
            computed_count: bigint;
            event_count: bigint;
            live_count: bigint;
            source_generation: bigint;
          }[]
        >(`select
          (select count_big(*) from bundle_events where id<>'${writerEvent!.id}') as legacy_count,
          (select count_big(*) from bundle_events) as raw_count,
          (select count_big(distinct private_hot_updater_prisma_insights_migration_id) from bundle_events) as computed_count,
          (select count_big(*) from ${PRISMA_INSIGHTS_EVENTS}) as event_count,
          (select count_big(*) from private_hot_updater_prisma_insights_live) as live_count,
          (select generation from private_hot_updater_prisma_insights_source where id=1) as source_generation`);
        expect(
          Object.fromEntries(
            Object.entries(counts[0]!).map(([key, value]) => [
              key,
              safeInteger(value),
            ]),
          ),
        ).toEqual({
          legacy_count: 50_001,
          raw_count: 50_002,
          computed_count: 50_002,
          event_count: 50_002,
          live_count: 50_002,
          source_generation: 50_002,
        });

        const stateAfter = await client.$queryRawUnsafe<
          {
            migration_upper_id: string;
            migration_after_id: string;
            ready: boolean;
          }[]
        >(
          "select migration_upper_id,migration_after_id,ready from private_hot_updater_prisma_insights_state where id=1",
        );
        expect(stateAfter[0]).toEqual({
          migration_upper_id: upper.id,
          migration_after_id: upper.id,
          ready: true,
        });

        const orderedEvents = await client.$queryRawUnsafe<
          { event_id: string; event_order: Uint8Array }[]
        >(`select top (10) event_id,event_order from ${PRISMA_INSIGHTS_EVENTS}
           order by event_order desc`);
        for (const row of orderedEvents) {
          expect(Buffer.from(row.event_order)).toEqual(
            eventOrder(row.event_id),
          );
        }
        expect(orderedEvents.map(({ event_id }) => event_id)).toEqual(
          orderedEvents
            .map(({ event_id }) => event_id)
            .toSorted()
            .reverse(),
        );

        const model = createPrismaInsightsModel(
          client,
          "mssql",
          insightsDatabaseNamespace,
        );
        resource.clearQueries();
        const drainedIds = new Set<string>();
        let eventCursor: string | undefined;
        let finalCursor: string | null | undefined;
        const beforeReceivedAtMs = 2_000_000_000_000;
        for (let pageIndex = 0; pageIndex < 600; pageIndex += 1) {
          const page = await model.pageEvents({
            selector: { kind: "all" },
            sinceReceivedAtMs: 0,
            beforeReceivedAtMs,
            limit: 100,
            ...(eventCursor === undefined ? {} : { cursor: eventCursor }),
          });
          expect(page.state).toBe("ready");
          if (page.state !== "ready") return;
          expect(page.data.data.length).toBeLessThanOrEqual(100);
          expect(page.data.consistency.cutoff).toEqual({
            kind: "event-time",
            beforeReceivedAtMs,
          });
          for (const event of page.data.data) {
            expect(drainedIds.has(event.id)).toBe(false);
            drainedIds.add(event.id);
          }
          finalCursor = page.data.nextCursor;
          if (finalCursor === null) break;
          eventCursor = finalCursor;
        }
        expect(finalCursor).toBeNull();
        expect(drainedIds.size).toBe(50_002);
        for (let value = 1; value <= 50_001; value += 1) {
          expect(drainedIds.has(scaleEventId(value))).toBe(true);
        }
        expect(drainedIds.has(writerEvent!.id)).toBe(true);
        expect(resource.queries.length).toBeGreaterThan(0);
        expect(
          resource.queries.some((query) => /\boffset\b/i.test(query)),
        ).toBe(false);

        resource.clearQueries();
        const drainedInstallIds = new Set<string>();
        let installationCursor: string | undefined;
        let finalInstallationCursor: string | null | undefined;
        for (let pageIndex = 0; pageIndex < 600; pageIndex += 1) {
          const page = await model.pageInstallations({
            kind: "all",
            limit: 100,
            ...(installationCursor === undefined
              ? {}
              : { cursor: installationCursor }),
          });
          expect(page.state).toBe("ready");
          if (page.state !== "ready") return;
          expect(page.data.data.length).toBeLessThanOrEqual(100);
          for (const installation of page.data.data) {
            expect(drainedInstallIds.has(installation.install_id)).toBe(false);
            drainedInstallIds.add(installation.install_id);
          }
          finalInstallationCursor = page.data.nextCursor;
          if (finalInstallationCursor === null) break;
          installationCursor = finalInstallationCursor;
        }
        expect(finalInstallationCursor).toBeNull();
        expect(drainedInstallIds.size).toBe(50_002);
        for (let value = 1; value <= 50_001; value += 1) {
          expect(drainedInstallIds.has(`scale-install-${value}`)).toBe(true);
        }
        expect(drainedInstallIds.has(writerEvent!.install_id)).toBe(true);
        expect(resource.queries.length).toBeGreaterThan(0);
        expect(
          resource.queries.some((query) => /\boffset\b/i.test(query)),
        ).toBe(false);

        const lower = boundaries.find(({ id }) => id !== upper.id)!;
        await assertMssqlPlanMatrix(client, {
          lowerLegacyId: lower.id,
          upperLegacyId: upper.id,
          installationId: "scale-install-25000",
          eventId: writerEvent!.id,
          sourceGeneration: 50_002,
        });
      },
    );

    it(
      "materializes exact long UTF-16 order in bounded runs",
      { timeout: 240_000 },
      async () => {
        const { client } = await createDatabase();
        expect(
          await preparePrismaInsights(
            client,
            "mssql",
            insightsDatabaseNamespace,
            {
              writersDrained: true,
            },
          ),
        ).toEqual({ ready: true });
        const model = createPrismaInsightsModel(
          client,
          "mssql",
          insightsDatabaseNamespace,
        );
        const longPrefix = "a".repeat(900);
        const cohorts = [
          `${longPrefix}\u{1f600}`,
          `${longPrefix}\ue000`,
          longPrefix,
          "alpha",
          "omega",
        ];
        const mainBundle = createBundleEventRowFixture("9400", 1).to_bundle_id;
        for (const [index, cohort] of cohorts.entries()) {
          await model.append({
            ...createBundleEventRowFixture(String(9401 + index), 100 + index),
            to_bundle_id: mainBundle,
            cohort,
          });
        }

        let detail = await model.getReport({
          query: { kind: "bundleDetail", bundleId: mainBundle, window: "all" },
        });
        expect(detail.state).toBe("preparing");
        if (detail.state !== "preparing") return;
        const detailJobId = detail.job.id;
        for (let step = 0; step < 200 && detail.state !== "ready"; step += 1) {
          const result = await runPrismaInsightsReportStep(client, "mssql", {
            jobId: detailJobId,
            maxItems: 2,
            maxRequests: 100,
          });
          expect(result.processed).toBeLessThanOrEqual(2);
          detail = await model.getReport({
            query: {
              kind: "bundleDetail",
              bundleId: mainBundle,
              window: "all",
            },
          });
        }
        expect(detail.state).toBe("ready");
        if (detail.state !== "ready") return;
        const page = await model.pageReport({
          publicationId: detail.data.id,
          section: "movementCohorts",
          metric: "installed",
          limit: 10,
        });
        expect(page.state).toBe("ready");
        if (page.state !== "ready") return;
        expect(
          page.data.data.map((row) => {
            if (!("cohort" in row)) throw new Error("expected cohort row");
            return row.cohort;
          }),
        ).toEqual(cohorts.toSorted());

        const sortRows = await client.$queryRawUnsafe<{ value: bigint }[]>(
          "select count_big(*) as value from private_hot_updater_prisma_insights_report_sort",
        );
        expect(sortRows[0]?.value).toBe(0n);
        const planMarker = `prisma_order_${randomUUID().replaceAll("-", "")}`;
        await client.$queryRawUnsafe(
          `select top (2) count_key,label,label_order,value
           from private_hot_updater_prisma_insights_report_counts
           where job_id='${detail.data.id}' and section='movementCohorts'
             and metric='installed' and bucket_start_ms=-1
             and count_key>0x${"00".repeat(32)} order by count_key asc
           /* ${planMarker} */`,
        );
        const cachedPlans = await client.$queryRawUnsafe<
          { plan_xml: string }[]
        >(`select convert(nvarchar(max),query_plan.query_plan) as plan_xml
           from sys.dm_exec_cached_plans cached_plan
           cross apply sys.dm_exec_sql_text(cached_plan.plan_handle) sql_text
           cross apply sys.dm_exec_query_plan(cached_plan.plan_handle) query_plan
           where sql_text.dbid=db_id() and sql_text.text like '%${planMarker}%'`);
        const countPlan = cachedPlans
          .map(({ plan_xml: planXml }) => planXml)
          .join("\n");
        expect(countPlan).toContain(
          "private_hot_updater_prisma_report_counts_source_idx",
        );
        expect(countPlan).toMatch(/Index Seek/);
      },
    );
  },
);

describe.skipIf(connectionString === undefined)(
  "Prisma SQL Server InsightsModel shared conformance",
  () => {
    registerInsightsModelTests(insightsConformance.createHarness);
  },
);
