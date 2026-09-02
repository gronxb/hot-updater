import { DatabaseSync, type SqliteValue } from "node:sqlite";

import {
  createUUIDv7After,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import { type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { expect, it } from "vitest";

import {
  createDrizzleInsightsQueries,
  runDrizzleInsightsMaintenanceStep,
} from ".";
import type { DrizzleDB } from "../../drizzleLazyDB";
import {
  DRIZZLE_INSIGHTS_EVENTS,
  DRIZZLE_INSIGHTS_JOBS,
  DRIZZLE_INSIGHTS_STATE,
} from "./schema";

const DATABASE_NAMESPACE = "00000000-0000-7000-8000-00000000d001";

const legacySchema = `
  create table bundle_events (
    id text primary key, type text not null, install_id text not null,
    user_id text, username text, from_release_id text, from_bundle_id text,
    to_release_id text, to_bundle_id text not null, platform text not null,
    app_version text not null, channel text not null, cohort text not null,
    update_strategy text, fingerprint_hash text, sdk_version text,
    received_at_ms integer not null
  )`;

const event = (
  id: string,
  receivedAtMs: number,
  installId: string,
): BundleEventRow => ({
  id,
  type: "UPDATE_APPLIED",
  install_id: installId,
  user_id: null,
  username: null,
  from_release_id: "release-before",
  from_bundle_id: "bundle-before",
  to_release_id: "release-after",
  to_bundle_id: "bundle-after",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "cohort-a",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
});

const createSQLiteDatabase = (
  onQuery: (statement: string, rows: number) => void = () => undefined,
) => {
  const native = new DatabaseSync(":memory:");
  native.exec(legacySchema);
  const dialect = new SQLiteSyncDialect();
  let database: DrizzleDB;
  const compile = (statement: SQL) => dialect.sqlToQuery(statement);
  database = {
    insightsQuery: async (statement: SQL) => {
      const query = compile(statement);
      const rows = native
        .prepare(query.sql)
        .all(...(query.params as SqliteValue[]));
      onQuery(query.sql, rows.length);
      return rows;
    },
    insightsMutation: async (statement: SQL) => {
      const query = compile(statement);
      native.prepare(query.sql).run(...(query.params as SqliteValue[]));
    },
    insightsTransaction: async <TResult>(
      operation: (transaction: DrizzleDB) => Promise<TResult>,
    ): Promise<TResult> => {
      native.exec("begin immediate");
      try {
        const result = await operation(database);
        native.exec("commit");
        return result;
      } catch (error) {
        native.exec("rollback");
        throw error;
      }
    },
  } as unknown as DrizzleDB;
  return { native, database };
};

it("serializes SQLite append, maintenance, and search transactions", async () => {
  const { native, database } = createSQLiteDatabase();
  let transactionStarts = 0;
  let stallNextTransaction = false;
  let markEntered = (): void => undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stalled = {
    ...database,
    insightsTransaction: async <TResult>(
      operation: (transaction: DrizzleDB) => Promise<TResult>,
    ): Promise<TResult> => {
      transactionStarts += 1;
      return database.insightsTransaction!(async (transaction) => {
        if (stallNextTransaction) {
          stallNextTransaction = false;
          markEntered();
          await released;
        }
        return operation(transaction);
      });
    },
  } as DrizzleDB;
  const queries = createDrizzleInsightsQueries(
    stalled,
    "sqlite",
    DATABASE_NAMESPACE,
  );
  const firstId = createUUIDv7After(null, 1_800_000_002_000);
  const secondId = createUUIDv7After(firstId, 1_800_000_002_001);

  try {
    await queries.append(event(firstId, 1_000, "queued-first"));
    const reserved = await queries.pageInstallations({
      kind: "contains",
      query: "queued-first",
      limit: 10,
    });
    expect(reserved.state).toBe("preparing");
    if (reserved.state !== "preparing") return;

    const baselineStarts = transactionStarts;
    stallNextTransaction = true;
    const append = queries.append(event(secondId, 1_001, "queued-second"));
    await entered;

    const outcomes = Promise.allSettled([
      queries.runMaintenanceStep({
        jobId: reserved.job.id,
        maxItems: 256,
        maxRequests: 512,
      }),
      queries.pageInstallations({
        kind: "contains",
        query: "queued-second",
        limit: 10,
      }),
    ]);
    for (let turn = 0; turn < 4; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const startsWhileBlocked = transactionStarts;

    release();
    await append;
    const completed = await outcomes;

    expect(startsWhileBlocked).toBe(baselineStarts + 1);
    expect(completed.map(({ status }) => status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
  } finally {
    release();
    native.close();
  }
});

it("rejects a same-named SQLite index with the wrong key order", async () => {
  const { native, database } = createSQLiteDatabase();
  const queries = createDrizzleInsightsQueries(
    database,
    "sqlite",
    DATABASE_NAMESPACE,
  );
  const id = createUUIDv7After(null, 1_800_000_003_000);
  await queries.append(event(id, 1_000, "install-a"));
  native.exec("drop index drizzle_insights_events_order_idx");
  native.exec(`create index drizzle_insights_events_order_idx
    on ${DRIZZLE_INSIGHTS_EVENTS}(event_type)`);

  await expect(
    queries.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 2_000,
      limit: 10,
    }),
  ).resolves.toMatchObject({
    state: "failed",
    error: { code: "index-not-ready" },
  });
  native.close();
});

it("rejects an unexpected SQLite Insights index", async () => {
  const { native, database } = createSQLiteDatabase();
  const queries = createDrizzleInsightsQueries(
    database,
    "sqlite",
    DATABASE_NAMESPACE,
  );
  await queries.append(
    event(createUUIDv7After(null, 1_800_000_003_100), 1_000, "install-a"),
  );
  native.exec(`create index drizzle_insights_unexpected_idx
    on ${DRIZZLE_INSIGHTS_EVENTS}(event_type)`);

  await expect(
    queries.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 2_000,
      limit: 10,
    }),
  ).resolves.toMatchObject({
    state: "failed",
    error: { code: "index-not-ready" },
  });
  native.close();
});

it("rejects an unexpected SQLite Insights table", async () => {
  const { native, database } = createSQLiteDatabase();
  const queries = createDrizzleInsightsQueries(
    database,
    "sqlite",
    DATABASE_NAMESPACE,
  );
  await queries.append(
    event(createUUIDv7After(null, 1_800_000_003_200), 1_000, "install-a"),
  );
  native.exec(`create table private_hot_updater_drizzle_insights_unexpected (
    id integer primary key
  )`);

  await expect(
    queries.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 2_000,
      limit: 10,
    }),
  ).resolves.toMatchObject({
    state: "failed",
    error: { code: "index-not-ready" },
  });
  native.close();
});

it("rejects a SQLite state table missing the revision constraint", async () => {
  const { native, database } = createSQLiteDatabase();
  const queries = createDrizzleInsightsQueries(
    database,
    "sqlite",
    DATABASE_NAMESPACE,
  );
  await queries.append(
    event(createUUIDv7After(null, 1_800_000_004_000), 1_000, "install-a"),
  );
  native.exec(`alter table ${DRIZZLE_INSIGHTS_STATE} rename to invalid_state`);
  native.exec(`create table ${DRIZZLE_INSIGHTS_STATE} (
    id integer primary key check (id = 1), revision integer not null,
    source_id text not null, status text not null, upper_id text,
    after_id text, error text, committed_seq integer not null,
    updated_at_ms integer not null,
    check (status in ('new','preparing','ready','failed'))
  )`);
  native.exec(`insert into ${DRIZZLE_INSIGHTS_STATE}
    select * from invalid_state`);
  native.exec("drop table invalid_state");

  await expect(
    queries.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 2_000,
      limit: 10,
    }),
  ).resolves.toMatchObject({
    state: "failed",
    error: { code: "index-not-ready" },
  });
  native.close();
});

it.each([
  ["committed_seq", "'invalid-sequence'"],
  ["source_id", "'invalid-source'"],
])(
  "returns storage corruption for malformed SQLite state %s",
  async (field, value) => {
    const { native, database } = createSQLiteDatabase();
    const queries = createDrizzleInsightsQueries(
      database,
      "sqlite",
      DATABASE_NAMESPACE,
    );
    await queries.append(
      event(createUUIDv7After(null, 1_800_000_004_100), 1_000, "install-a"),
    );
    native.exec(
      `update ${DRIZZLE_INSIGHTS_STATE} set ${field}=${value} where id=1`,
    );

    await expect(
      queries.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 2_000,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      versions: { sourceGeneration: null, projectionGeneration: null },
      error: { code: "storage-corruption" },
    });
    native.close();
  },
);

it("durably fails malformed SQLite search job metadata", async () => {
  const { native, database } = createSQLiteDatabase();
  const queries = createDrizzleInsightsQueries(
    database,
    "sqlite",
    DATABASE_NAMESPACE,
  );
  await queries.append(
    event(createUUIDv7After(null, 1_800_000_004_200), 1_000, "search-corrupt"),
  );
  const input = { kind: "contains" as const, query: "search", limit: 10 };
  const reserved = await queries.pageInstallations(input);
  if (reserved.state !== "preparing") throw new Error("expected search job");
  native
    .prepare(
      `update ${DRIZZLE_INSIGHTS_JOBS} set query_json='{' where job_id=?`,
    )
    .run(reserved.job.id);

  await expect(
    runDrizzleInsightsMaintenanceStep(
      database,
      "sqlite",
      DATABASE_NAMESPACE,
      reserved.job.id,
      { maxItems: 100, maxRequests: 128 },
    ),
  ).resolves.toMatchObject({ state: "failed" });
  expect(
    native
      .prepare(
        `select status,error from ${DRIZZLE_INSIGHTS_JOBS} where job_id=?`,
      )
      .get(reserved.job.id),
  ).toEqual({ status: "failed", error: "migration-poison" });
  await expect(queries.pageInstallations(input)).resolves.toMatchObject({
    state: "failed",
    versions: { sourceGeneration: null, projectionGeneration: null },
    error: { code: "storage-corruption" },
  });
  native.close();
});

it("durably fails malformed SQLite report job metadata", async () => {
  const { native, database } = createSQLiteDatabase();
  const queries = createDrizzleInsightsQueries(
    database,
    "sqlite",
    DATABASE_NAMESPACE,
  );
  await queries.append(
    event(createUUIDv7After(null, 1_800_000_004_300), 1_000, "report-corrupt"),
  );
  const input = { query: { kind: "installationOverview" as const } };
  const reserved = await queries.getReport(input);
  if (reserved.state !== "preparing") throw new Error("expected report job");
  native
    .prepare(
      `update ${DRIZZLE_INSIGHTS_JOBS} set query_json='{' where job_id=?`,
    )
    .run(reserved.job.id);

  await expect(
    runDrizzleInsightsMaintenanceStep(
      database,
      "sqlite",
      DATABASE_NAMESPACE,
      reserved.job.id,
      { maxItems: 100, maxRequests: 128 },
    ),
  ).resolves.toMatchObject({ state: "failed" });
  expect(
    native
      .prepare(
        `select status,error from ${DRIZZLE_INSIGHTS_JOBS} where job_id=?`,
      )
      .get(reserved.job.id),
  ).toEqual({ status: "failed", error: "migration-poison" });
  await expect(queries.getReport(input)).resolves.toMatchObject({
    state: "failed",
    versions: { sourceGeneration: null, projectionGeneration: null },
    error: { code: "storage-corruption" },
  });
  native.close();
});

it("reads at most requested limit plus one from the SQLite event index", async () => {
  let measuring = false;
  const rowCounts: number[] = [];
  const { native, database } = createSQLiteDatabase((statement, rows) => {
    if (
      measuring &&
      statement.includes(DRIZZLE_INSIGHTS_EVENTS) &&
      /select\s+e\.\*/i.test(statement)
    ) {
      rowCounts.push(rows);
    }
  });
  const queries = createDrizzleInsightsQueries(
    database,
    "sqlite",
    DATABASE_NAMESPACE,
  );
  let id: string | null = null;
  for (let index = 0; index < 15; index += 1) {
    id = createUUIDv7After(id, 1_800_000_011_000 + index);
    await queries.append(event(id, 1_000 + index, `install-${index}`));
  }
  measuring = true;
  const result = await queries.pageEvents({
    selector: { kind: "all" },
    beforeReceivedAtMs: 2_000,
    limit: 7,
  });

  expect(result).toMatchObject({
    state: "ready",
    data: { data: { length: 7 }, hasNext: true },
  });
  expect(rowCounts).toEqual([8]);
  native.close();
});

it("preflights oversized SQLite poison without materializing its raw row", async () => {
  let fullLegacyReads = 0;
  const { native, database } = createSQLiteDatabase((statement) => {
    if (/select \* from "bundle_events"/i.test(statement)) fullLegacyReads += 1;
  });
  const oversizedId = `00000000-${"x".repeat(100_000)}`;
  native
    .prepare(
      `insert into bundle_events values
        (?,'UPDATE_APPLIED','poison',null,null,'r0','b0','r1','b1','ios','1',
         'production','a','appVersion',null,null,1000)`,
    )
    .run(oversizedId);
  const queries = createDrizzleInsightsQueries(
    database,
    "sqlite",
    DATABASE_NAMESPACE,
  );
  const preparing = await queries.pageEvents({
    selector: { kind: "all" },
    beforeReceivedAtMs: 2_000,
    limit: 10,
  });
  expect(preparing).toMatchObject({ state: "preparing" });
  if (preparing.state !== "preparing") throw new Error("expected preparation");

  const poison = await runDrizzleInsightsMaintenanceStep(
    database,
    "sqlite",
    DATABASE_NAMESPACE,
    preparing.job.id,
    { maxItems: 100, maxRequests: 128 },
  );
  expect(poison.state).toBe("failed");
  await expect(
    queries.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 2_000,
      limit: 10,
    }),
  ).resolves.toMatchObject({
    state: "failed",
    error: { code: "migration-poison" },
  });
  expect(fullLegacyReads).toBe(0);
  expect(
    native
      .prepare("select length(id) size from bundle_events where install_id=?")
      .get("poison"),
  ).toEqual({ size: oversizedId.length });
  native.close();
});
