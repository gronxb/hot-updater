import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SqliteValue } from "node:sqlite";

import type {
  BundleEventRow,
  InsightsInitialPublishedInstallationPage,
  InsightsInitialPublishedInstallationPageInput,
  InsightsInstallationPage,
  InsightsInstallationPageInput,
  InsightsLiveInstallationPage,
  InsightsLiveInstallationPageInput,
  InsightsPinnedInstallationPage,
  InsightsPinnedInstallationPageInput,
  InsightsPublishedInstallationContinuation,
  InsightsPublishedInstallationContinuationInput,
  InsightsPublishedInstallationPage,
  InsightsPublishedInstallationPageInput,
} from "@hot-updater/plugin-core";
import { createUUIDv7After } from "@hot-updater/plugin-core";
import {
  getInsightsInstallationOrderKey,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  type RequiredInsightsModel,
} from "@hot-updater/plugin-core/internal";
import {
  type RequiredInsightsModelConformanceHarness,
  registerRequiredInsightsModelTests,
} from "@hot-updater/test-utils";
import { type SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { execa } from "execa";
import { createConnection, type Connection } from "mysql2/promise";
import { Client } from "pg";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import {
  createDrizzleInsightsQueries,
  runDrizzleInsightsMaintenanceStep,
} from ".";
import type { DrizzleProvider } from "../../drizzle";
import type { DrizzleDB } from "../../drizzleLazyDB";
import {
  DRIZZLE_INSIGHTS_EVENTS,
  DRIZZLE_INSIGHTS_JOBS,
  DRIZZLE_INSIGHTS_LIVE,
  DRIZZLE_INSIGHTS_REPORT_DISTINCT,
  DRIZZLE_INSIGHTS_REPORT_LATEST,
  DRIZZLE_INSIGHTS_REPORT_OUTPUT,
  DRIZZLE_INSIGHTS_SEARCH_RESULTS,
  DRIZZLE_INSIGHTS_STATE,
} from "./schema";
import { drizzleInsightsSemanticKey } from "./storage";

const candidateTables = [
  DRIZZLE_INSIGHTS_EVENTS,
  DRIZZLE_INSIGHTS_LIVE,
  DRIZZLE_INSIGHTS_SEARCH_RESULTS,
  DRIZZLE_INSIGHTS_REPORT_OUTPUT,
] as const;

const legacySchema = (provider: DrizzleProvider): string => {
  const id =
    provider === "postgresql"
      ? "uuid"
      : provider === "mysql"
        ? "varchar(36) character set ascii collate ascii_bin"
        : "text";
  const text = provider === "mysql" ? "varchar(1024)" : "text";
  const nullableText = text;
  const integer = provider === "sqlite" ? "integer" : "bigint";
  return `create table bundle_events (
    id ${id} primary key, type varchar(32) not null,
    install_id ${text} not null, user_id ${nullableText},
    username ${nullableText}, from_release_id ${nullableText},
    from_bundle_id ${nullableText}, to_release_id ${nullableText},
    to_bundle_id ${text} not null, platform varchar(32) not null,
    app_version ${text} not null, channel ${text} not null,
    cohort ${text} not null, update_strategy varchar(32),
    fingerprint_hash ${nullableText}, sdk_version ${nullableText},
    received_at_ms ${integer} not null
  )`;
};

class CandidateMeter {
  #current = 0;
  #last = 0;
  #measuring = false;
  #sawCandidateRead = false;

  async measure<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    this.#current = 0;
    this.#measuring = true;
    this.#sawCandidateRead = false;
    try {
      return await operation();
    } finally {
      if (this.#sawCandidateRead) this.#last = this.#current;
      this.#measuring = false;
    }
  }

  record(sqlText: string, rowCount: number): void {
    if (!this.#measuring) return;
    const normalized = sqlText.toLowerCase();
    if (
      !normalized.trimStart().startsWith("select") ||
      !normalized.includes("order by") ||
      !normalized.includes("limit") ||
      !candidateTables.some((table) => normalized.includes(table))
    ) {
      return;
    }
    this.#sawCandidateRead = true;
    this.#current += rowCount;
  }

  get last(): number {
    return this.#last;
  }
}

type NativeNamespace = {
  readonly database: DrizzleDB;
  readonly meter: CandidateMeter;
  readonly provider: DrizzleProvider;
  readonly sqlitePath?: string;
  readonly openDatabase?: () => Promise<{
    readonly database: DrizzleDB;
    readonly close: () => Promise<void>;
  }>;
  readonly execute: (
    statement: string,
    parameters?: readonly unknown[],
  ) => Promise<readonly Record<string, unknown>[]>;
  readonly close: () => Promise<void>;
};

const namespaces: NativeNamespace[] = [];

const instrumentModel = (
  model: RequiredInsightsModel,
  meter: CandidateMeter,
  beforeOperation: () => Promise<void> = () => Promise.resolve(),
): RequiredInsightsModel => {
  function pageInstallations(
    input: InsightsLiveInstallationPageInput,
  ): Promise<InsightsLiveInstallationPage>;
  function pageInstallations(
    input: InsightsInitialPublishedInstallationPageInput,
  ): Promise<InsightsInitialPublishedInstallationPage>;
  function pageInstallations(
    input: InsightsPinnedInstallationPageInput,
  ): Promise<InsightsPinnedInstallationPage>;
  function pageInstallations(
    input: InsightsPublishedInstallationContinuationInput,
  ): Promise<InsightsPublishedInstallationContinuation>;
  function pageInstallations(
    input: InsightsPublishedInstallationPageInput,
  ): Promise<InsightsPublishedInstallationPage>;
  function pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage>;
  function pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage> {
    return meter.measure(async () => {
      await beforeOperation();
      return model.pageInstallations(input);
    });
  }

  return {
    append: (row: BundleEventRow) =>
      meter.measure(async () => {
        await beforeOperation();
        return model.append(row);
      }),
    pageEvents: (input) =>
      meter.measure(async () => {
        await beforeOperation();
        return model.pageEvents(input);
      }),
    pageInstallations,
    getReport: (input) =>
      meter.measure(async () => {
        await beforeOperation();
        return model.getReport(input);
      }),
    pageReport: (input) =>
      meter.measure(async () => {
        await beforeOperation();
        return model.pageReport(input);
      }),
  };
};

const createSQLiteNamespace = async (
  sqlitePath = ":memory:",
): Promise<NativeNamespace> => {
  const native = new DatabaseSync(sqlitePath);
  native.exec(legacySchema("sqlite"));
  const dialect = new SQLiteSyncDialect();
  const meter = new CandidateMeter();
  let database: DrizzleDB;
  const compile = (statement: SQL) => dialect.sqlToQuery(statement);
  database = {
    insightsQuery: async (statement: SQL) => {
      const query = compile(statement);
      const rows = native
        .prepare(query.sql)
        .all(...(query.params as SqliteValue[]));
      meter.record(query.sql, rows.length);
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
  const namespace: NativeNamespace = {
    database,
    meter,
    provider: "sqlite",
    ...(sqlitePath === ":memory:" ? {} : { sqlitePath }),
    execute: async (statement, parameters = []) =>
      native.prepare(statement).all(...(parameters as SqliteValue[])) as Record<
        string,
        unknown
      >[],
    close: async () => {
      native.close();
      if (sqlitePath !== ":memory:") await unlink(sqlitePath);
    },
  };
  namespaces.push(namespace);
  return namespace;
};

const uniqueName = (prefix: string): string =>
  `${prefix}_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;

const postgresqlDatabase = (
  client: Client,
  meter = new CandidateMeter(),
): DrizzleDB => {
  const dialect = new PgDialect();
  let database: DrizzleDB;
  const compile = (statement: SQL) => dialect.sqlToQuery(statement);
  database = {
    insightsQuery: async (statement: SQL) => {
      const query = compile(statement);
      const result = await client.query(query.sql, query.params);
      meter.record(query.sql, result.rows.length);
      return result.rows as Record<string, unknown>[];
    },
    insightsMutation: async (statement: SQL) => {
      const query = compile(statement);
      await client.query(query.sql, query.params);
    },
    insightsTransaction: async <TResult>(
      operation: (transaction: DrizzleDB) => Promise<TResult>,
    ): Promise<TResult> => {
      await client.query("begin");
      try {
        const result = await operation(database);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    },
  } as unknown as DrizzleDB;
  return database;
};

const createPostgreSQLNamespace = async (
  connectionString: string,
): Promise<NativeNamespace> => {
  const schema = uniqueName("drizzle_insights");
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`create schema "${schema}"`);
  await admin.end();
  const scoped = new URL(connectionString);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const client = new Client({ connectionString: scoped.toString() });
  await client.connect();
  await client.query(legacySchema("postgresql"));
  const meter = new CandidateMeter();
  const database = postgresqlDatabase(client, meter);
  const namespace: NativeNamespace = {
    database,
    meter,
    provider: "postgresql",
    openDatabase: async () => {
      const connection = new Client({ connectionString: scoped.toString() });
      await connection.connect();
      return {
        database: postgresqlDatabase(connection),
        close: () => connection.end(),
      };
    },
    execute: async (statement, parameters = []) =>
      (await client.query(statement, [...parameters])).rows as Record<
        string,
        unknown
      >[],
    close: async () => {
      await client.query(`drop schema "${schema}" cascade`);
      await client.end();
    },
  };
  namespaces.push(namespace);
  return namespace;
};

const mysqlRows = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) && Array.isArray(value[0])
    ? (value[0] as Record<string, unknown>[])
    : [];

const mysqlDatabase = (
  client: Connection,
  meter = new CandidateMeter(),
): DrizzleDB => {
  const dialect = new MySqlDialect();
  let database: DrizzleDB;
  const compile = (statement: SQL) => dialect.sqlToQuery(statement);
  database = {
    insightsQuery: async (statement: SQL) => {
      const query = compile(statement);
      const result = await client.query(query.sql, query.params);
      const rows = mysqlRows(result);
      meter.record(query.sql, rows.length);
      return rows;
    },
    insightsMutation: async (statement: SQL) => {
      const query = compile(statement);
      await client.query(query.sql, query.params);
    },
    insightsTransaction: async <TResult>(
      operation: (transaction: DrizzleDB) => Promise<TResult>,
    ): Promise<TResult> => {
      await client.beginTransaction();
      try {
        const result = await operation(database);
        await client.commit();
        return result;
      } catch (error) {
        await client.rollback();
        throw error;
      }
    },
  } as unknown as DrizzleDB;
  return database;
};

const createMySQLNamespace = async (
  connectionString: string,
): Promise<NativeNamespace> => {
  const databaseName = uniqueName("drizzle_insights");
  const admin = await createConnection(connectionString);
  await admin.query(`create database \`${databaseName}\``);
  await admin.end();
  const scoped = new URL(connectionString);
  scoped.pathname = `/${databaseName}`;
  const client: Connection = await createConnection(scoped.toString());
  await client.query(legacySchema("mysql"));
  const meter = new CandidateMeter();
  const database = mysqlDatabase(client, meter);
  const namespace: NativeNamespace = {
    database,
    meter,
    provider: "mysql",
    openDatabase: async () => {
      const connection = await createConnection(scoped.toString());
      return {
        database: mysqlDatabase(connection),
        close: () => connection.end(),
      };
    },
    execute: async (statement, parameters = []) =>
      mysqlRows(await client.query(statement, [...parameters])),
    close: async () => {
      await client.query("use mysql");
      await client.query(`drop database \`${databaseName}\``);
      await client.end();
    },
  };
  namespaces.push(namespace);
  return namespace;
};

const deletePublication = async (
  namespace: NativeNamespace,
  publicationId: string,
): Promise<void> => {
  const placeholder = namespace.provider === "postgresql" ? "$1" : "?";
  for (const table of [
    DRIZZLE_INSIGHTS_SEARCH_RESULTS,
    DRIZZLE_INSIGHTS_REPORT_DISTINCT,
    DRIZZLE_INSIGHTS_REPORT_LATEST,
    DRIZZLE_INSIGHTS_REPORT_OUTPUT,
    DRIZZLE_INSIGHTS_JOBS,
  ]) {
    await namespace.execute(
      `delete from ${table} where job_id=${placeholder}`,
      [publicationId],
    );
  }
};

const insertNativePrivatePoison = async (namespace: NativeNamespace) => {
  const placeholder =
    namespace.provider === "postgresql"
      ? (index: number) => `$${index}`
      : () => "?";
  await namespace.execute(
    `insert into ${DRIZZLE_INSIGHTS_EVENTS} (
      event_id,event_order_key,received_at_ms,event_type,install_id,
      install_key,user_alias,username_alias,from_bundle_id,from_bundle_key,
      to_bundle_id,to_bundle_key,raw_event
    ) values (${Array.from({ length: 13 }, (_, index) => placeholder(index + 1)).join(",")})`,
    [
      "00000000-0000-7000-8000-0000000000ff",
      Buffer.from("000000000000700080000000000000ff", "hex"),
      999,
      "UNCHANGED",
      "poison-installation",
      "f".repeat(64),
      null,
      null,
      null,
      null,
      "10000000-0000-7000-8000-000000000001",
      drizzleInsightsSemanticKey([
        "bundle",
        "10000000-0000-7000-8000-000000000001",
      ]),
      "{",
    ],
  );
  await namespace.execute(
    `update ${DRIZZLE_INSIGHTS_STATE} set committed_seq=(
      select coalesce(max(seq),0) from ${DRIZZLE_INSIGHTS_EVENTS}) where id=1`,
  );
};

const createHarness =
  (
    createNamespace: () => Promise<NativeNamespace>,
  ): (() => Promise<RequiredInsightsModelConformanceHarness>) =>
  async () => {
    const primary = await createNamespace();
    const other = await createNamespace();
    const completed = new Set<string>();
    const pendingExpiry = new Set<string>();
    const applyExpiry = async (): Promise<void> => {
      for (const publicationId of pendingExpiry) {
        await deletePublication(primary, publicationId);
        pendingExpiry.delete(publicationId);
      }
    };
    const facade = (): RequiredInsightsModelConformanceHarness => ({
      model: instrumentModel(
        createDrizzleInsightsQueries(primary.database, primary.provider),
        primary.meter,
        applyExpiry,
      ),
      otherNamespaceModel: instrumentModel(
        createDrizzleInsightsQueries(other.database, other.provider),
        other.meter,
      ),
      async runJobStep(jobId, input) {
        await applyExpiry();
        const result = await runDrizzleInsightsMaintenanceStep(
          primary.database,
          primary.provider,
          jobId,
          input,
        );
        if (result.state === "complete") completed.add(jobId);
        return result;
      },
      runOtherNamespaceJobStep: (jobId, input) =>
        runDrizzleInsightsMaintenanceStep(
          other.database,
          other.provider,
          jobId,
          input,
        ),
      async insertMigrationPoisonRow() {
        await insertNativePrivatePoison(primary);
      },
      setCurrentTimeMs(nowMs) {
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
          throw new Error("invalid-time");
        }
        vi.setSystemTime(nowMs);
      },
      expirePublication(publicationId) {
        completed.delete(publicationId);
        pendingExpiry.add(publicationId);
      },
      publicationStateForJob(jobId) {
        return completed.has(jobId) ? "complete" : "absent";
      },
      getLastStorageReadCount(namespace = "primary") {
        return namespace === "primary" ? primary.meter.last : other.meter.last;
      },
      getPageEventsCandidateReadBudget: (input) => input.limit + 1,
      getPageInstallationsCandidateReadBudget: (input) => input.limit + 1,
      getPageReportCandidateReadBudget: (input) => input.limit + 1,
      reopen: () => facade(),
    });
    return facade();
  };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(async () => {
  await Promise.all(namespaces.splice(0).map(({ close }) => close()));
  vi.useRealTimers();
});

describe("Drizzle SQLite native conformance", () => {
  registerRequiredInsightsModelTests(createHarness(createSQLiteNamespace));
});

const postgresqlUrl = process.env["DRIZZLE_INSIGHTS_POSTGRES_URL"];
const postgresqlSuite = postgresqlUrl === undefined ? describe.skip : describe;
postgresqlSuite("Drizzle PostgreSQL native conformance", () => {
  registerRequiredInsightsModelTests(
    createHarness(() => createPostgreSQLNamespace(postgresqlUrl!)),
  );
});

const mysqlUrl = process.env["DRIZZLE_INSIGHTS_MYSQL_URL"];
const mysqlSuite = mysqlUrl === undefined ? describe.skip : describe;
mysqlSuite("Drizzle MySQL native conformance", () => {
  registerRequiredInsightsModelTests(
    createHarness(() => createMySQLNamespace(mysqlUrl!)),
  );
});

const assertNativeLegacyPoison = async (
  namespace: NativeNamespace,
): Promise<void> => {
  const parameters = [
    "00000000-0000-4000-8000-000000000001",
    "UPDATE_APPLIED",
    "legacy-poison",
    null,
    null,
    null,
    "bundle-before",
    null,
    "bundle-after",
    "ios",
    "1.0.0",
    "production",
    "legacy",
    "appVersion",
    null,
    null,
    1,
  ];
  const placeholders = parameters.map((_, index) =>
    namespace.provider === "postgresql" ? `$${index + 1}` : "?",
  );
  await namespace.execute(
    `insert into bundle_events values (${placeholders.join(",")})`,
    parameters,
  );
  const model = createDrizzleInsightsQueries(
    namespace.database,
    namespace.provider,
  );
  const initial = await model.pageEvents({
    selector: { kind: "all" },
    beforeReceivedAtMs: 1_000,
    limit: 100,
  });
  if (initial.state !== "preparing") {
    throw new Error("legacy poison did not expose source maintenance");
  }
  const repeated = await model.pageEvents({
    selector: { kind: "all" },
    beforeReceivedAtMs: 1_000,
    limit: 100,
  });
  if (repeated.state !== "preparing" || repeated.job.id !== initial.job.id) {
    throw new Error("source readiness read changed migration state");
  }
  let failed = false;
  for (let step = 0; step < 4; step += 1) {
    const maintenance = await runDrizzleInsightsMaintenanceStep(
      namespace.database,
      namespace.provider,
      initial.job.id,
      { maxItems: 100, maxRequests: 128 },
    );
    if (maintenance.state === "failed") {
      const result = await model.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 1_000,
        limit: 100,
      });
      if (result.state !== "failed") {
        throw new Error("failed source maintenance was not readable");
      }
      if (result.error.code !== "migration-poison") {
        throw new Error("legacy poison returned the wrong failure");
      }
      failed = true;
      break;
    }
  }
  if (!failed) throw new Error("legacy poison did not fail readiness");
  const raw = await namespace.execute(
    "select id from bundle_events where id=" +
      (namespace.provider === "postgresql" ? "$1" : "?"),
    [parameters[0]],
  );
  const projected = await namespace.execute(
    `select count(*) count from ${DRIZZLE_INSIGHTS_EVENTS}`,
  );
  const state = await namespace.execute(
    `select status,error from ${DRIZZLE_INSIGHTS_STATE} where id=1`,
  );
  if (
    raw.length !== 1 ||
    Number(projected[0]?.["count"]) !== 0 ||
    state[0]?.["status"] !== "failed"
  ) {
    throw new Error("legacy poison changed retained source storage");
  }
  const reopened = await createDrizzleInsightsQueries(
    namespace.database,
    namespace.provider,
  ).pageEvents({
    selector: { kind: "all" },
    beforeReceivedAtMs: 1_000,
    limit: 100,
  });
  if (
    reopened.state !== "failed" ||
    reopened.error.code !== "migration-poison"
  ) {
    throw new Error("legacy poison was not durable across reopen");
  }
};

describe("Drizzle native retained legacy poison", () => {
  it("keeps a SQLite v4 row untouched and readiness durably failed", async () => {
    await assertNativeLegacyPoison(await createSQLiteNamespace());
  });

  const pgPoison = postgresqlUrl === undefined ? it.skip : it;
  pgPoison(
    "keeps a PostgreSQL v4 row untouched and readiness durably failed",
    async () =>
      assertNativeLegacyPoison(await createPostgreSQLNamespace(postgresqlUrl!)),
  );

  const mysqlPoison = mysqlUrl === undefined ? it.skip : it;
  mysqlPoison(
    "keeps a MySQL v4 row untouched and readiness durably failed",
    async () => assertNativeLegacyPoison(await createMySQLNamespace(mysqlUrl!)),
  );
});

const assertNativeFailedSearchReuse = async (
  namespace: NativeNamespace,
): Promise<void> => {
  const model = createDrizzleInsightsQueries(
    namespace.database,
    namespace.provider,
  );
  await model.append({
    id: "00000000-0000-7000-8000-000000000001",
    type: "UNCHANGED",
    install_id: "valid-installation",
    user_id: null,
    username: null,
    from_release_id: null,
    from_bundle_id: null,
    to_release_id: null,
    to_bundle_id: "10000000-0000-7000-8000-000000000001",
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    cohort: "native",
    update_strategy: null,
    fingerprint_hash: null,
    sdk_version: null,
    received_at_ms: 1,
  });
  await model.pageEvents({
    selector: { kind: "all" },
    beforeReceivedAtMs: 1_000,
    limit: 100,
  });
  await insertNativePrivatePoison(namespace);
  const input = { kind: "contains" as const, query: "valid", limit: 100 };
  const reserved = await model.pageInstallations(input);
  if (reserved.state !== "preparing") {
    throw new Error("poisoned search was not reserved");
  }
  const step = await runDrizzleInsightsMaintenanceStep(
    namespace.database,
    namespace.provider,
    reserved.job.id,
    { maxItems: 100, maxRequests: 128 },
  );
  if (step.state !== "failed") {
    throw new Error("poisoned search job did not fail");
  }
  const reopened = await createDrizzleInsightsQueries(
    namespace.database,
    namespace.provider,
  ).pageInstallations(input);
  if (
    reopened.state !== "failed" ||
    reopened.error.code !== "migration-poison" ||
    reopened.error.jobId !== reserved.job.id
  ) {
    throw new Error("poisoned search job was not durably reused");
  }
  const partial = await namespace.execute(
    `select count(*) count from ${DRIZZLE_INSIGHTS_SEARCH_RESULTS}
      where job_id=${namespace.provider === "postgresql" ? "$1" : "?"}`,
    [reserved.job.id],
  );
  if (Number(partial[0]?.["count"]) !== 0) {
    throw new Error("failed search exposed partial publication rows");
  }
};

describe("Drizzle native failed search jobs", () => {
  it("durably reuses a failed SQLite job without partial rows", async () => {
    await assertNativeFailedSearchReuse(await createSQLiteNamespace());
  });

  const pgFailure = postgresqlUrl === undefined ? it.skip : it;
  pgFailure(
    "durably reuses a failed PostgreSQL job without partial rows",
    async () =>
      assertNativeFailedSearchReuse(
        await createPostgreSQLNamespace(postgresqlUrl!),
      ),
  );

  const mysqlFailure = mysqlUrl === undefined ? it.skip : it;
  mysqlFailure(
    "durably reuses a failed MySQL job without partial rows",
    async () =>
      assertNativeFailedSearchReuse(await createMySQLNamespace(mysqlUrl!)),
  );
});

const assertNativeReportRegressions = async (
  namespace: NativeNamespace,
): Promise<void> => {
  vi.setSystemTime(100_000_000);
  const model = createDrizzleInsightsQueries(
    namespace.database,
    namespace.provider,
  );
  const event = (
    id: string,
    type: "UNCHANGED" | "UPDATE_APPLIED",
    installId: string,
    bundleId: string,
    cohort: string,
    receivedAtMs: number,
  ): BundleEventRow => {
    const base = {
      id,
      install_id: installId,
      user_id: null,
      username: null,
      from_release_id: null,
      to_release_id: null,
      to_bundle_id: bundleId,
      platform: "ios" as const,
      app_version: "1.0.0",
      channel: "production",
      cohort,
      fingerprint_hash: null,
      sdk_version: null,
      received_at_ms: receivedAtMs,
    };
    return type === "UPDATE_APPLIED"
      ? {
          ...base,
          type,
          from_bundle_id: "bundle-before",
          update_strategy: "appVersion",
        }
      : {
          ...base,
          type,
          from_bundle_id: null,
          update_strategy: null,
        };
  };
  await model.append(
    event(
      "00000000-0000-7000-8000-000000000001",
      "UNCHANGED",
      "active-install",
      "bundle-a",
      "active",
      99_001_000,
    ),
  );
  await model.append(
    event(
      "00000000-0000-7000-8000-000000000002",
      "UNCHANGED",
      "active-install",
      "bundle-b",
      "active",
      99_002_000,
    ),
  );
  await model.append(
    event(
      "00000000-0000-7000-8000-000000000003",
      "UPDATE_APPLIED",
      "movement-install",
      "bundle-target",
      "cohort-a",
      99_003_000,
    ),
  );
  await model.append(
    event(
      "00000000-0000-7000-8000-000000000004",
      "UPDATE_APPLIED",
      "movement-install",
      "bundle-target",
      "cohort-b",
      99_004_000,
    ),
  );
  const active = await model.getReport({
    query: { kind: "activeOverview", window: "24h" },
  });
  if (active.state !== "preparing") {
    throw new Error("active regression report was not reserved");
  }
  const beforeBudget = await namespace.execute(
    `select cursor_seq,phase,phase_section,phase_key,status
      from ${DRIZZLE_INSIGHTS_JOBS} where job_id=${
        namespace.provider === "postgresql" ? "$1" : "?"
      }`,
    [active.job.id],
  );
  const budgetStep = await runDrizzleInsightsMaintenanceStep(
    namespace.database,
    namespace.provider,
    active.job.id,
    { maxItems: 100, maxRequests: 4 },
  );
  const afterBudget = await namespace.execute(
    `select cursor_seq,phase,phase_section,phase_key,status
      from ${DRIZZLE_INSIGHTS_JOBS} where job_id=${
        namespace.provider === "postgresql" ? "$1" : "?"
      }`,
    [active.job.id],
  );
  if (
    budgetStep.usage.requests > 4 ||
    JSON.stringify(beforeBudget) !== JSON.stringify(afterBudget)
  ) {
    throw new Error("report maintenance advanced past maxRequests=4");
  }
  await finishNativeJob(namespace, active.job.id, 20, 128, 1);
  const activeA = await model.pageReport({
    publicationId: active.job.id,
    section: "activeBundleSeries",
    bundleId: "bundle-a",
    limit: 100,
  });
  const activeB = await model.pageReport({
    publicationId: active.job.id,
    section: "activeBundleSeries",
    bundleId: "bundle-b",
    limit: 100,
  });
  if (
    activeA.state !== "ready" ||
    activeA.data.section !== "activeBundleSeries" ||
    activeA.data.data.some(({ value }) => value !== 0) ||
    activeB.state !== "ready" ||
    activeB.data.section !== "activeBundleSeries" ||
    activeB.data.data.reduce((sum, { value }) => sum + value, 0) !== 1
  ) {
    throw new Error("active bundle series did not retain the bucket latest");
  }
  const movement = await model.getReport({
    query: {
      kind: "bundleDetail",
      bundleId: "bundle-target",
      window: "24h",
    },
  });
  if (movement.state !== "preparing") {
    throw new Error("movement regression report was not reserved");
  }
  await finishNativeJob(namespace, movement.job.id, 20, 128, 1);
  const cohorts = await model.pageReport({
    publicationId: movement.job.id,
    section: "movementCohorts",
    metric: "installed",
    limit: 100,
  });
  if (
    cohorts.state !== "ready" ||
    cohorts.data.section !== "movementCohorts" ||
    cohorts.data.total.value !== 2 ||
    cohorts.data.data.map(({ cohort }) => cohort).join() !== "cohort-a,cohort-b"
  ) {
    throw new Error("movement cohort totals depended on series membership");
  }
};

describe("Drizzle native report aggregation regressions", () => {
  it("keeps SQLite bucket latest and independent cohorts", async () => {
    await assertNativeReportRegressions(await createSQLiteNamespace());
  });

  const pgReport = postgresqlUrl === undefined ? it.skip : it;
  pgReport("keeps PostgreSQL bucket latest and independent cohorts", async () =>
    assertNativeReportRegressions(
      await createPostgreSQLNamespace(postgresqlUrl!),
    ),
  );

  const mysqlReport = mysqlUrl === undefined ? it.skip : it;
  mysqlReport("keeps MySQL bucket latest and independent cohorts", async () =>
    assertNativeReportRegressions(await createMySQLNamespace(mysqlUrl!)),
  );
});

const assertNativeByteShortPages = async (
  namespace: NativeNamespace,
): Promise<void> => {
  const model = createDrizzleInsightsQueries(
    namespace.database,
    namespace.provider,
  );
  const large = "😀".repeat(500);
  let id: string | null = null;
  for (let index = 0; index < 100; index += 1) {
    id = createUUIDv7After(id, 1_800_050_000_000 + index);
    await model.append({
      id,
      type: "UNCHANGED",
      install_id: `byte-${String(index).padStart(3, "0")}-${large}`,
      user_id: large,
      username: large,
      from_release_id: null,
      from_bundle_id: null,
      to_release_id: null,
      to_bundle_id: large,
      platform: "ios",
      app_version: large,
      channel: large,
      cohort: large,
      update_strategy: null,
      fingerprint_hash: null,
      sdk_version: null,
      received_at_ms: index + 1,
    });
  }
  const firstLive = await model.pageInstallations({ kind: "all", limit: 100 });
  if (
    firstLive.state !== "ready" ||
    firstLive.data.data.length < 1 ||
    firstLive.data.data.length >= 100 ||
    firstLive.data.nextCursor === null
  ) {
    throw new Error("live page did not stop at the byte limit");
  }
  const liveIds = new Set(firstLive.data.data.map((row) => row.install_id));
  let liveCursor: string | null = firstLive.data.nextCursor;
  while (liveCursor !== null) {
    const page: InsightsLiveInstallationPage = await model.pageInstallations({
      kind: "all",
      limit: 100,
      cursor: liveCursor,
    });
    if (page.state !== "ready") throw new Error("live continuation failed");
    for (const row of page.data.data) {
      if (liveIds.has(row.install_id)) {
        throw new Error("live byte-short page duplicated an installation");
      }
      liveIds.add(row.install_id);
    }
    liveCursor = page.data.nextCursor;
  }
  if (liveIds.size !== 100) throw new Error("live byte-short page lost rows");

  const searchInput = {
    kind: "contains" as const,
    query: "byte-",
    limit: 100,
  };
  const reserved = await model.pageInstallations(searchInput);
  if (reserved.state !== "preparing") {
    throw new Error("byte-short search was not reserved");
  }
  for (let step = 0; step < 4; step += 1) {
    const result = await runDrizzleInsightsMaintenanceStep(
      namespace.database,
      namespace.provider,
      reserved.job.id,
      { maxItems: 200, maxRequests: 128 },
    );
    if (result.state === "complete") break;
    if (result.state === "failed") throw new Error("byte search failed");
    if (step === 3) throw new Error("byte search did not complete");
  }
  const firstSearch = await model.pageInstallations(searchInput);
  if (
    firstSearch.state !== "ready" ||
    firstSearch.data.data.length < 1 ||
    firstSearch.data.data.length >= 100 ||
    firstSearch.data.nextCursor === null
  ) {
    throw new Error("search page did not stop at the byte limit");
  }
};

describe("Drizzle native byte-short pages", () => {
  it("bounds SQLite live and search pages by encoded bytes", async () => {
    await assertNativeByteShortPages(await createSQLiteNamespace());
  });

  const pgBytes = postgresqlUrl === undefined ? it.skip : it;
  pgBytes(
    "bounds PostgreSQL live and search pages by encoded bytes",
    async () =>
      assertNativeByteShortPages(
        await createPostgreSQLNamespace(postgresqlUrl!),
      ),
    60_000,
  );

  const mysqlBytes = mysqlUrl === undefined ? it.skip : it;
  mysqlBytes(
    "bounds MySQL live and search pages by encoded bytes",
    async () =>
      assertNativeByteShortPages(await createMySQLNamespace(mysqlUrl!)),
    60_000,
  );
});

const assertNativeAppendRollback = async (
  namespace: NativeNamespace,
): Promise<void> => {
  const model = createDrizzleInsightsQueries(
    namespace.database,
    namespace.provider,
  );
  const firstId = "00000000-0000-7000-8000-000000000001";
  const rejectedId = "00000000-0000-7000-8000-000000000002";
  const row = (id: string, installId: string): BundleEventRow => ({
    id,
    type: "UNCHANGED",
    install_id: installId,
    user_id: null,
    username: null,
    from_release_id: null,
    from_bundle_id: null,
    to_release_id: null,
    to_bundle_id: "10000000-0000-7000-8000-000000000001",
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    cohort: "rollback",
    update_strategy: null,
    fingerprint_hash: null,
    sdk_version: null,
    received_at_ms: 1,
  });
  await model.append(row(firstId, "committed"));
  if (namespace.provider === "sqlite") {
    await namespace.execute(`create trigger drizzle_insights_fail_source
      before insert on ${DRIZZLE_INSIGHTS_EVENTS}
      when new.event_id='${rejectedId}'
      begin select raise(abort,'forced source failure'); end`);
  } else if (namespace.provider === "postgresql") {
    await namespace.execute(`create function drizzle_insights_fail_source()
      returns trigger language plpgsql as $$ begin
        if new.event_id='${rejectedId}' then raise exception 'forced source failure'; end if;
        return new;
      end $$`);
    await namespace.execute(`create trigger drizzle_insights_fail_source
      before insert on ${DRIZZLE_INSIGHTS_EVENTS}
      for each row execute function drizzle_insights_fail_source()`);
  } else {
    await namespace.execute(`create trigger drizzle_insights_fail_source
      before insert on ${DRIZZLE_INSIGHTS_EVENTS} for each row
      begin
        if new.event_id='${rejectedId}' then
          signal sqlstate '45000' set message_text='forced source failure';
        end if;
      end`);
  }
  let rejected = false;
  try {
    await model.append(row(rejectedId, "rolled-back"));
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("forced source failure did not reject append");
  const placeholder = namespace.provider === "postgresql" ? "$1" : "?";
  const raw = await namespace.execute(
    `select count(*) count from bundle_events where id=${placeholder}`,
    [rejectedId],
  );
  const source = await namespace.execute(
    `select count(*) count from ${DRIZZLE_INSIGHTS_EVENTS}
      where event_id=${placeholder}`,
    [rejectedId],
  );
  if (Number(raw[0]?.["count"]) !== 0 || Number(source[0]?.["count"]) !== 0) {
    throw new Error("source failure left a split append");
  }
};

describe("Drizzle native append rollback", () => {
  it("rolls SQLite raw storage back when source projection fails", async () => {
    await assertNativeAppendRollback(await createSQLiteNamespace());
  });

  const pgRollback = postgresqlUrl === undefined ? it.skip : it;
  pgRollback(
    "rolls PostgreSQL raw storage back when source projection fails",
    async () =>
      assertNativeAppendRollback(
        await createPostgreSQLNamespace(postgresqlUrl!),
      ),
  );

  const mysqlRollback = mysqlUrl === undefined ? it.skip : it;
  mysqlRollback(
    "rolls MySQL raw storage back when source projection fails",
    async () =>
      assertNativeAppendRollback(await createMySQLNamespace(mysqlUrl!)),
  );
});

const stallPrivateEventInsert = (
  database: DrizzleDB,
  provider: DrizzleProvider,
) => {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markInserted = (): void => undefined;
  const inserted = new Promise<void>((resolve) => {
    markInserted = resolve;
  });
  let didStall = false;
  const stalled = {
    ...database,
    insightsTransaction: async <TResult>(
      operation: (transaction: DrizzleDB) => Promise<TResult>,
    ): Promise<TResult> =>
      database.insightsTransaction!(async (transaction) =>
        operation({
          ...transaction,
          insightsMutation: async (statement: SQL): Promise<void> => {
            await transaction.insightsMutation!(statement);
            const query =
              provider === "postgresql"
                ? new PgDialect().sqlToQuery(statement).sql
                : new MySqlDialect().sqlToQuery(statement).sql;
            if (
              !didStall &&
              query.toLowerCase().startsWith("insert") &&
              query.includes(DRIZZLE_INSIGHTS_EVENTS)
            ) {
              didStall = true;
              markInserted();
              await released;
            }
          },
        } as DrizzleDB),
      ),
  } as DrizzleDB;
  return { database: stalled, inserted, release };
};

const assertCommittedSourceFence = async (
  namespace: NativeNamespace,
): Promise<void> => {
  if (namespace.openDatabase === undefined) {
    throw new Error("native concurrent connection is unavailable");
  }
  const writer = await namespace.openDatabase();
  const reserver = await namespace.openDatabase();
  const stalled = stallPrivateEventInsert(writer.database, namespace.provider);
  try {
    const writerModel = createDrizzleInsightsQueries(
      stalled.database,
      namespace.provider,
    );
    const reserverModel = createDrizzleInsightsQueries(
      reserver.database,
      namespace.provider,
    );
    const emptyInput = {
      selector: { kind: "all" as const },
      beforeReceivedAtMs: 1_000,
      limit: 100,
    };
    await writerModel.pageEvents(emptyInput);
    await reserverModel.pageEvents(emptyInput);
    const append = writerModel.append({
      id: "00000000-0000-7000-8000-000000000001",
      type: "UNCHANGED",
      install_id: "committed-fence",
      user_id: null,
      username: null,
      from_release_id: null,
      from_bundle_id: null,
      to_release_id: null,
      to_bundle_id: "10000000-0000-7000-8000-000000000001",
      platform: "ios",
      app_version: "1.0.0",
      channel: "production",
      cohort: "fence",
      update_strategy: null,
      fingerprint_hash: null,
      sdk_version: null,
      received_at_ms: 1,
    });
    await stalled.inserted;
    let reservationSettled = false;
    const reservation = reserverModel
      .pageInstallations({
        kind: "contains",
        query: "committed-fence",
        limit: 100,
      })
      .then((result) => {
        reservationSettled = true;
        return result;
      });
    for (let turn = 0; turn < 4; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const jobsWhileUncommitted = await namespace.execute(
      `select count(*) count from ${DRIZZLE_INSIGHTS_JOBS}`,
    );
    if (
      reservationSettled ||
      Number(jobsWhileUncommitted[0]?.["count"]) !== 0
    ) {
      throw new Error("reservation crossed an uncommitted source append");
    }
    stalled.release();
    await append;
    const reserved = await reservation;
    if (reserved.state !== "preparing") {
      throw new Error("fenced search reservation was not created");
    }
    const placeholder = namespace.provider === "postgresql" ? "$1" : "?";
    const job = await namespace.execute(
      `select source_max_seq from ${DRIZZLE_INSIGHTS_JOBS}
        where job_id=${placeholder}`,
      [reserved.job.id],
    );
    const prefix = await namespace.execute(
      `select count(*) count,max(seq) max_seq from ${DRIZZLE_INSIGHTS_EVENTS}
        where seq<=${placeholder}`,
      [job[0]?.["source_max_seq"]],
    );
    if (
      Number(job[0]?.["source_max_seq"]) !== 1 ||
      Number(prefix[0]?.["count"]) !== 1 ||
      Number(prefix[0]?.["max_seq"]) !== 1
    ) {
      throw new Error("reservation did not capture an exact committed prefix");
    }
  } finally {
    stalled.release();
    await Promise.all([writer.close(), reserver.close()]);
  }
};

describe("Drizzle native committed source fence", () => {
  const pgFence = postgresqlUrl === undefined ? it.skip : it;
  pgFence(
    "blocks PostgreSQL reservation behind an uncommitted append",
    async () =>
      assertCommittedSourceFence(
        await createPostgreSQLNamespace(postgresqlUrl!),
      ),
  );

  const mysqlFence = mysqlUrl === undefined ? it.skip : it;
  mysqlFence(
    "blocks MySQL reservation behind an uncommitted append",
    async () =>
      assertCommittedSourceFence(await createMySQLNamespace(mysqlUrl!)),
  );
});

const assertMigrationSourceFence = async (
  namespace: NativeNamespace,
): Promise<void> => {
  if (namespace.openDatabase === undefined) {
    throw new Error("native concurrent connection is unavailable");
  }
  const legacyId = "00000000-0000-7000-8000-000000000001";
  const appendId = "00000000-0000-7000-8000-000000000002";
  const legacy = [
    legacyId,
    "UNCHANGED",
    "migration-fence-legacy",
    null,
    null,
    null,
    null,
    null,
    "10000000-0000-7000-8000-000000000001",
    "ios",
    "1.0.0",
    "production",
    "fence",
    null,
    null,
    null,
    1,
  ];
  const placeholders = legacy.map((_, index) =>
    namespace.provider === "postgresql" ? `$${index + 1}` : "?",
  );
  await namespace.execute(
    `insert into bundle_events values (${placeholders.join(",")})`,
    legacy,
  );
  const initialModel = createDrizzleInsightsQueries(
    namespace.database,
    namespace.provider,
  );
  const sourcePage = await initialModel.pageEvents({
    selector: { kind: "all" },
    beforeReceivedAtMs: 1_000,
    limit: 100,
  });
  if (sourcePage.state !== "preparing") {
    throw new Error("retained source migration was not exposed");
  }
  const migrator = await namespace.openDatabase();
  const writer = await namespace.openDatabase();
  const reserver = await namespace.openDatabase();
  const stalled = stallPrivateEventInsert(
    migrator.database,
    namespace.provider,
  );
  try {
    const writerModel = createDrizzleInsightsQueries(
      writer.database,
      namespace.provider,
    );
    const reserverModel = createDrizzleInsightsQueries(
      reserver.database,
      namespace.provider,
    );
    const sourceInput = {
      selector: { kind: "all" as const },
      beforeReceivedAtMs: 1_000,
      limit: 100,
    };
    await writerModel.pageEvents(sourceInput);
    await reserverModel.pageInstallations({
      kind: "contains",
      query: "migration-fence",
      limit: 100,
    });
    const initialized = await runDrizzleInsightsMaintenanceStep(
      stalled.database,
      namespace.provider,
      sourcePage.job.id,
      { maxItems: 100, maxRequests: 128 },
    );
    if (initialized.state !== "running") {
      throw new Error("retained source upper bound was not initialized");
    }
    const migration = runDrizzleInsightsMaintenanceStep(
      stalled.database,
      namespace.provider,
      sourcePage.job.id,
      { maxItems: 100, maxRequests: 128 },
    );
    await stalled.inserted;
    let appendSettled = false;
    const append = writerModel
      .append({
        id: appendId,
        type: "UNCHANGED",
        install_id: "migration-fence-append",
        user_id: null,
        username: null,
        from_release_id: null,
        from_bundle_id: null,
        to_release_id: null,
        to_bundle_id: "10000000-0000-7000-8000-000000000002",
        platform: "ios",
        app_version: "1.0.0",
        channel: "production",
        cohort: "fence",
        update_strategy: null,
        fingerprint_hash: null,
        sdk_version: null,
        received_at_ms: 2,
      })
      .then(() => {
        appendSettled = true;
      });
    const whileMigrating = await reserverModel.pageInstallations({
      kind: "contains",
      query: "migration-fence",
      limit: 100,
    });
    for (let turn = 0; turn < 4; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const jobsWhileMigrating = await namespace.execute(
      `select count(*) count from ${DRIZZLE_INSIGHTS_JOBS}`,
    );
    if (
      appendSettled ||
      whileMigrating.state !== "preparing" ||
      whileMigrating.job.id !== sourcePage.job.id ||
      Number(jobsWhileMigrating[0]?.["count"]) !== 0
    ) {
      throw new Error("migration exposed a noncontiguous committed prefix");
    }
    stalled.release();
    const completed = await migration;
    await append;
    if (completed.state !== "complete") {
      throw new Error("stalled retained source migration did not complete");
    }
    const reserved = await reserverModel.pageInstallations({
      kind: "contains",
      query: "migration-fence",
      limit: 100,
    });
    if (reserved.state !== "preparing") {
      throw new Error("post-migration search was not reserved");
    }
    const placeholder = namespace.provider === "postgresql" ? "$1" : "?";
    const job = await namespace.execute(
      `select source_max_seq from ${DRIZZLE_INSIGHTS_JOBS}
        where job_id=${placeholder}`,
      [reserved.job.id],
    );
    const prefix = await namespace.execute(
      `select count(*) count,max(seq) max_seq from ${DRIZZLE_INSIGHTS_EVENTS}
        where seq<=${placeholder}`,
      [job[0]?.["source_max_seq"]],
    );
    if (
      Number(job[0]?.["source_max_seq"]) !== 2 ||
      Number(prefix[0]?.["count"]) !== 2 ||
      Number(prefix[0]?.["max_seq"]) !== 2
    ) {
      throw new Error("migration reservation captured a source sequence gap");
    }
  } finally {
    stalled.release();
    await Promise.all([migrator.close(), writer.close(), reserver.close()]);
  }
};

describe("Drizzle native retained-source fence", () => {
  const pgFence = postgresqlUrl === undefined ? it.skip : it;
  pgFence(
    "blocks PostgreSQL append behind an uncommitted migration row",
    async () =>
      assertMigrationSourceFence(
        await createPostgreSQLNamespace(postgresqlUrl!),
      ),
  );

  const mysqlFence = mysqlUrl === undefined ? it.skip : it;
  mysqlFence(
    "blocks MySQL append behind an uncommitted migration row",
    async () =>
      assertMigrationSourceFence(await createMySQLNamespace(mysqlUrl!)),
  );
});

const insertScaleLegacyEvents = async (
  namespace: NativeNamespace,
  count: number,
): Promise<string> => {
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
  let lastId: string | null = null;
  for (let start = 0; start < count; start += 500) {
    const size = Math.min(500, count - start);
    const parameters: unknown[] = [];
    const tuples: string[] = [];
    for (let offset = 0; offset < size; offset += 1) {
      const index = start + offset;
      lastId = createUUIDv7After(lastId, 1_800_100_000_000 + index);
      const row = [
        lastId,
        "UPDATE_APPLIED",
        `scale-install-${String(index).padStart(5, "0")}`,
        `scale-user-${index}`,
        `Scale User ${index}`,
        null,
        "bundle-before",
        null,
        index % 100 === 0 ? "bundle-sparse" : "bundle-scale",
        "ios",
        "1.0.0",
        "production",
        `cohort-${String(index).padStart(5, "0")}`,
        "appVersion",
        null,
        null,
        99_900_000 + index,
      ];
      const placeholders = row.map((value) => {
        parameters.push(value);
        return namespace.provider === "postgresql"
          ? `$${parameters.length}`
          : "?";
      });
      tuples.push(`(${placeholders.join(",")})`);
    }
    await namespace.execute(
      `insert into bundle_events (${columns.join(",")}) values ${tuples.join(",")}`,
      parameters,
    );
  }
  if (lastId === null) throw new Error("missing scale fixture id");
  return lastId;
};

const finishNativeJob = async (
  namespace: NativeNamespace,
  jobId: string,
  maximumSteps: number,
  maxRequests = 128,
  maxItems = 200,
): Promise<void> => {
  for (let step = 0; step < maximumSteps; step += 1) {
    const result = await runDrizzleInsightsMaintenanceStep(
      namespace.database,
      namespace.provider,
      jobId,
      { maxItems, maxRequests },
    );
    if (
      result.usage.items > maxItems ||
      result.usage.requests > maxRequests ||
      result.usage.bytes > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
    ) {
      throw new Error("scale job exceeded its maintenance budget");
    }
    if (result.state === "complete") return;
    if (result.state === "failed") {
      const failure = await namespace.execute(
        `select cursor_seq,phase,status,error from ${DRIZZLE_INSIGHTS_JOBS}
          where job_id=${namespace.provider === "postgresql" ? "$1" : "?"}`,
        [jobId],
      );
      const distinct = await namespace.execute(
        `select * from ${DRIZZLE_INSIGHTS_REPORT_DISTINCT}
          where job_id=${namespace.provider === "postgresql" ? "$1" : "?"}`,
        [jobId],
      );
      throw new Error(
        `scale job failed: ${JSON.stringify({ failure, distinct })}`,
      );
    }
  }
  throw new Error("scale job did not complete");
};

const assertScalePlan = async (
  namespace: NativeNamespace,
  statement: string,
  expectedIndex: string | readonly string[],
  expectedRows = 101,
  indexMatch: "all" | "any" = "all",
): Promise<void> => {
  const rows = await namespace.execute(statement);
  const expectedIndexes =
    typeof expectedIndex === "string" ? [expectedIndex] : expectedIndex;
  const missedIndex = (text: string): boolean =>
    indexMatch === "all"
      ? expectedIndexes.some((index) => !text.includes(index))
      : expectedIndexes.every((index) => !text.includes(index));
  if (rows.length !== expectedRows) {
    throw new Error(
      `expected ${expectedRows} scale rows, received ${rows.length}`,
    );
  }
  if (namespace.provider === "sqlite") {
    const plan = await namespace.execute(`explain query plan ${statement}`);
    const planText = JSON.stringify(plan);
    if (missedIndex(planText)) {
      throw new Error(
        `SQLite plan missed ${expectedIndexes.join(",")}: ${planText}`,
      );
    }
    if (namespace.sqlitePath === undefined) {
      throw new Error("missing SQLite scale path");
    }
    const scan = await execa(
      "/usr/bin/sqlite3",
      ["-cmd", ".scanstats on", namespace.sqlitePath, statement],
      { reject: false },
    );
    const scanText = `${scan.stdout}\n${scan.stderr}`;
    if (
      missedIndex(scanText) ||
      !scanText.includes(`loops=1 rows=${expectedRows}`)
    ) {
      throw new Error(`SQLite scanstatus exceeded the page bound: ${scanText}`);
    }
    return;
  }
  if (namespace.provider === "postgresql") {
    const plan = await namespace.execute(
      `explain (analyze,buffers,format json) ${statement}`,
    );
    const text = JSON.stringify(plan);
    if (missedIndex(text) || !text.includes(`"Actual Rows":${expectedRows}`)) {
      throw new Error(`PostgreSQL plan exceeded the page bound: ${text}`);
    }
    return;
  }
  const plan = await namespace.execute(`explain analyze ${statement}`);
  const text = JSON.stringify(plan);
  if (missedIndex(text) || !text.includes(`rows=${expectedRows} loops=1`)) {
    throw new Error(`MySQL plan exceeded the page bound: ${text}`);
  }
};

const runScaleGate = async (namespace: NativeNamespace): Promise<void> => {
  const fixtureRows = 50_001;
  vi.setSystemTime(100_000_000);
  const lastLegacyId = await insertScaleLegacyEvents(namespace, fixtureRows);
  let model = createDrizzleInsightsQueries(
    namespace.database,
    namespace.provider,
  );
  const initial = await model.pageEvents({
    selector: { kind: "all" },
    beforeReceivedAtMs: 100_000_000,
    limit: 100,
  });
  if (initial.state !== "preparing") {
    throw new Error("scale source migration was not exposed");
  }
  const beforeRead = await namespace.execute(
    `select status,upper_id,after_id from ${DRIZZLE_INSIGHTS_STATE} where id=1`,
  );
  const repeated = await model.pageEvents({
    selector: { kind: "all" },
    beforeReceivedAtMs: 100_000_000,
    limit: 100,
  });
  const afterRead = await namespace.execute(
    `select status,upper_id,after_id from ${DRIZZLE_INSIGHTS_STATE} where id=1`,
  );
  if (
    repeated.state !== "preparing" ||
    repeated.job.id !== initial.job.id ||
    JSON.stringify(beforeRead) !== JSON.stringify(afterRead)
  ) {
    throw new Error("source readiness reads advanced scale migration");
  }
  let calls = 0;
  let ready = false;
  for (; calls < 260; calls += 1) {
    const step = await runDrizzleInsightsMaintenanceStep(
      namespace.database,
      namespace.provider,
      initial.job.id,
      { maxItems: 200, maxRequests: 4096 },
    );
    if (calls === 72) {
      model = createDrizzleInsightsQueries(
        namespace.database,
        namespace.provider,
      );
      const writerId = createUUIDv7After(lastLegacyId, 1_800_200_000_000);
      await model.append({
        id: writerId,
        type: "UNCHANGED",
        install_id: "writer-cutover",
        user_id: null,
        username: null,
        from_release_id: null,
        from_bundle_id: null,
        to_release_id: null,
        to_bundle_id: "bundle-writer",
        platform: "ios",
        app_version: "1.0.0",
        channel: "production",
        cohort: "writer",
        update_strategy: null,
        fingerprint_hash: null,
        sdk_version: null,
        received_at_ms: 99_999_000,
      });
    }
    if (
      step.usage.items > 200 ||
      step.usage.requests > 4096 ||
      step.usage.bytes > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
    ) {
      throw new Error("source migration exceeded its maintenance budget");
    }
    if (step.state === "complete") {
      ready = true;
      calls += 1;
      break;
    }
    if (step.state === "failed") throw new Error("scale preparation failed");
  }
  if (!ready || calls > 253) {
    throw new Error(`unexpected preparation calls: ${calls}`);
  }
  const longPrefix = "long-prefix-" + "x".repeat(300);
  const longInstallA = `${longPrefix}install-a`;
  const longInstallB = `${longPrefix}install-b`;
  const longBundleA = `${longPrefix}bundle-a`;
  const longBundleB = `${longPrefix}bundle-b`;
  const longIdA = createUUIDv7After(lastLegacyId, 1_800_200_000_001);
  const longIdB = createUUIDv7After(longIdA, 1_800_200_000_002);
  for (const [id, installId, bundleId] of [
    [longIdA, longInstallA, longBundleA],
    [longIdB, longInstallB, longBundleB],
  ] as const) {
    await model.append({
      id,
      type: "UPDATE_APPLIED",
      install_id: installId,
      user_id: null,
      username: null,
      from_release_id: null,
      from_bundle_id: "bundle-before",
      to_release_id: null,
      to_bundle_id: bundleId,
      platform: "ios",
      app_version: "1.0.0",
      channel: "production",
      cohort: "long-prefix",
      update_strategy: "appVersion",
      fingerprint_hash: null,
      sdk_version: null,
      received_at_ms: 99_999_100,
    });
  }
  const exactInstall = await model.pageEvents({
    selector: { kind: "installationId", installId: longInstallA },
    beforeReceivedAtMs: 100_000_000,
    limit: 100,
  });
  const exactBundle = await model.pageEvents({
    selector: { kind: "bundleId", bundleId: longBundleA },
    beforeReceivedAtMs: 100_000_000,
    limit: 100,
  });
  if (
    exactInstall.state !== "ready" ||
    exactInstall.data.data.map(({ id }) => id).join() !== longIdA ||
    exactBundle.state !== "ready" ||
    exactBundle.data.data.map(({ id }) => id).join() !== longIdA
  ) {
    throw new Error("long common-prefix selector crossed a digest boundary");
  }
  const counts = await namespace.execute(
    `select count(*) count from ${DRIZZLE_INSIGHTS_EVENTS}`,
  );
  if (Number(counts[0]?.["count"]) !== fixtureRows + 3) {
    throw new Error("interrupted preparation lost a source event");
  }
  const source = await namespace.execute(
    `select committed_seq maximum from ${DRIZZLE_INSIGHTS_STATE} where id=1`,
  );
  const maximum = Number(source[0]?.["maximum"]);
  const bundleDigest = drizzleInsightsSemanticKey(["bundle", "bundle-sparse"]);
  const installDigest = Buffer.from(
    await getInsightsInstallationOrderKey("scale-install-00000"),
  ).toString("hex");
  await assertScalePlan(
    namespace,
    `select event_id from ${DRIZZLE_INSIGHTS_EVENTS}
      where seq>0 and seq<=${maximum} order by seq asc limit 201`,
    namespace.provider === "sqlite"
      ? DRIZZLE_INSIGHTS_EVENTS
      : namespace.provider === "postgresql"
        ? `${DRIZZLE_INSIGHTS_EVENTS}_pkey`
        : "PRIMARY",
    201,
  );
  await assertScalePlan(
    namespace,
    `select event_id from ${DRIZZLE_INSIGHTS_EVENTS}
      where seq<=${maximum} and received_at_ms>=0 and received_at_ms<100000000
      order by received_at_ms desc,event_order_key desc limit 101`,
    "drizzle_insights_events_order_idx",
  );
  await assertScalePlan(
    namespace,
    `select event_id from ${DRIZZLE_INSIGHTS_EVENTS}
      where seq<=${maximum} and to_bundle_key='${bundleDigest}'
        and to_bundle_id='bundle-sparse'
        and event_type='UPDATE_APPLIED'
      order by received_at_ms desc,event_order_key desc limit 101`,
    "drizzle_insights_events_to_bundle_idx",
  );
  await assertScalePlan(
    namespace,
    `select event_id from (
      select * from (
        select event_id,received_at_ms,event_order_key
        from ${DRIZZLE_INSIGHTS_EVENTS}
        where seq<=${maximum} and to_bundle_key='${bundleDigest}'
          and to_bundle_id='bundle-sparse'
          and event_type='UPDATE_APPLIED'
        order by received_at_ms desc,event_order_key desc limit 101
      ) drizzle_applied
      union all
      select * from (
        select event_id,received_at_ms,event_order_key
        from ${DRIZZLE_INSIGHTS_EVENTS}
        where seq<=${maximum} and from_bundle_key='${bundleDigest}'
          and from_bundle_id='bundle-sparse'
          and event_type='RECOVERED'
        order by received_at_ms desc,event_order_key desc limit 101
      ) drizzle_recovered
    ) drizzle_bundle_events
    order by received_at_ms desc,event_order_key desc limit 101`,
    [
      "drizzle_insights_events_to_bundle_idx",
      "drizzle_insights_events_from_bundle_idx",
    ],
  );
  await assertScalePlan(
    namespace,
    `select event_id from ${DRIZZLE_INSIGHTS_EVENTS}
      where seq<=${maximum} and install_key='${installDigest}'
        and install_id='scale-install-00000'
        and event_type in ('UPDATE_APPLIED','RECOVERED')
      order by received_at_ms desc,event_order_key desc limit 101`,
    ["drizzle_insights_events_install_idx", "drizzle_insights_events_live_idx"],
    1,
    "any",
  );
  await assertScalePlan(
    namespace,
    `select e.event_id from ${DRIZZLE_INSIGHTS_LIVE} l
      join ${DRIZZLE_INSIGHTS_EVENTS} e on e.event_id=l.event_id
      order by l.install_key asc limit 101`,
    namespace.provider === "sqlite"
      ? `sqlite_autoindex_${DRIZZLE_INSIGHTS_LIVE}_1`
      : namespace.provider === "postgresql"
        ? `${DRIZZLE_INSIGHTS_LIVE}_pkey`
        : "PRIMARY",
  );

  const search = await model.pageInstallations({
    kind: "contains",
    query: "scale-install-",
    limit: 100,
  });
  if (search.state !== "preparing") {
    throw new Error("scale search was not reserved");
  }
  await finishNativeJob(namespace, search.job.id, 300);
  const published = await model.pageInstallations({
    kind: "contains",
    query: "scale-install-",
    limit: 100,
  });
  if (
    published.state !== "ready" ||
    published.data.data.length !== 100 ||
    published.data.total.value !== fixtureRows
  ) {
    throw new Error("scale search publication was incomplete");
  }
  const sparseSearch = await model.pageInstallations({
    kind: "contains",
    query: "scale-install-00",
    limit: 100,
  });
  if (sparseSearch.state !== "preparing") {
    throw new Error("sparse scale search was not reserved");
  }
  await finishNativeJob(namespace, sparseSearch.job.id, 300);
  await assertScalePlan(
    namespace,
    `select install_id from ${DRIZZLE_INSIGHTS_SEARCH_RESULTS}
      where job_id='${sparseSearch.job.id}' and matched=1
      order by install_key asc limit 101`,
    "drizzle_insights_search_matched_idx",
  );

  const reportInput = {
    query: {
      kind: "bundleDetail" as const,
      bundleId: "bundle-scale",
      window: "24h" as const,
    },
  };
  const report = await model.getReport(reportInput);
  if (report.state !== "preparing") {
    throw new Error("scale report was not reserved");
  }
  const repeatedReport = await model.getReport(reportInput);
  if (
    repeatedReport.state !== "preparing" ||
    repeatedReport.job.id !== report.job.id
  ) {
    throw new Error("scale report reservation was not reused");
  }
  await finishNativeJob(namespace, report.job.id, 700, 4096);
  const publishedReport = await model.getReport(reportInput);
  if (
    publishedReport.state !== "ready" ||
    publishedReport.data.kind !== "bundleDetail" ||
    publishedReport.data.summary.installed !== 49_500 ||
    publishedReport.data.summary.recovered !== 0
  ) {
    throw new Error("scale report publication was incomplete");
  }
  const reportPage = await model.pageReport({
    publicationId: report.job.id,
    section: "movementSeries",
    metric: "installed",
    limit: 100,
  });
  if (reportPage.state !== "ready" || reportPage.data.data.length !== 24) {
    throw new Error("scale report did not publish its fixed window");
  }
  const cohorts = await model.pageReport({
    publicationId: report.job.id,
    section: "movementCohorts",
    metric: "installed",
    limit: 100,
  });
  if (
    cohorts.state !== "ready" ||
    cohorts.data.section !== "movementCohorts" ||
    cohorts.data.data.length !== 100 ||
    cohorts.data.total.value !== 49_500 ||
    cohorts.data.nextCursor === null
  ) {
    throw new Error("scale report did not publish high-cardinality cohorts");
  }
  await assertScalePlan(
    namespace,
    `select row_key from ${DRIZZLE_INSIGHTS_REPORT_OUTPUT}
      where job_id='${report.job.id}'
        and section_key='movementCohorts:installed' and page_ordinal>=0
      order by page_ordinal asc limit 101`,
    [
      "drizzle_insights_output_page_idx",
      "drizzle_insights_output_pending_value_idx",
    ],
    101,
    "any",
  );
  const seenCohorts = new Set(cohorts.data.data.map(({ cohort }) => cohort));
  let cohortCursor: string | null = cohorts.data.nextCursor;
  while (cohortCursor !== null) {
    const page = await model.pageReport({
      publicationId: report.job.id,
      section: "movementCohorts",
      metric: "installed",
      limit: 100,
      cursor: cohortCursor,
    });
    if (
      page.state !== "ready" ||
      page.data.section !== "movementCohorts" ||
      page.data.total.value !== 49_500
    ) {
      throw new Error("deep scale report page was not exact");
    }
    for (const row of page.data.data) {
      if (seenCohorts.has(row.cohort)) {
        throw new Error("deep scale report page duplicated a cohort");
      }
      seenCohorts.add(row.cohort);
    }
    cohortCursor = page.data.nextCursor;
  }
  if (seenCohorts.size !== 49_500) {
    throw new Error("deep scale report pagination lost cohorts");
  }
};

const scaleEnabled = process.env["DRIZZLE_INSIGHTS_SCALE"] === "1";
const scaleSuite = scaleEnabled ? describe : describe.skip;
scaleSuite("Drizzle 50,001-row native scale gate", () => {
  it(
    "bounds SQLite source, selectors, and search publication",
    async () => {
      const path = join(tmpdir(), `${uniqueName("drizzle_scale")}.sqlite`);
      const namespace = await createSQLiteNamespace(path);
      await runScaleGate(namespace);
    },
    15 * 60_000,
  );

  const pgScale = postgresqlUrl === undefined ? it.skip : it;
  pgScale(
    "bounds PostgreSQL source, selectors, and search publication",
    async () => runScaleGate(await createPostgreSQLNamespace(postgresqlUrl!)),
    15 * 60_000,
  );

  const mysqlScale = mysqlUrl === undefined ? it.skip : it;
  mysqlScale(
    "bounds MySQL source, selectors, and search publication",
    async () => runScaleGate(await createMySQLNamespace(mysqlUrl!)),
    15 * 60_000,
  );
});
