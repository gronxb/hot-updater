import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerInsightsModelTests } from "@hot-updater/test-utils";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../../../test-utils/src/databaseTestFixtures";
import {
  assertPrismaInsightsClient,
  runPrismaInsightsTransaction,
} from "./client";
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
import { insertPrismaInsightsIgnore } from "./rawStore";
import {
  createPrismaInsightsLayout,
  getPrismaInsightsSchemaSql,
  hasCompletePrismaInsightsLayout,
  PRISMA_INSIGHTS_LAYOUT_VERSION,
  PRISMA_INSIGHTS_MIGRATION_INDEX,
  PRISMA_INSIGHTS_REQUIRED_INDEXES,
  PRISMA_INSIGHTS_SEARCH_JOBS,
} from "./schema";
import { runPrismaInsightsSearchStep } from "./search";

const insightsDatabaseNamespace = "00000000-0000-7000-8000-00000000d003";

const databaseUrl = process.env.PRISMA_INSIGHTS_MYSQL_URL;
const fixtureDirectory = fileURLToPath(
  new URL("./fixtures/mysql", import.meta.url),
);
const generatedClientPath = join(
  fixtureDirectory,
  `runtime-acceptance-${process.pid}-${randomUUID()}`,
);
let generated: GeneratedEvidenceClient | undefined;

interface MySqlEvidenceDatabase {
  readonly admin: EvidencePrismaClient;
  readonly clients: EvidencePrismaClient[];
  readonly database: string;
  readonly url: string;
  disposed: boolean;
}

const evidenceDatabases = new Set<MySqlEvidenceDatabase>();

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
  throw new Error(`Unknown required MySQL index ${name}`);
};

const requiredIndexOwners = new Map(
  PRISMA_INSIGHTS_REQUIRED_INDEXES.map((name) => [name, indexOwner(name)]),
);

const requiredIndexColumns: Readonly<
  Record<string, readonly (readonly [string, "A" | "D"])[]>
> = {
  private_hot_updater_prisma_insights_events_global_idx: [
    ["received_at_ms", "D"],
    ["event_order", "D"],
  ],
  private_hot_updater_prisma_insights_events_install_idx: [
    ["install_key", "A"],
    ["type", "A"],
    ["received_at_ms", "D"],
    ["event_order", "D"],
  ],
  private_hot_updater_prisma_insights_events_to_bundle_idx: [
    ["type", "A"],
    ["to_bundle_id", "A"],
    ["received_at_ms", "D"],
    ["event_order", "D"],
  ],
  private_hot_updater_prisma_insights_events_from_bundle_idx: [
    ["type", "A"],
    ["from_bundle_id", "A"],
    ["received_at_ms", "D"],
    ["event_order", "D"],
  ],
  private_hot_updater_prisma_insights_aliases_source_idx: [
    ["source_generation", "A"],
    ["alias_key", "A"],
  ],
  private_hot_updater_prisma_search_jobs_state_idx: [
    ["state", "A"],
    ["id", "A"],
  ],
  private_hot_updater_prisma_report_jobs_state_idx: [
    ["state", "A"],
    ["id", "A"],
  ],
  private_hot_updater_prisma_report_members_page_idx: [
    ["job_id", "A"],
    ["section", "A"],
    ["metric", "A"],
    ["member_key", "A"],
  ],
  private_hot_updater_prisma_report_order_page_idx: [
    ["job_id", "A"],
    ["order_kind", "A"],
    ["metric", "A"],
    ["ordinal", "A"],
  ],
  private_hot_updater_prisma_report_counts_source_idx: [
    ["job_id", "A"],
    ["section", "A"],
    ["metric", "A"],
    ["bucket_start_ms", "A"],
    ["count_key", "A"],
  ],
  private_hot_updater_prisma_report_sort_page_idx: [
    ["job_id", "A"],
    ["order_kind", "A"],
    ["metric", "A"],
    ["sort_pass", "A"],
    ["sort_run", "A"],
    ["ordinal", "A"],
  ],
};

const requiredTables = [
  "bundle_events",
  "private_hot_updater_prisma_insights_ddl",
  "private_hot_updater_prisma_insights_state",
  "private_hot_updater_prisma_insights_source",
  "private_hot_updater_prisma_insights_events",
  "private_hot_updater_prisma_insights_live",
  "private_hot_updater_prisma_insights_aliases",
  "private_hot_updater_prisma_insights_search_heads",
  "private_hot_updater_prisma_insights_search_jobs",
  "private_hot_updater_prisma_insights_search_rows",
  "private_hot_updater_prisma_insights_report_heads",
  "private_hot_updater_prisma_insights_report_jobs",
  "private_hot_updater_prisma_insights_report_members",
  "private_hot_updater_prisma_insights_report_latest",
  "private_hot_updater_prisma_insights_report_counts",
  "private_hot_updater_prisma_insights_report_order",
  "private_hot_updater_prisma_insights_report_sort",
] as const;

const quoteIdentifier = (value: string): string => `\`${value}\``;

const createBundleEventsTable = (client: EvidencePrismaClient) =>
  client.$executeRawUnsafe(`create table bundle_events (
    id varchar(36) character set ascii collate ascii_bin primary key,
    type varchar(32) character set ascii collate ascii_bin not null,
    install_id text not null, user_id text null, username text null,
    from_release_id varchar(36) character set ascii collate ascii_bin null,
    from_bundle_id varchar(36) character set ascii collate ascii_bin null,
    to_release_id varchar(36) character set ascii collate ascii_bin null,
    to_bundle_id varchar(36) character set ascii collate ascii_bin not null,
    platform varchar(32) not null, app_version varchar(255) not null,
    channel varchar(255) not null, cohort varchar(255) not null,
    update_strategy varchar(32) null, fingerprint_hash text null,
    sdk_version varchar(255) null, received_at_ms double not null
  ) engine=InnoDB`);

const createDatabase = async (): Promise<MySqlEvidenceDatabase> => {
  if (!databaseUrl || !generated) {
    throw new Error("missing MySQL evidence runtime");
  }
  const database = `prisma_insights_${randomUUID().replaceAll("-", "")}`;
  const admin = new generated.PrismaClient({ datasourceUrl: databaseUrl });
  const resource: MySqlEvidenceDatabase = {
    admin,
    clients: [],
    database,
    url: "",
    disposed: false,
  };
  evidenceDatabases.add(resource);
  assertPrismaInsightsClient(admin);
  await admin.$executeRawUnsafe(
    `create database ${quoteIdentifier(database)} character set utf8mb4 collate utf8mb4_bin`,
  );
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  const client = new generated.PrismaClient({ datasourceUrl: url.toString() });
  assertPrismaInsightsClient(client);
  resource.clients.push(client);
  Reflect.set(resource, "url", url.toString());
  await createBundleEventsTable(client);
  return resource;
};

const addClient = (resource: MySqlEvidenceDatabase): EvidencePrismaClient => {
  if (!generated) throw new Error("missing MySQL evidence runtime");
  const client = new generated.PrismaClient({ datasourceUrl: resource.url });
  assertPrismaInsightsClient(client);
  resource.clients.push(client);
  return client;
};

const disposeDatabase = async (
  resource: MySqlEvidenceDatabase,
): Promise<void> => {
  if (resource.disposed) return;
  resource.disposed = true;
  evidenceDatabases.delete(resource);
  await Promise.allSettled(
    resource.clients.map((client) => client.$disconnect()),
  );
  await resource.admin.$executeRawUnsafe(
    `drop database if exists ${quoteIdentifier(resource.database)}`,
  );
  await resource.admin.$disconnect();
};

const insightsConformance = createPrismaInsightsConformanceFixture({
  provider: "mysql",
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

const uuid = (value: number, variant = "8"): string =>
  `00000000-0000-7000-${variant}000-${String(value).padStart(12, "0")}`;

const insertScaleRows = async (
  client: EvidencePrismaClient,
  count = 50_001,
): Promise<void> => {
  const columns = [
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
    "received_at_ms",
  ] as const;
  for (let offset = 0; offset < count; offset += 500) {
    const size = Math.min(500, count - offset);
    const values: unknown[] = [];
    const tuples = Array.from({ length: size }, (_, index) => {
      const value = offset + index + 1;
      values.push(
        uuid(value),
        "UPDATE_APPLIED",
        `scale-install-${value}`,
        "scale-user",
        `Scale installation ${value}`,
        null,
        uuid(100_000 + value, "9"),
        null,
        uuid(200_000 + value, "a"),
        "ios",
        "1.0.0",
        "production",
        "0",
        "appVersion",
        null,
        null,
        value,
      );
      return `(${columns.map(() => "?").join(",")})`;
    });
    const inserted = await client.$executeRawUnsafe(
      `insert into bundle_events (${columns.join(",")}) values ${tuples.join(",")}`,
      ...values,
    );
    expect(inserted).toBe(size);
  }
};

const finishScaleMigration = async (
  resource: MySqlEvidenceDatabase,
  initialClient: EvidencePrismaClient,
): Promise<{
  readonly client: EvidencePrismaClient;
  readonly processed: number;
  readonly writerId: string;
}> => {
  let client = initialClient;
  let total = 0;
  let writerId: string | undefined;
  for (let step = 0; step < 1_200; step += 1) {
    const result = await createPrismaInsightsMaintenance(
      client,
      "mysql",
      insightsDatabaseNamespace,
    ).runStep({
      maxItems: 200,
      maxRequests: 2_004,
    });
    expect(result.processed).toBeLessThanOrEqual(50);
    total += result.processed;
    if (step + 1 === 73) {
      expect(result.ready).toBe(false);
      await client.$disconnect();
      client = addClient(resource);
      await client.$queryRawUnsafe("select 1");
      const writer = {
        ...createBundleEventRowFixture("9301", 60_000),
        id: "10000000-0000-7000-8000-000000009301",
        install_id: "scale-writer-installation",
        user_id: "scale-writer",
      };
      await createPrismaInsightsModel(
        client,
        "mysql",
        insightsDatabaseNamespace,
      ).append(writer);
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThan(50_001);
      writerId = writer.id;
    }
    if (result.ready) {
      if (writerId === undefined) {
        throw new Error("MySQL scale writer was not appended");
      }
      return { client, processed: total, writerId };
    }
  }
  throw new Error("MySQL migration did not finish within its bounded steps");
};

const drainScaleEvents = async (
  client: EvidencePrismaClient,
  writerId: string,
): Promise<void> => {
  const captured = captureEvidencePrismaQueries(client);
  const model = createPrismaInsightsModel(
    captured.client,
    "mysql",
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
    await runPrismaInsightsSearchStep(client, "mysql", {
      maxItems: 200,
      maxRequests: 2_000,
    });
    result = await read();
  }
  return result;
};

const planKey = (rows: readonly Record<string, unknown>[]): string =>
  rows
    .map((row) => {
      const key = row.key ?? row.f6;
      return typeof key === "string" ? key : "";
    })
    .filter(Boolean)
    .join(" ");

const planText = (rows: readonly Record<string, unknown>[]): string =>
  rows
    .flatMap((row) => Object.values(row))
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();

const assertMySqlBoundedPlan = async (
  client: EvidencePrismaClient,
  input: {
    readonly expectedKeys: readonly string[];
    readonly limit: number;
    readonly query: string;
    readonly values?: readonly unknown[];
  },
): Promise<void> => {
  const values = input.values ?? [];
  const explained = await client.$queryRawUnsafe<Record<string, unknown>[]>(
    `explain ${input.query}`,
    ...values,
  );
  expect(
    input.expectedKeys.some((key) => planKey(explained).includes(key)),
    JSON.stringify(explained, (_key, value) =>
      typeof value === "bigint" ? Number(value) : value,
    ),
  ).toBe(true);
  expect(explained.every((row) => (row.type ?? row.f4) !== "ALL")).toBe(true);
  expect(
    explained.every(
      (row) =>
        !String(row.Extra ?? row.extra ?? row.f11 ?? "")
          .toLowerCase()
          .includes("filesort"),
    ),
  ).toBe(true);
  const analyzed = planText(
    await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `explain analyze ${input.query}`,
      ...values,
    ),
  );
  expect(analyzed).toContain(`limit: ${input.limit} row(s)`);
  expect(analyzed).not.toContain("table scan");
  expect(analyzed).not.toContain("sort:");
};

const seedMySqlPlanRows = async (
  client: EvidencePrismaClient,
): Promise<void> => {
  const countValues: unknown[] = [];
  const countTuples = Array.from({ length: 1_000 }, (_, value) => {
    const key = Buffer.alloc(32);
    key.writeUInt32BE(value, 28);
    countValues.push(
      "plan-report",
      key,
      "bundleDistribution",
      "",
      `bundle-${value}`,
      key,
      -1,
      1,
    );
    return "(?,?,?,?,?,?,?,?)";
  });
  await client.$executeRawUnsafe(
    `insert into private_hot_updater_prisma_insights_report_counts
     (job_id,count_key,section,metric,label,label_order,bucket_start_ms,value)
     values ${countTuples.join(",")}`,
    ...countValues,
  );

  const orderValues: unknown[] = [];
  const orderTuples = Array.from({ length: 1_000 }, (_, ordinal) => {
    orderValues.push(
      "plan-report",
      "bundleDistribution",
      "",
      ordinal,
      `bundle-${ordinal}`,
      1,
    );
    return "(?,?,?,?,?,?)";
  });
  await client.$executeRawUnsafe(
    `insert into private_hot_updater_prisma_insights_report_order
     (job_id,order_kind,metric,ordinal,label,value)
     values ${orderTuples.join(",")}`,
    ...orderValues,
  );

  const jobValues: unknown[] = [];
  const jobTuples = Array.from({ length: 1_000 }, (_, value) => {
    const key = Buffer.alloc(32);
    key.writeUInt32BE(value, 28);
    jobValues.push(
      `plan-${String(value).padStart(31, "0")}`,
      key,
      "{}",
      value < 500 ? "queued" : "preparing",
      "membership",
      50_002,
      0,
      null,
      0,
      0,
      null,
      null,
      0,
    );
    return "(?,?,?,?,?,?,?,?,?,?,?,?,?)";
  });
  await client.$executeRawUnsafe(
    `insert into private_hot_updater_prisma_insights_search_jobs
     (id,query_key,query_json,state,phase,source_generation,as_of_ms,
      completed_at_ms,after_generation,total,failure_json,lease_owner,lease_version)
     values ${jobTuples.join(",")}`,
    ...jobValues,
  );
  await client.$executeRawUnsafe(
    "analyze table private_hot_updater_prisma_insights_report_counts,private_hot_updater_prisma_insights_report_order,private_hot_updater_prisma_insights_search_jobs",
  );
};

const assertMySqlReadyPlanMatrix = async (
  client: EvidencePrismaClient,
  input: {
    readonly installKey: Uint8Array;
    readonly publicationId: string;
    readonly upperGeneration: number;
  },
): Promise<void> => {
  await client.$executeRawUnsafe(
    "analyze table private_hot_updater_prisma_insights_events,private_hot_updater_prisma_insights_live,private_hot_updater_prisma_insights_search_rows",
  );
  await assertMySqlBoundedPlan(client, {
    expectedKeys: ["private_hot_updater_prisma_insights_events_global_idx"],
    limit: 101,
    query: `select event_id from private_hot_updater_prisma_insights_events
      where received_at_ms>=0 and received_at_ms<60000
      order by received_at_ms desc,event_order desc limit 101`,
  });
  await assertMySqlBoundedPlan(client, {
    expectedKeys: ["private_hot_updater_prisma_insights_events_install_idx"],
    limit: 101,
    query: `select event_id from private_hot_updater_prisma_insights_events
      where install_key=? and type=? and received_at_ms>=0
        and received_at_ms<60000
      order by received_at_ms desc,event_order desc limit 101`,
    values: [input.installKey, "UPDATE_APPLIED"],
  });
  await assertMySqlBoundedPlan(client, {
    expectedKeys: ["source_generation"],
    limit: 200,
    query: `select source_generation,event_json
      from private_hot_updater_prisma_insights_events force index (source_generation)
      where source_generation>100 and source_generation<=?
      order by source_generation asc limit 200`,
    values: [input.upperGeneration],
  });
  await assertMySqlBoundedPlan(client, {
    expectedKeys: ["PRIMARY"],
    limit: 101,
    query: `select install_key,event_json
      from private_hot_updater_prisma_insights_live
      where install_key>? order by install_key asc limit 101`,
    values: [Buffer.alloc(32)],
  });
  await assertMySqlBoundedPlan(client, {
    expectedKeys: ["PRIMARY"],
    limit: 101,
    query: `select install_key,event_json
      from private_hot_updater_prisma_insights_search_rows
      where job_id=? and install_key>? and event_json is not null
      order by install_key asc limit 101`,
    values: [input.publicationId, Buffer.alloc(32)],
  });

  await seedMySqlPlanRows(client);
  await assertMySqlBoundedPlan(client, {
    expectedKeys: ["private_hot_updater_prisma_report_counts_source_idx"],
    limit: 200,
    query: `select count_key,label,label_order,value
      from private_hot_updater_prisma_insights_report_counts force index (private_hot_updater_prisma_report_counts_source_idx)
      where job_id=? and section=? and metric=? and bucket_start_ms=-1
        and count_key>?
      order by count_key asc limit 200`,
    values: ["plan-report", "bundleDistribution", "", Buffer.alloc(32)],
  });
  await assertMySqlBoundedPlan(client, {
    expectedKeys: [
      "PRIMARY",
      "private_hot_updater_prisma_report_order_page_idx",
    ],
    limit: 100,
    query: `select ordinal,label,value
      from private_hot_updater_prisma_insights_report_order
      where job_id=? and order_kind=? and metric=? and ordinal>=?
      order by ordinal asc limit 100`,
    values: ["plan-report", "bundleDistribution", "", 100],
  });
  for (const state of ["queued", "preparing"] as const) {
    await assertMySqlBoundedPlan(client, {
      expectedKeys: ["private_hot_updater_prisma_search_jobs_state_idx"],
      limit: 1,
      query: `select id,query_key,query_json,state,phase,source_generation,
          as_of_ms,completed_at_ms,after_generation,total,failure_json,
          lease_owner,lease_version
        from private_hot_updater_prisma_insights_search_jobs
        where state=? order by id asc limit 1 for update skip locked`,
      values: [state],
    });
  }
};

const assertLayoutCatalog = async (
  client: EvidencePrismaClient,
): Promise<void> => {
  const ownedIndexes = await client.$queryRawUnsafe<
    { index_name: string; table_name: string }[]
  >(`select distinct index_name as index_name,table_name as table_name
     from information_schema.statistics where table_schema=database()`);
  const ownedIndexNames = new Set(
    ownedIndexes.map(
      ({ index_name, table_name }) => `${table_name}:${index_name}`,
    ),
  );
  const missingOwners = [...requiredIndexOwners]
    .filter(([name, table]) => !ownedIndexNames.has(`${table}:${name}`))
    .map(([name, table]) => `${table}:${name}`);
  expect(
    missingOwners,
    [...ownedIndexNames]
      .filter((value) => value.includes("report_counts"))
      .join("\n"),
  ).toEqual([]);
  const shapes = await client.$queryRawUnsafe<
    {
      collation: "A" | "D" | null;
      column_name: string | null;
      expression: string | null;
      index_name: string;
      seq_in_index: bigint | number;
      sub_part: bigint | number | null;
    }[]
  >(
    `select index_name as index_name,seq_in_index as seq_in_index,
       column_name as column_name,expression as expression,
       collation as collation,sub_part as sub_part
     from information_schema.statistics where table_schema=database()
       and table_name in (${[...new Set(requiredIndexOwners.values())]
         .map(() => "?")
         .join(",")})
       and index_name in (${PRISMA_INSIGHTS_REQUIRED_INDEXES.map(() => "?").join(",")})
     order by index_name,seq_in_index`,
    ...new Set(requiredIndexOwners.values()),
    ...PRISMA_INSIGHTS_REQUIRED_INDEXES,
  );
  for (const [name, expected] of Object.entries(requiredIndexColumns)) {
    expect(
      shapes
        .filter(({ index_name }) => index_name === name)
        .map(({ collation, column_name, sub_part }) => [
          column_name,
          collation,
          sub_part === null ? null : Number(sub_part),
        ]),
    ).toEqual(expected.map(([column, direction]) => [column, direction, null]));
  }
  const migrationShape = shapes.filter(
    ({ index_name }) => index_name === PRISMA_INSIGHTS_MIGRATION_INDEX,
  );
  expect(migrationShape).toHaveLength(1);
  expect(migrationShape[0]).toMatchObject({
    collation: "A",
    column_name: null,
    sub_part: null,
  });
  expect(Number(migrationShape[0]?.seq_in_index)).toBe(1);
  expect(migrationShape[0]?.expression?.toLowerCase()).toContain("cast");
  expect(migrationShape[0]?.expression?.toLowerCase()).toContain("id");
  expect(migrationShape[0]?.expression?.toLowerCase()).toContain("binary");
  const engines = await client.$queryRawUnsafe<
    { table_name: string; engine: string }[]
  >(`select table_name as table_name,engine as engine from information_schema.tables
     where table_schema=database()`);
  const innoDbTables = new Set(
    engines.flatMap(({ table_name, engine }) =>
      engine === "InnoDB" ? [table_name] : [],
    ),
  );
  expect(requiredTables.filter((table) => !innoDbTables.has(table))).toEqual(
    [],
  );
  const projected = await client.$queryRawUnsafe<Record<string, unknown>[]>(
    `select distinct index_name as name,table_name as table_name
     from information_schema.statistics where table_schema=database()
       and index_name in (${PRISMA_INSIGHTS_REQUIRED_INDEXES.map(() => "?").join(",")})`,
    ...PRISMA_INSIGHTS_REQUIRED_INDEXES,
  );
  expect(Object.keys(projected[0] ?? {}).sort()).toEqual([
    "name",
    "table_name",
  ]);
  const ready = await hasCompletePrismaInsightsLayout(
    client,
    "mysql",
    insightsDatabaseNamespace,
  );
  expect(
    ready,
    JSON.stringify(
      shapes.filter(
        ({ index_name }) =>
          index_name === PRISMA_INSIGHTS_MIGRATION_INDEX ||
          index_name === "private_hot_updater_prisma_report_sort_page_idx",
      ),
      (_key, value) => (typeof value === "bigint" ? Number(value) : value),
    ),
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

describe.skipIf(!databaseUrl)("Prisma Insights MySQL evidence", () => {
  it("rejects an unexpected private catalog column", async () => {
    const resource = await createDatabase();
    const client = resource.clients[0]!;
    await createPrismaInsightsLayout(
      client,
      "mysql",
      insightsDatabaseNamespace,
    );
    await expect(
      hasCompletePrismaInsightsLayout(
        client,
        "mysql",
        insightsDatabaseNamespace,
      ),
    ).resolves.toBe(true);
    await client.$executeRawUnsafe(
      "alter table private_hot_updater_prisma_insights_report_jobs add column unexpected_value bigint null",
    );
    await expect(
      hasCompletePrismaInsightsLayout(
        client,
        "mysql",
        insightsDatabaseNamespace,
      ),
    ).resolves.toBe(false);
  });

  it(
    "backfills 50,001 installations with exact totals and bounded plans",
    { timeout: 1_800_000 },
    async () => {
      const resource = await createDatabase();
      let client = resource.clients[0]!;
      await insertScaleRows(client);
      await client.$executeRawUnsafe(`create table migration_index_decoy (
        id varchar(36) primary key,
        key ${PRISMA_INSIGHTS_MIGRATION_INDEX} (id)
      ) engine=InnoDB`);
      const concurrent = addClient(resource);

      await Promise.all([
        createPrismaInsightsLayout(client, "mysql", insightsDatabaseNamespace),
        createPrismaInsightsLayout(
          concurrent,
          "mysql",
          insightsDatabaseNamespace,
        ),
      ]);

      const ledger = await client.$queryRawUnsafe<
        { ordinal: number; hash_bytes: bigint | number }[]
      >(
        `select ordinal,length(statement_hash) as hash_bytes
         from private_hot_updater_prisma_insights_ddl
         where layout_version=? order by ordinal`,
        PRISMA_INSIGHTS_LAYOUT_VERSION,
      );
      expect(ledger).toHaveLength(getPrismaInsightsSchemaSql("mysql").length);
      expect(ledger.map(({ ordinal }) => ordinal)).toEqual(
        ledger.map((_, index) => index),
      );
      expect(ledger.every(({ hash_bytes }) => Number(hash_bytes) === 32)).toBe(
        true,
      );

      await assertLayoutCatalog(client);
      await assertMySqlBoundedPlan(client, {
        expectedKeys: [PRISMA_INSIGHTS_MIGRATION_INDEX],
        limit: 200,
        query: `select id from bundle_events
          where cast(id as binary)>cast(? as binary)
            and cast(id as binary)<=cast(? as binary)
          order by cast(id as binary) asc limit 200`,
        values: [uuid(100), uuid(50_001)],
      });
      await expect(
        Promise.all([
          preparePrismaInsights(client, "mysql", insightsDatabaseNamespace, {
            writersDrained: true,
          }),
          preparePrismaInsights(
            concurrent,
            "mysql",
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
          (select count(*) from bundle_events where left(id,9)='00000000-') as legacy_events,
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

      const migrationIndex = await client.$queryRawUnsafe<
        { index_name: string; expression: string | null }[]
      >(
        `select index_name as index_name,expression as expression from information_schema.statistics
         where table_schema=database() and table_name='bundle_events'
           and index_name=?`,
        PRISMA_INSIGHTS_MIGRATION_INDEX,
      );
      expect(migrationIndex).toHaveLength(1);
      const expression = migrationIndex[0]?.expression?.toLowerCase() ?? "";
      expect(expression).toContain("cast");
      expect(expression).toContain("id");
      expect(expression).toContain("binary");

      const indexes = await client.$queryRawUnsafe<{ index_name: string }[]>(
        `select distinct index_name as index_name from information_schema.statistics
         where table_schema=database()`,
      );
      const indexNames = new Set(indexes.map(({ index_name }) => index_name));
      expect(
        PRISMA_INSIGHTS_REQUIRED_INDEXES.every((name) => indexNames.has(name)),
      ).toBe(true);

      const model = createPrismaInsightsModel(
        client,
        "mysql",
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
      await assertMySqlReadyPlanMatrix(client, {
        installKey,
        publicationId: cutoff.publication.id,
        upperGeneration: 50_002,
      });
    },
  );

  it(
    "uses bounded native plans for every MySQL page and worker path",
    { timeout: 600_000 },
    async () => {
      const resource = await createDatabase();
      const client = resource.clients[0]!;
      await insertScaleRows(client, 1_000);
      await createPrismaInsightsLayout(
        client,
        "mysql",
        insightsDatabaseNamespace,
      );
      await assertMySqlBoundedPlan(client, {
        expectedKeys: [PRISMA_INSIGHTS_MIGRATION_INDEX],
        limit: 200,
        query: `select id from bundle_events
          where cast(id as binary)>cast(? as binary)
            and cast(id as binary)<=cast(? as binary)
          order by cast(id as binary) asc limit 200`,
        values: [uuid(100), uuid(1_000)],
      });
      await expect(
        preparePrismaInsights(client, "mysql", insightsDatabaseNamespace, {
          writersDrained: true,
        }),
      ).resolves.toEqual({ ready: false });

      let migrated = 0;
      for (let step = 0; step < 25; step += 1) {
        const result = await createPrismaInsightsMaintenance(
          client,
          "mysql",
          insightsDatabaseNamespace,
        ).runStep({ maxItems: 200, maxRequests: 2_004 });
        expect(result.processed).toBeLessThanOrEqual(50);
        migrated += result.processed;
        if (result.ready) break;
      }
      expect(migrated).toBe(1_000);

      const model = createPrismaInsightsModel(
        client,
        "mysql",
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
      await assertMySqlReadyPlanMatrix(client, {
        installKey: Buffer.from(liveKeys[0]!.install_key),
        publicationId: cutoff.publication.id,
        upperGeneration: 1_000,
      });
    },
  );

  it(
    "leases two MySQL search jobs independently and rejects stale fences",
    { timeout: 180_000 },
    async () => {
      const resource = await createDatabase();
      const client = resource.clients[0]!;
      const other = addClient(resource);
      await createPrismaInsightsLayout(
        client,
        "mysql",
        insightsDatabaseNamespace,
      );
      await expect(
        preparePrismaInsights(client, "mysql", insightsDatabaseNamespace, {
          writersDrained: true,
        }),
      ).resolves.toEqual({ ready: true });
      const model = createPrismaInsightsModel(
        client,
        "mysql",
        insightsDatabaseNamespace,
      );
      await model.append({
        ...createBundleEventRowFixture("9401", 100),
        user_id: "lease-one",
      });
      await model.append({
        ...createBundleEventRowFixture("9402", 200),
        user_id: "lease-two",
      });
      const first = await model.pageInstallations({
        kind: "userId",
        userId: "lease-one",
        limit: 10,
      });
      const second = await model.pageInstallations({
        kind: "userId",
        userId: "lease-two",
        limit: 10,
      });
      expect(first.state).toBe("preparing");
      expect(second.state).toBe("preparing");
      if (first.state !== "preparing" || second.state !== "preparing") return;
      expect(first.job.id).not.toBe(second.job.id);

      const claimed = await Promise.all([
        runPrismaInsightsSearchStep(client, "mysql", {
          maxItems: 1,
          maxRequests: 8,
        }),
        runPrismaInsightsSearchStep(other, "mysql", {
          maxItems: 1,
          maxRequests: 8,
        }),
      ]);
      expect(new Set(claimed.map(({ jobId }) => jobId))).toEqual(
        new Set([first.job.id, second.job.id]),
      );

      const leases = await client.$queryRawUnsafe<
        { id: string; lease_owner: string; lease_version: bigint }[]
      >(
        `select id,lease_owner,lease_version from ${PRISMA_INSIGHTS_SEARCH_JOBS}
         where id in (?,?) order by id`,
        first.job.id,
        second.job.id,
      );
      expect(leases).toHaveLength(2);
      const lease = leases[0]!;
      expect(typeof lease.lease_owner).toBe("string");
      const staleVersion = Number(lease.lease_version) - 1;
      await expect(
        client.$executeRawUnsafe(
          `update ${PRISMA_INSIGHTS_SEARCH_JOBS} set after_generation=after_generation
           where id=? and lease_owner=? and lease_version=?`,
          lease.id,
          lease.lease_owner,
          staleVersion,
        ),
      ).resolves.toBe(0);
      await expect(
        client.$executeRawUnsafe(
          `update ${PRISMA_INSIGHTS_SEARCH_JOBS} set after_generation=after_generation
           where id=? and lease_owner=? and lease_version=?`,
          lease.id,
          "00000000-0000-7000-8000-000000000000",
          lease.lease_version,
        ),
      ).resolves.toBe(0);
    },
  );

  it(
    "ignores a wrong-owner MySQL migration-index decoy",
    { timeout: 180_000 },
    async () => {
      const resource = await createDatabase();
      const client = resource.clients[0]!;
      await client.$executeRawUnsafe(`create table migration_index_decoy (
        id varchar(36) primary key,
        key ${PRISMA_INSIGHTS_MIGRATION_INDEX} (id)
      ) engine=InnoDB`);
      await createPrismaInsightsLayout(
        client,
        "mysql",
        insightsDatabaseNamespace,
      );
      await assertLayoutCatalog(client);
    },
  );

  it(
    "uses strict MySQL duplicate semantics without coercion warnings",
    { timeout: 180_000 },
    async () => {
      const resource = await createDatabase();
      const client = resource.clients[0]!;
      await client.$executeRawUnsafe(`create table strict_duplicate_probe (
        id varchar(36) character set ascii collate ascii_bin primary key,
        value varchar(3) not null
      ) engine=InnoDB`);
      const row = {
        id: "00000000-0000-7000-8000-000000009801",
        value: "abc",
      };
      const observed = await runPrismaInsightsTransaction(
        client,
        "mysql",
        async (transaction) => {
          const inserted = await insertPrismaInsightsIgnore(
            transaction,
            "mysql",
            "strict_duplicate_probe",
            row,
            ["id"],
          );
          const duplicate = await insertPrismaInsightsIgnore(
            transaction,
            "mysql",
            "strict_duplicate_probe",
            row,
            ["id"],
          );
          return { duplicate, inserted };
        },
      );
      expect(observed).toEqual({
        duplicate: 0,
        inserted: 1,
      });
      await expect(
        insertPrismaInsightsIgnore(
          client,
          "mysql",
          "strict_duplicate_probe",
          {
            id: "00000000-0000-7000-8000-000000009802",
            value: "abcdef",
          },
          ["id"],
        ),
      ).rejects.toThrow();
      await expect(
        client.$queryRawUnsafe(
          "select id,value from strict_duplicate_probe order by id",
        ),
      ).resolves.toEqual([row]);
    },
  );

  it(
    "preflights and durably records oversized MySQL legacy poison",
    { timeout: 180_000 },
    async () => {
      const resource = await createDatabase();
      const client = resource.clients[0]!;
      const poison = {
        ...createBundleEventRowFixture("9501", 100),
        username: "x".repeat(20_481),
      };
      await client.$executeRawUnsafe(
        `insert into bundle_events (
          id,type,install_id,user_id,username,from_release_id,from_bundle_id,
          to_release_id,to_bundle_id,platform,app_version,channel,cohort,
          update_strategy,fingerprint_hash,sdk_version,received_at_ms
        ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        preparePrismaInsights(client, "mysql", insightsDatabaseNamespace, {
          writersDrained: true,
        }),
      ).resolves.toEqual({ ready: false });
      const maintenance = createPrismaInsightsMaintenance(
        client,
        "mysql",
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
          ready: 0,
          failed_reason: `migration-poison:${poison.id}`,
          private_events: 0n,
        },
      ]);
    },
  );

  it(
    "rejects a same-owner MySQL index with a malformed key shape",
    { timeout: 180_000 },
    async () => {
      const resource = await createDatabase();
      const client = resource.clients[0]!;
      await createPrismaInsightsLayout(
        client,
        "mysql",
        insightsDatabaseNamespace,
      );
      await client.$executeRawUnsafe(
        "alter table private_hot_updater_prisma_insights_events drop index private_hot_updater_prisma_insights_events_global_idx",
      );
      await client.$executeRawUnsafe(
        "create index private_hot_updater_prisma_insights_events_global_idx on private_hot_updater_prisma_insights_events (event_order)",
      );
      const actual = await client.$queryRawUnsafe<
        { collation: string; column_name: string; seq_in_index: bigint }[]
      >(`select seq_in_index as seq_in_index,column_name as column_name,
           collation as collation
         from information_schema.statistics where table_schema=database()
           and table_name='private_hot_updater_prisma_insights_events'
           and index_name='private_hot_updater_prisma_insights_events_global_idx'
         order by seq_in_index`);
      expect(
        actual.map(({ collation, column_name }) => [column_name, collation]),
      ).toEqual([["event_order", "A"]]);
      await expect(
        hasCompletePrismaInsightsLayout(
          client,
          "mysql",
          insightsDatabaseNamespace,
        ),
      ).resolves.toBe(false);
    },
  );
});

describe.skipIf(!databaseUrl)(
  "Prisma MySQL InsightsModel shared conformance",
  () => {
    registerInsightsModelTests(insightsConformance.createHarness);
  },
);
