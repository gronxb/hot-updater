import { createHash } from "node:crypto";

import type { ORMSQLProvider } from "../../../db/types";
import {
  executePrismaInsights,
  PrismaInsightsConfigurationError,
  PrismaInsightsSql,
  queryPrismaInsights,
  type PrismaInsightsRawClient,
} from "./client";
import { assertPrismaInsightsDatabaseNamespace } from "./utils";

export const PRISMA_INSIGHTS_LAYOUT_VERSION = 4;
export const PRISMA_INSIGHTS_STATE =
  "private_hot_updater_prisma_insights_state";
export const PRISMA_INSIGHTS_SOURCE =
  "private_hot_updater_prisma_insights_source";
export const PRISMA_INSIGHTS_EVENTS =
  "private_hot_updater_prisma_insights_events";
export const PRISMA_INSIGHTS_LIVE = "private_hot_updater_prisma_insights_live";
export const PRISMA_INSIGHTS_ALIASES =
  "private_hot_updater_prisma_insights_aliases";
export const PRISMA_INSIGHTS_SEARCH_HEADS =
  "private_hot_updater_prisma_insights_search_heads";
export const PRISMA_INSIGHTS_SEARCH_JOBS =
  "private_hot_updater_prisma_insights_search_jobs";
export const PRISMA_INSIGHTS_SEARCH_ROWS =
  "private_hot_updater_prisma_insights_search_rows";
export const PRISMA_INSIGHTS_REPORT_HEADS =
  "private_hot_updater_prisma_insights_report_heads";
export const PRISMA_INSIGHTS_REPORT_JOBS =
  "private_hot_updater_prisma_insights_report_jobs";
export const PRISMA_INSIGHTS_REPORT_MEMBERS =
  "private_hot_updater_prisma_insights_report_members";
export const PRISMA_INSIGHTS_REPORT_LATEST =
  "private_hot_updater_prisma_insights_report_latest";
export const PRISMA_INSIGHTS_REPORT_COUNTS =
  "private_hot_updater_prisma_insights_report_counts";
export const PRISMA_INSIGHTS_REPORT_ORDER =
  "private_hot_updater_prisma_insights_report_order";
export const PRISMA_INSIGHTS_REPORT_SORT =
  "private_hot_updater_prisma_insights_report_sort";
export const PRISMA_INSIGHTS_REPORT_SEALS =
  "private_hot_updater_prisma_insights_report_seals";
export const PRISMA_INSIGHTS_MIGRATION_INDEX =
  "private_hot_updater_prisma_insights_legacy_id_idx";
export const PRISMA_INSIGHTS_MIGRATION_COLUMN =
  "private_hot_updater_prisma_insights_migration_id";
const PRISMA_INSIGHTS_MYSQL_DDL = "private_hot_updater_prisma_insights_ddl";

export const PRISMA_INSIGHTS_REQUIRED_INDEXES = [
  "private_hot_updater_prisma_insights_events_global_idx",
  "private_hot_updater_prisma_insights_events_install_idx",
  "private_hot_updater_prisma_insights_events_to_bundle_idx",
  "private_hot_updater_prisma_insights_events_from_bundle_idx",
  "private_hot_updater_prisma_insights_aliases_source_idx",
  "private_hot_updater_prisma_search_jobs_state_idx",
  "private_hot_updater_prisma_report_jobs_state_idx",
  "private_hot_updater_prisma_report_members_page_idx",
  "private_hot_updater_prisma_report_order_page_idx",
  "private_hot_updater_prisma_report_counts_source_idx",
  "private_hot_updater_prisma_report_sort_page_idx",
  PRISMA_INSIGHTS_MIGRATION_INDEX,
] as const;

const PRISMA_INSIGHTS_INDEX_TABLES: Readonly<Record<string, string>> = {
  private_hot_updater_prisma_insights_events_global_idx: PRISMA_INSIGHTS_EVENTS,
  private_hot_updater_prisma_insights_events_install_idx:
    PRISMA_INSIGHTS_EVENTS,
  private_hot_updater_prisma_insights_events_to_bundle_idx:
    PRISMA_INSIGHTS_EVENTS,
  private_hot_updater_prisma_insights_events_from_bundle_idx:
    PRISMA_INSIGHTS_EVENTS,
  private_hot_updater_prisma_insights_aliases_source_idx:
    PRISMA_INSIGHTS_ALIASES,
  private_hot_updater_prisma_search_jobs_state_idx: PRISMA_INSIGHTS_SEARCH_JOBS,
  private_hot_updater_prisma_report_jobs_state_idx: PRISMA_INSIGHTS_REPORT_JOBS,
  private_hot_updater_prisma_report_members_page_idx:
    PRISMA_INSIGHTS_REPORT_MEMBERS,
  private_hot_updater_prisma_report_order_page_idx:
    PRISMA_INSIGHTS_REPORT_ORDER,
  private_hot_updater_prisma_report_counts_source_idx:
    PRISMA_INSIGHTS_REPORT_COUNTS,
  private_hot_updater_prisma_report_sort_page_idx: PRISMA_INSIGHTS_REPORT_SORT,
  [PRISMA_INSIGHTS_MIGRATION_INDEX]: "bundle_events",
};

type PrismaInsightsIndexKey =
  | { readonly column: string }
  | { readonly expression: Readonly<Record<ORMSQLProvider, string>> };

interface PrismaInsightsRequiredIndex {
  readonly keys: readonly PrismaInsightsIndexKey[];
  readonly unique: boolean | Readonly<Partial<Record<ORMSQLProvider, boolean>>>;
}

const asc = (column: string): PrismaInsightsIndexKey => ({ column });

const PRISMA_INSIGHTS_REQUIRED_INDEX_LAYOUTS: Readonly<
  Record<
    (typeof PRISMA_INSIGHTS_REQUIRED_INDEXES)[number],
    PrismaInsightsRequiredIndex
  >
> = {
  private_hot_updater_prisma_insights_events_global_idx: {
    keys: [asc("received_at_ms"), asc("event_order")],
    unique: false,
  },
  private_hot_updater_prisma_insights_events_install_idx: {
    keys: [
      asc("install_key"),
      asc("type"),
      asc("received_at_ms"),
      asc("event_order"),
    ],
    unique: false,
  },
  private_hot_updater_prisma_insights_events_to_bundle_idx: {
    keys: [
      asc("type"),
      asc("to_bundle_id"),
      asc("received_at_ms"),
      asc("event_order"),
    ],
    unique: false,
  },
  private_hot_updater_prisma_insights_events_from_bundle_idx: {
    keys: [
      asc("type"),
      asc("from_bundle_id"),
      asc("received_at_ms"),
      asc("event_order"),
    ],
    unique: false,
  },
  private_hot_updater_prisma_insights_aliases_source_idx: {
    keys: [asc("source_generation"), asc("alias_key")],
    unique: false,
  },
  private_hot_updater_prisma_search_jobs_state_idx: {
    keys: [asc("state"), asc("id")],
    unique: false,
  },
  private_hot_updater_prisma_report_jobs_state_idx: {
    keys: [asc("state"), asc("id")],
    unique: false,
  },
  private_hot_updater_prisma_report_members_page_idx: {
    keys: [asc("job_id"), asc("section"), asc("metric"), asc("member_key")],
    unique: false,
  },
  private_hot_updater_prisma_report_order_page_idx: {
    keys: [asc("job_id"), asc("order_kind"), asc("metric"), asc("ordinal")],
    unique: false,
  },
  private_hot_updater_prisma_report_counts_source_idx: {
    keys: [
      asc("job_id"),
      asc("section"),
      asc("metric"),
      asc("bucket_start_ms"),
      asc("count_key"),
    ],
    unique: false,
  },
  private_hot_updater_prisma_report_sort_page_idx: {
    keys: [
      asc("job_id"),
      asc("order_kind"),
      asc("metric"),
      asc("sort_pass"),
      asc("sort_run"),
      asc("ordinal"),
    ],
    unique: true,
  },
  [PRISMA_INSIGHTS_MIGRATION_INDEX]: {
    keys: [
      {
        expression: {
          postgresql: 'id collate "C"',
          cockroachdb: PRISMA_INSIGHTS_MIGRATION_COLUMN,
          mysql: "cast(id as binary)",
          sqlite: "cast(id as blob)",
          mssql:
            "convert(binary(32),hashbytes('SHA2_256',convert(nvarchar(max),id)))",
        },
      },
    ],
    unique: { mssql: true },
  },
};

const isRequiredIndexUnique = (
  provider: ORMSQLProvider,
  index: PrismaInsightsRequiredIndex,
): boolean =>
  typeof index.unique === "boolean"
    ? index.unique
    : index.unique[provider] === true;

const indexKeyValue = (
  provider: ORMSQLProvider,
  key: PrismaInsightsIndexKey,
): string => ("column" in key ? key.column : key.expression[provider]!);

const indexKeyDirection = (
  name: (typeof PRISMA_INSIGHTS_REQUIRED_INDEXES)[number],
  position: number,
): boolean =>
  name.startsWith("private_hot_updater_prisma_insights_events_") &&
  position >= (name.endsWith("global_idx") ? 0 : 2);

const normalizeIndexKey = (value: string): string =>
  value.toLowerCase().replace(/(?:\s|`|"|\[|\]|\(|\))/g, "");

const hasExpectedIndexKey = (
  provider: ORMSQLProvider,
  actual: string,
  expected: string,
): boolean => {
  const actualKey = normalizeIndexKey(actual);
  const expectedKey = normalizeIndexKey(expected);
  return (
    actualKey === expectedKey ||
    (provider === "mysql" &&
      expectedKey === "castidasbinary" &&
      actualKey === "castidascharcharsetbinary")
  );
};

const postgresIndexKey = (value: unknown): unknown =>
  typeof value === "string"
    ? value.replace(/\s+(?:asc|desc)(?:\s+nulls\s+(?:first|last))?$/i, "")
    : value;

const isCatalogTrue = (value: unknown): boolean =>
  value === true || value === 1 || value === 1n || value === "YES";

const isCatalogFalse = (value: unknown): boolean =>
  value === false || value === 0 || value === 0n || value === "NO";

interface PrismaInsightsCatalogKey {
  readonly value: unknown;
  readonly descending: unknown;
}

interface PrismaInsightsCatalogIndex {
  readonly name: unknown;
  readonly table: unknown;
  readonly unique: unknown;
  readonly healthy: boolean;
  readonly keys: readonly PrismaInsightsCatalogKey[];
}

const hasExpectedPrismaInsightsIndexLayout = (
  provider: ORMSQLProvider,
  indexes: readonly PrismaInsightsCatalogIndex[],
): boolean =>
  PRISMA_INSIGHTS_REQUIRED_INDEXES.every((name) => {
    const expected = PRISMA_INSIGHTS_REQUIRED_INDEX_LAYOUTS[name];
    const table = PRISMA_INSIGHTS_INDEX_TABLES[name];
    const actual = indexes.filter(
      (index) => index.name === name && index.table === table,
    );
    if (actual.length !== 1) return false;
    const index = actual[0]!;
    if (
      !index.healthy ||
      index.unique !== isRequiredIndexUnique(provider, expected) ||
      index.keys.length !== expected.keys.length
    ) {
      return false;
    }
    return expected.keys.every((key, position) => {
      const actualKey = index.keys[position];
      return (
        actualKey !== undefined &&
        typeof actualKey.value === "string" &&
        hasExpectedIndexKey(
          provider,
          actualKey.value,
          indexKeyValue(provider, key),
        ) &&
        isCatalogTrue(actualKey.descending) ===
          indexKeyDirection(name, position)
      );
    });
  });

const groupCatalogRows = <TRow>(
  rows: readonly TRow[],
  readName: (row: TRow) => unknown,
): ReadonlyMap<string, readonly TRow[]> => {
  const groups = new Map<string, TRow[]>();
  for (const row of rows) {
    const name = readName(row);
    if (typeof name !== "string") continue;
    const group = groups.get(name) ?? [];
    group.push(row);
    groups.set(name, group);
  }
  return groups;
};

const hasExpectedSourceGenerationIndex = (
  provider: ORMSQLProvider,
  indexes: readonly PrismaInsightsCatalogIndex[],
): boolean =>
  indexes.some(
    (index) =>
      index.table === PRISMA_INSIGHTS_EVENTS &&
      index.unique === true &&
      index.healthy &&
      index.keys.length === 1 &&
      typeof index.keys[0]?.value === "string" &&
      hasExpectedIndexKey(provider, index.keys[0].value, "source_generation") &&
      isCatalogFalse(index.keys[0].descending),
  );

const jobSchema = (provider: ORMSQLProvider): string[] => {
  const text =
    provider === "mysql"
      ? "longtext"
      : provider === "mssql"
        ? "nvarchar(max)"
        : provider === "cockroachdb"
          ? "string"
          : "text";
  const id =
    provider === "mysql"
      ? "varchar(36) character set ascii collate ascii_bin"
      : provider === "mssql"
        ? "varchar(36) collate Latin1_General_100_BIN2"
        : provider === "sqlite"
          ? "text collate binary"
          : provider === "postgresql"
            ? 'varchar(36) collate "C"'
            : "varchar(36)";
  const word =
    provider === "mysql"
      ? "varchar(32) character set ascii collate ascii_bin"
      : provider === "mssql"
        ? "varchar(32) collate Latin1_General_100_BIN2"
        : provider === "sqlite"
          ? "text collate binary"
          : provider === "postgresql"
            ? 'varchar(32) collate "C"'
            : "varchar(32)";
  const bytes =
    provider === "postgresql"
      ? "bytea"
      : provider === "cockroachdb"
        ? "bytes"
        : provider === "mysql"
          ? "binary(32)"
          : provider === "mssql"
            ? "binary(32)"
            : "blob";
  const orderBytes =
    provider === "mysql" || provider === "mssql" ? "varbinary(2048)" : bytes;
  const sealDigestBytes =
    provider === "mysql" || provider === "mssql" ? "varbinary(64)" : bytes;
  // Prisma maps a declared SQLite INTEGER raw column to its 32-bit Int type.
  // REAL preserves the safe-integer millisecond/generation domain used here.
  const integer = provider === "sqlite" ? "real" : "bigint";
  const create =
    provider === "mssql"
      ? (table: string, body: string) =>
          `if object_id(N'${table}', N'U') is null create table ${table} (${body})`
      : (table: string, body: string) =>
          `create table if not exists ${table} (${body})${provider === "mysql" ? " engine=InnoDB" : provider === "sqlite" ? " strict" : ""}`;
  const statements = [
    create(
      PRISMA_INSIGHTS_SEARCH_HEADS,
      `query_key ${bytes} primary key, query_json ${text} not null,
       active_job_id ${id} null, publication_job_id ${id} null`,
    ),
    create(
      PRISMA_INSIGHTS_SEARCH_JOBS,
      `id ${id} primary key, query_key ${bytes} not null,
       query_json ${text} not null, state ${word} not null, phase ${word} not null,
       source_generation ${integer} not null, as_of_ms ${integer} not null,
       completed_at_ms ${integer} null, after_generation ${integer} not null,
       total ${integer} null, failure_json ${text} null,
       lease_owner ${id} null, lease_version ${integer} not null${
         provider === "mysql"
           ? ", key private_hot_updater_prisma_search_jobs_state_idx (state,id)"
           : ""
       }`,
    ),
    create(
      PRISMA_INSIGHTS_SEARCH_ROWS,
      `job_id ${id} not null, install_key ${bytes} not null,
       install_id ${text} not null, event_id ${id} null,
       received_at_ms ${integer} null, event_order ${provider === "mysql" || provider === "mssql" ? "binary(16)" : bytes} null,
       event_json ${text} null, primary key (job_id,install_key)`,
    ),
    create(
      PRISMA_INSIGHTS_REPORT_HEADS,
      `query_key ${bytes} primary key, query_json ${text} not null,
       active_job_id ${id} null, publication_job_id ${id} null`,
    ),
    create(
      PRISMA_INSIGHTS_REPORT_JOBS,
      `id ${id} primary key, query_key ${bytes} not null,
       query_json ${text} not null, state ${word} not null, phase ${word} not null,
       source_generation ${integer} not null, as_of_ms ${integer} not null,
       completed_at_ms ${integer} null, after_generation ${integer} not null,
       after_key ${bytes} null, order_phase integer not null,
       order_totals_json ${text} not null, publication_json ${text} null,
       manifest_json ${text} null, manifest_digest ${bytes} null,
       failure_json ${text} null, lease_owner ${id} null,
       lease_version ${integer} not null${
         provider === "mysql"
           ? ", key private_hot_updater_prisma_report_jobs_state_idx (state,id)"
           : ""
       }`,
    ),
    create(
      PRISMA_INSIGHTS_REPORT_MEMBERS,
      `job_id ${id} not null, member_key ${bytes} not null,
       section ${word} not null, metric ${word} not null, label ${text} not null,
       bucket_start_ms ${integer} not null, install_id ${text} not null,
       primary key (job_id,member_key)${
         provider === "mysql"
           ? ", key private_hot_updater_prisma_report_members_page_idx (job_id,section,metric,member_key)"
           : ""
       }`,
    ),
    create(
      PRISMA_INSIGHTS_REPORT_LATEST,
      `job_id ${id} not null, install_key ${bytes} not null,
       bucket_index integer not null, received_at_ms ${integer} not null,
       event_id ${id} not null, event_json ${text} not null,
       primary key (job_id,install_key,bucket_index)`,
    ),
    create(
      PRISMA_INSIGHTS_REPORT_COUNTS,
      `job_id ${id} not null, count_key ${bytes} not null,
       section ${word} not null, metric ${word} not null, label ${text} not null,
       label_order ${orderBytes} not null,
       bucket_start_ms ${integer} not null, value ${integer} not null,
       primary key (job_id,count_key)${
         provider === "mysql"
           ? ", key private_hot_updater_prisma_report_counts_source_idx (job_id,section,metric,bucket_start_ms,count_key)"
           : ""
       }`,
    ),
    create(
      PRISMA_INSIGHTS_REPORT_ORDER,
      `job_id ${id} not null, order_kind ${word} not null,
       metric ${word} not null, ordinal ${integer} not null,
       label ${text} not null, value ${integer} not null,
       primary key (job_id,order_kind,metric,ordinal)${
         provider === "mysql"
           ? ", key private_hot_updater_prisma_report_order_page_idx (job_id,order_kind,metric,ordinal)"
           : ""
       }`,
    ),
    create(
      PRISMA_INSIGHTS_REPORT_SORT,
      `job_id ${id} not null, order_kind ${word} not null,
       metric ${word} not null, sort_pass integer not null,
       sort_run ${integer} not null, ordinal ${integer} not null,
       label ${text} not null, value ${integer} not null${
         provider === "mysql"
           ? ", unique key private_hot_updater_prisma_report_sort_page_idx (job_id,order_kind,metric,sort_pass,sort_run,ordinal)"
           : ""
       }`,
    ),
    create(
      PRISMA_INSIGHTS_REPORT_SEALS,
      `job_id ${id} not null, seal_kind ${word} not null,
       seal_key ${bytes} not null, row_digest ${sealDigestBytes} not null,
       primary key (job_id,seal_kind,seal_key)`,
    ),
  ];
  if (provider === "mysql") {
    return statements;
  }
  const index = (name: string, table: string, columns: string) =>
    provider === "mssql"
      ? `if not exists (select 1 from sys.indexes where name=N'${name}' and object_id=object_id(N'${table}')) create index ${name} on ${table} (${columns})`
      : `create index if not exists ${name} on ${table} (${columns})`;
  return [
    ...statements,
    index(
      "private_hot_updater_prisma_search_jobs_state_idx",
      PRISMA_INSIGHTS_SEARCH_JOBS,
      "state,id",
    ),
    index(
      "private_hot_updater_prisma_report_jobs_state_idx",
      PRISMA_INSIGHTS_REPORT_JOBS,
      "state,id",
    ),
    index(
      "private_hot_updater_prisma_report_members_page_idx",
      PRISMA_INSIGHTS_REPORT_MEMBERS,
      "job_id,section,metric,member_key",
    ),
    index(
      "private_hot_updater_prisma_report_order_page_idx",
      PRISMA_INSIGHTS_REPORT_ORDER,
      "job_id,order_kind,metric,ordinal",
    ),
    index(
      "private_hot_updater_prisma_report_counts_source_idx",
      PRISMA_INSIGHTS_REPORT_COUNTS,
      "job_id,section,metric,bucket_start_ms,count_key",
    ),
    provider === "mssql"
      ? `if not exists (select 1 from sys.indexes where name=N'private_hot_updater_prisma_report_sort_page_idx' and object_id=object_id(N'${PRISMA_INSIGHTS_REPORT_SORT}')) create unique index private_hot_updater_prisma_report_sort_page_idx on ${PRISMA_INSIGHTS_REPORT_SORT} (job_id,order_kind,metric,sort_pass,sort_run,ordinal)`
      : `create unique index if not exists private_hot_updater_prisma_report_sort_page_idx on ${PRISMA_INSIGHTS_REPORT_SORT} (job_id,order_kind,metric,sort_pass,sort_run,ordinal)`,
  ];
};

const postgresLike = (provider: "postgresql" | "cockroachdb"): string[] => {
  const bytes = provider === "postgresql" ? "bytea" : "bytes";
  const text = provider === "postgresql" ? "text" : "string";
  const float = provider === "postgresql" ? "double precision" : "float8";
  return [
    ...(provider === "cockroachdb"
      ? [
          `alter table bundle_events add column if not exists ${PRISMA_INSIGHTS_MIGRATION_COLUMN}
            ${bytes} as (id::string::bytes) stored`,
        ]
      : []),
    `create index if not exists ${PRISMA_INSIGHTS_MIGRATION_INDEX}
      on bundle_events (${
        provider === "postgresql"
          ? 'id collate "C"'
          : PRISMA_INSIGHTS_MIGRATION_COLUMN
      })`,
    `create table if not exists ${PRISMA_INSIGHTS_STATE} (
      id smallint primary key,
      layout_version integer not null,
      ready boolean not null,
      failed_reason ${text} null,
      migration_initialized boolean not null,
      migration_upper_id ${text} null,
      migration_after_id ${text} null,
      check (id = 1)
    )`,
    `create table if not exists ${PRISMA_INSIGHTS_SOURCE} (
      id smallint primary key, source_id varchar(36) not null,
      generation bigint not null,
      check (id = 1), check (generation >= 0)
    )`,
    `create table if not exists ${PRISMA_INSIGHTS_EVENTS} (
      event_id ${text} primary key,
      source_generation bigint not null unique,
      received_at_ms ${float} not null,
      event_order ${bytes} not null,
      install_key ${bytes} not null,
      install_id ${text} not null,
      type ${text} not null,
      to_bundle_id ${text} not null,
      from_bundle_id ${text} null,
      event_json ${text} not null,
      check (source_generation > 0)
    )`,
    `create index if not exists private_hot_updater_prisma_insights_events_global_idx
      on ${PRISMA_INSIGHTS_EVENTS} (received_at_ms desc, event_order desc)`,
    `create index if not exists private_hot_updater_prisma_insights_events_install_idx
      on ${PRISMA_INSIGHTS_EVENTS} (install_key, type, received_at_ms desc, event_order desc)`,
    `create index if not exists private_hot_updater_prisma_insights_events_to_bundle_idx
      on ${PRISMA_INSIGHTS_EVENTS} (type, to_bundle_id, received_at_ms desc, event_order desc)`,
    `create index if not exists private_hot_updater_prisma_insights_events_from_bundle_idx
      on ${PRISMA_INSIGHTS_EVENTS} (type, from_bundle_id, received_at_ms desc, event_order desc)`,
    `create table if not exists ${PRISMA_INSIGHTS_LIVE} (
      install_key ${bytes} primary key,
      install_id ${text} not null,
      event_id ${text} not null,
      received_at_ms ${float} not null,
      event_order ${bytes} not null,
      source_generation bigint not null,
      event_json ${text} not null
    )`,
    `create table if not exists ${PRISMA_INSIGHTS_ALIASES} (
      alias_key ${bytes} primary key,
      alias_kind ${text} not null,
      normalized_alias ${text} not null,
      original_alias ${text} not null,
      install_key ${bytes} not null,
      install_id ${text} not null,
      source_generation bigint not null
    )`,
    `create index if not exists private_hot_updater_prisma_insights_aliases_source_idx
      on ${PRISMA_INSIGHTS_ALIASES} (source_generation, alias_key)`,
  ];
};

const sqlite = (): string[] => [
  `create index if not exists ${PRISMA_INSIGHTS_MIGRATION_INDEX}
    on bundle_events (cast(id as blob))`,
  `create table if not exists ${PRISMA_INSIGHTS_STATE} (
    id integer primary key check (id = 1),
    layout_version integer not null,
    ready integer not null check (ready in (0, 1)),
    failed_reason text null,
    migration_initialized integer not null check (migration_initialized in (0, 1)),
    migration_upper_id text null,
    migration_after_id text null
  ) strict`,
  `create table if not exists ${PRISMA_INSIGHTS_SOURCE} (
    id integer primary key check (id = 1),
    source_id text not null,
    generation integer not null check (generation >= 0)
  ) strict`,
  `create table if not exists ${PRISMA_INSIGHTS_EVENTS} (
    event_id text primary key,
    source_generation integer not null unique check (source_generation > 0),
    received_at_ms real not null,
    event_order blob not null,
    install_key blob not null,
    install_id text not null,
    type text not null,
    to_bundle_id text not null,
    from_bundle_id text null,
    event_json text not null
  ) strict`,
  `create index if not exists private_hot_updater_prisma_insights_events_global_idx
    on ${PRISMA_INSIGHTS_EVENTS} (received_at_ms desc, event_order desc)`,
  `create index if not exists private_hot_updater_prisma_insights_events_install_idx
    on ${PRISMA_INSIGHTS_EVENTS} (install_key, type, received_at_ms desc, event_order desc)`,
  `create index if not exists private_hot_updater_prisma_insights_events_to_bundle_idx
    on ${PRISMA_INSIGHTS_EVENTS} (type, to_bundle_id, received_at_ms desc, event_order desc)`,
  `create index if not exists private_hot_updater_prisma_insights_events_from_bundle_idx
    on ${PRISMA_INSIGHTS_EVENTS} (type, from_bundle_id, received_at_ms desc, event_order desc)`,
  `create table if not exists ${PRISMA_INSIGHTS_LIVE} (
    install_key blob primary key,
    install_id text not null,
    event_id text not null,
    received_at_ms real not null,
    event_order blob not null,
    source_generation integer not null,
    event_json text not null
  ) strict`,
  `create table if not exists ${PRISMA_INSIGHTS_ALIASES} (
    alias_key blob primary key,
    alias_kind text not null,
    normalized_alias text not null,
    original_alias text not null,
    install_key blob not null,
    install_id text not null,
    source_generation integer not null
  ) strict`,
  `create index if not exists private_hot_updater_prisma_insights_aliases_source_idx
    on ${PRISMA_INSIGHTS_ALIASES} (source_generation, alias_key)`,
];

const mysql = (): string[] => [
  `create index ${PRISMA_INSIGHTS_MIGRATION_INDEX}
    on bundle_events ((cast(id as binary)))`,
  `create table if not exists ${PRISMA_INSIGHTS_STATE} (
    id tinyint primary key,
    layout_version int not null,
    ready boolean not null,
    failed_reason text null,
    migration_initialized boolean not null,
    migration_upper_id text null,
    migration_after_id text null,
    check (id = 1)
  ) engine=InnoDB`,
  `create table if not exists ${PRISMA_INSIGHTS_SOURCE} (
    id tinyint primary key,
    source_id varchar(36) character set ascii collate ascii_bin not null,
    generation bigint not null,
    check (id = 1), check (generation >= 0)
  ) engine=InnoDB`,
  `create table if not exists ${PRISMA_INSIGHTS_EVENTS} (
    event_id varchar(36) character set ascii collate ascii_bin primary key,
    source_generation bigint not null unique,
    received_at_ms double not null,
    event_order binary(16) not null,
    install_key binary(32) not null,
    install_id text not null,
    type varchar(32) character set ascii collate ascii_bin not null,
    to_bundle_id varchar(36) character set ascii collate ascii_bin not null,
    from_bundle_id varchar(36) character set ascii collate ascii_bin null,
    event_json mediumtext not null,
    key private_hot_updater_prisma_insights_events_global_idx (received_at_ms desc, event_order desc),
    key private_hot_updater_prisma_insights_events_install_idx (install_key, type, received_at_ms desc, event_order desc),
    key private_hot_updater_prisma_insights_events_to_bundle_idx (type, to_bundle_id, received_at_ms desc, event_order desc),
    key private_hot_updater_prisma_insights_events_from_bundle_idx (type, from_bundle_id, received_at_ms desc, event_order desc),
    check (source_generation > 0)
  ) engine=InnoDB`,
  `create table if not exists ${PRISMA_INSIGHTS_LIVE} (
    install_key binary(32) primary key,
    install_id text not null,
    event_id varchar(36) character set ascii collate ascii_bin not null,
    received_at_ms double not null,
    event_order binary(16) not null,
    source_generation bigint not null,
    event_json mediumtext not null
  ) engine=InnoDB`,
  `create table if not exists ${PRISMA_INSIGHTS_ALIASES} (
    alias_key binary(32) primary key,
    alias_kind varchar(16) character set ascii collate ascii_bin not null,
    normalized_alias text not null,
    original_alias text not null,
    install_key binary(32) not null,
    install_id text not null,
    source_generation bigint not null,
    key private_hot_updater_prisma_insights_aliases_source_idx (source_generation, alias_key)
  ) engine=InnoDB`,
];

const mssql = (): string[] => [
  `if col_length(N'bundle_events', N'private_hot_updater_prisma_insights_migration_id') is null
    alter table bundle_events add private_hot_updater_prisma_insights_migration_id
      as convert(binary(32),hashbytes('SHA2_256',convert(nvarchar(max),id))) persisted`,
  `if not exists (select 1 from sys.indexes where name=N'${PRISMA_INSIGHTS_MIGRATION_INDEX}' and object_id=object_id(N'bundle_events'))
    create unique index ${PRISMA_INSIGHTS_MIGRATION_INDEX} on bundle_events
      (private_hot_updater_prisma_insights_migration_id)`,
  `if object_id(N'${PRISMA_INSIGHTS_STATE}', N'U') is null
    create table ${PRISMA_INSIGHTS_STATE} (
      id tinyint primary key check (id = 1), layout_version int not null,
      ready bit not null, failed_reason nvarchar(max) null,
      migration_initialized bit not null, migration_upper_id nvarchar(1024) null,
      migration_after_id nvarchar(1024) null
    )`,
  `if object_id(N'${PRISMA_INSIGHTS_SOURCE}', N'U') is null
    create table ${PRISMA_INSIGHTS_SOURCE} (
      id tinyint primary key check (id = 1),
      source_id varchar(36) collate Latin1_General_100_BIN2 not null,
      generation bigint not null check (generation >= 0)
    )`,
  `if object_id(N'${PRISMA_INSIGHTS_EVENTS}', N'U') is null
    create table ${PRISMA_INSIGHTS_EVENTS} (
      event_id varchar(36) collate Latin1_General_100_BIN2 primary key,
      source_generation bigint not null unique check (source_generation > 0),
      received_at_ms float not null, event_order binary(16) not null,
      install_key binary(32) not null, install_id nvarchar(1024) not null,
      type varchar(32) collate Latin1_General_100_BIN2 not null,
      to_bundle_id varchar(36) collate Latin1_General_100_BIN2 not null,
      from_bundle_id varchar(36) collate Latin1_General_100_BIN2 null,
      event_json nvarchar(max) not null
    )`,
  `if not exists (select 1 from sys.indexes where name=N'private_hot_updater_prisma_insights_events_global_idx' and object_id=object_id(N'${PRISMA_INSIGHTS_EVENTS}'))
    create index private_hot_updater_prisma_insights_events_global_idx on ${PRISMA_INSIGHTS_EVENTS} (received_at_ms desc, event_order desc)`,
  `if not exists (select 1 from sys.indexes where name=N'private_hot_updater_prisma_insights_events_install_idx' and object_id=object_id(N'${PRISMA_INSIGHTS_EVENTS}'))
    create index private_hot_updater_prisma_insights_events_install_idx on ${PRISMA_INSIGHTS_EVENTS} (install_key, type, received_at_ms desc, event_order desc)`,
  `if not exists (select 1 from sys.indexes where name=N'private_hot_updater_prisma_insights_events_to_bundle_idx' and object_id=object_id(N'${PRISMA_INSIGHTS_EVENTS}'))
    create index private_hot_updater_prisma_insights_events_to_bundle_idx on ${PRISMA_INSIGHTS_EVENTS} (type, to_bundle_id, received_at_ms desc, event_order desc)`,
  `if not exists (select 1 from sys.indexes where name=N'private_hot_updater_prisma_insights_events_from_bundle_idx' and object_id=object_id(N'${PRISMA_INSIGHTS_EVENTS}'))
    create index private_hot_updater_prisma_insights_events_from_bundle_idx on ${PRISMA_INSIGHTS_EVENTS} (type, from_bundle_id, received_at_ms desc, event_order desc)`,
  `if object_id(N'${PRISMA_INSIGHTS_LIVE}', N'U') is null
    create table ${PRISMA_INSIGHTS_LIVE} (
      install_key binary(32) primary key, install_id nvarchar(1024) not null,
      event_id varchar(36) collate Latin1_General_100_BIN2 not null,
      received_at_ms float not null, event_order binary(16) not null,
      source_generation bigint not null, event_json nvarchar(max) not null
    )`,
  `if object_id(N'${PRISMA_INSIGHTS_ALIASES}', N'U') is null
    create table ${PRISMA_INSIGHTS_ALIASES} (
      alias_key binary(32) primary key, alias_kind varchar(16) not null,
      normalized_alias nvarchar(1024) not null,
      original_alias nvarchar(1024) not null, install_key binary(32) not null,
      install_id nvarchar(1024) not null, source_generation bigint not null
    )`,
  `if not exists (select 1 from sys.indexes where name=N'private_hot_updater_prisma_insights_aliases_source_idx' and object_id=object_id(N'${PRISMA_INSIGHTS_ALIASES}'))
    create index private_hot_updater_prisma_insights_aliases_source_idx on ${PRISMA_INSIGHTS_ALIASES} (source_generation, alias_key)`,
];

export const getPrismaInsightsSchemaSql = (
  provider: ORMSQLProvider,
): readonly string[] => {
  let source: readonly string[];
  switch (provider) {
    case "postgresql":
    case "cockroachdb":
      source = postgresLike(provider);
      break;
    case "sqlite":
      source = sqlite();
      break;
    case "mysql":
      source = mysql();
      break;
    case "mssql":
      source = mssql();
      break;
  }
  return [...source, ...jobSchema(provider)];
};

const stateInsert = (provider: ORMSQLProvider): string => {
  const values =
    provider === "mssql"
      ? `(1, ${PRISMA_INSIGHTS_LAYOUT_VERSION}, 0, null, 0, null, null)`
      : `(1, ${PRISMA_INSIGHTS_LAYOUT_VERSION}, false, null, false, null, null)`;
  switch (provider) {
    case "postgresql":
    case "cockroachdb":
    case "sqlite":
      return `insert into ${PRISMA_INSIGHTS_STATE}
        (id,layout_version,ready,failed_reason,migration_initialized,migration_upper_id,migration_after_id)
        values ${values} on conflict (id) do nothing`;
    case "mysql":
      return `insert ignore into ${PRISMA_INSIGHTS_STATE}
        (id,layout_version,ready,failed_reason,migration_initialized,migration_upper_id,migration_after_id)
        values ${values}`;
    case "mssql":
      return `if not exists (select 1 from ${PRISMA_INSIGHTS_STATE} where id=1)
        insert into ${PRISMA_INSIGHTS_STATE}
        (id,layout_version,ready,failed_reason,migration_initialized,migration_upper_id,migration_after_id)
        values ${values}`;
  }
};

const sourceInsert = (provider: ORMSQLProvider, databaseNamespace: string) => {
  const sql = new PrismaInsightsSql(provider);
  const sourceId = sql.value(databaseNamespace);
  switch (provider) {
    case "postgresql":
    case "cockroachdb":
    case "sqlite":
      return sql.statement(
        `insert into ${PRISMA_INSIGHTS_SOURCE} (id,source_id,generation)
         values (1,${sourceId},0) on conflict (id) do nothing`,
      );
    case "mysql":
      return sql.statement(
        `insert into ${PRISMA_INSIGHTS_SOURCE} (id,source_id,generation)
         values (1,${sourceId},0) on duplicate key update id=id`,
      );
    case "mssql":
      return sql.statement(
        `if not exists (select 1 from ${PRISMA_INSIGHTS_SOURCE} with (updlock,holdlock) where id=1)
         insert into ${PRISMA_INSIGHTS_SOURCE} (id,source_id,generation)
         values (1,${sourceId},0)`,
      );
  }
};

/** DDL/tooling boundary. Runtime queries never create or repair schema. */
export const createPrismaInsightsLayout = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  databaseNamespace: string,
): Promise<void> => {
  assertPrismaInsightsDatabaseNamespace(databaseNamespace);
  if (provider === "mysql") {
    await client.$executeRawUnsafe(
      `create table if not exists ${PRISMA_INSIGHTS_MYSQL_DDL} (
        layout_version int not null,
        ordinal smallint not null,
        statement_key varchar(64) character set ascii collate ascii_bin not null,
        statement_hash binary(32) not null,
        primary key (layout_version,statement_key),
        unique key private_hot_updater_prisma_insights_ddl_ordinal_key
          (layout_version,ordinal)
      ) engine=InnoDB`,
    );
    const statements = getPrismaInsightsSchemaSql(provider);
    for (let index = 0; index < statements.length; index += 1) {
      const query = statements[index]!;
      const statementKey = `layout-${String(index).padStart(3, "0")}`;
      const statementHash = createHash("sha256")
        .update(
          JSON.stringify([
            "prisma-insights-mysql-ddl-1",
            PRISMA_INSIGHTS_LAYOUT_VERSION,
            index,
            query,
          ]),
        )
        .digest();
      const readLedger = () =>
        client.$queryRawUnsafe<{ statement_hash: Uint8Array }[]>(
          `select statement_hash from ${PRISMA_INSIGHTS_MYSQL_DDL}
           where layout_version=? and statement_key=?`,
          PRISMA_INSIGHTS_LAYOUT_VERSION,
          statementKey,
        );
      const applied = await readLedger();
      if (applied[0]) {
        if (!Buffer.from(applied[0].statement_hash).equals(statementHash)) {
          throw new PrismaInsightsConfigurationError(
            `Prisma Insights MySQL DDL checksum mismatch for ${statementKey}`,
          );
        }
        continue;
      }
      if (query.includes(`create index ${PRISMA_INSIGHTS_MIGRATION_INDEX}`)) {
        const hasMigrationIndex = async () => {
          const existing = await client.$queryRawUnsafe<{ name: unknown }[]>(
            `select index_name as name from information_schema.statistics
               where table_schema=database() and table_name='bundle_events'
                 and index_name=?`,
            PRISMA_INSIGHTS_MIGRATION_INDEX,
          );
          return existing.some(
            ({ name }) => name === PRISMA_INSIGHTS_MIGRATION_INDEX,
          );
        };
        if (!(await hasMigrationIndex())) {
          try {
            await client.$executeRawUnsafe(query);
          } catch (error) {
            if (!(await hasMigrationIndex())) throw error;
          }
        }
      } else {
        await client.$executeRawUnsafe(query);
      }
      await client.$executeRawUnsafe(
        `insert into ${PRISMA_INSIGHTS_MYSQL_DDL}
         (layout_version,ordinal,statement_key,statement_hash) values (?,?,?,?)
         on duplicate key update statement_key=statement_key`,
        PRISMA_INSIGHTS_LAYOUT_VERSION,
        index,
        statementKey,
        statementHash,
      );
      const recorded = await readLedger();
      if (
        recorded[0] === undefined ||
        !Buffer.from(recorded[0].statement_hash).equals(statementHash)
      ) {
        throw new PrismaInsightsConfigurationError(
          `Could not record Prisma Insights MySQL DDL ${statementKey}`,
        );
      }
    }
    await client.$executeRawUnsafe(
      `insert into ${PRISMA_INSIGHTS_STATE}
       (id,layout_version,ready,failed_reason,migration_initialized,migration_upper_id,migration_after_id)
       values (1,?,false,null,false,null,null)
       on duplicate key update id=id`,
      PRISMA_INSIGHTS_LAYOUT_VERSION,
    );
    await executePrismaInsights(
      client,
      sourceInsert(provider, databaseNamespace),
    );
    return;
  }
  for (const query of getPrismaInsightsSchemaSql(provider)) {
    await executePrismaInsights(client, { query, values: [] });
  }
  await executePrismaInsights(client, {
    query: stateInsert(provider),
    values: [],
  });
  await executePrismaInsights(
    client,
    sourceInsert(provider, databaseNamespace),
  );
};

export interface PrismaInsightsCatalogColumn {
  readonly table: string;
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly collation: string | null;
  readonly defaultValue: string | null;
}

export interface PrismaInsightsCatalogTable {
  readonly name: string;
  readonly columns: readonly PrismaInsightsCatalogColumn[];
  readonly keys: readonly string[];
  readonly checks: readonly string[];
}

const splitPrismaInsightsDdl = (value: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    if (value[index] === ")") depth -= 1;
    if (value[index] === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
};

const readPrismaInsightsTableDdl = (
  statement: string,
): { readonly name: string; readonly body: string } | null => {
  const match =
    /create\s+table(?:\s+if\s+not\s+exists)?\s+([a-z0-9_]+)\s*\(/i.exec(
      statement,
    );
  if (!match?.[1]) return null;
  const bodyStart = statement.indexOf("(", match.index + match[0].length - 1);
  let depth = 0;
  for (let index = bodyStart; index < statement.length; index += 1) {
    if (statement[index] === "(") depth += 1;
    if (statement[index] === ")") {
      depth -= 1;
      if (depth === 0)
        return {
          name: match[1].toLowerCase(),
          body: statement.slice(bodyStart + 1, index),
        };
    }
  }
  return null;
};

const normalizePrismaInsightsConstraint = (value: string): string =>
  value
    .toLowerCase()
    .replace(/(?:\s|`|"|\[|\]|\(|\))/g, "")
    .replace(/::(?:int2|int4|int8|integer|bigint|smallint|boolean)/g, "");

const normalizePrismaInsightsColumnType = (
  provider: ORMSQLProvider,
  value: string,
): string => {
  let type = value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^character varying/, "varchar")
    .replace(/^double precision$/, "float8")
    .replace(/^int8$/, "bigint")
    .replace(/^int4$/, "integer")
    .replace(/^int2$/, "smallint")
    .replace(/^bool$/, "boolean")
    .replace(/^string$/, "text");
  if (provider === "mysql" && type === "tinyint(1)") type = "boolean";
  if (provider === "mysql" && type === "integer") type = "int";
  if (provider === "cockroachdb" && type === "integer") type = "bigint";
  if (provider === "cockroachdb" && type === "bytea") type = "bytes";
  if (provider === "mssql" && type === "integer") type = "int";
  if (provider === "mssql" && type === "float(53)") type = "float";
  return type;
};

const parsePrismaInsightsCatalogTable = (
  provider: ORMSQLProvider,
  statement: string,
): PrismaInsightsCatalogTable | null => {
  const table = readPrismaInsightsTableDdl(statement);
  if (table === null) return null;
  const fragments = splitPrismaInsightsDdl(table.body);
  const tablePrimary = fragments
    .filter((fragment) => /^primary\s+key/i.test(fragment))
    .flatMap((fragment) => {
      const match = /\(([^)]+)\)/.exec(fragment);
      return match
        ? match[1]!.split(",").map((value) => value.trim().toLowerCase())
        : [];
    });
  const columns: PrismaInsightsCatalogColumn[] = [];
  const keys: string[] = [];
  const checks: string[] = [];
  for (const fragment of fragments) {
    const checkMatches = [...fragment.matchAll(/check\s*\(([^)]+)\)/gi)];
    checks.push(
      ...checkMatches.map((match) =>
        normalizePrismaInsightsConstraint(match[1]!),
      ),
    );
    const key =
      /^(primary\s+key|unique(?:\s+key\s+[a-z0-9_]+)?)\s*\(([^)]+)\)/i.exec(
        fragment,
      );
    if (key) {
      keys.push(
        `${key[1]!.toLowerCase().startsWith("primary") ? "PRIMARY KEY" : "UNIQUE"}:${key[2]!
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .join(",")}`,
      );
      continue;
    }
    if (/^(?:key|constraint|check)\b/i.test(fragment)) continue;
    const column = /^([a-z0-9_]+)\s+(.+)$/is.exec(fragment);
    if (!column?.[1] || !column[2]) continue;
    const definition = column[2].trim();
    const typeMatch =
      /^(.*?)(?=\s+(?:primary\s+key|not\s+null|null|unique|check\s*\(|collate\s+|character\s+set\s+|default\s+|as\s+\()|$)/is.exec(
        definition,
      );
    const type = normalizePrismaInsightsColumnType(
      provider,
      typeMatch?.[1] ?? definition,
    );
    const collationMatch = /\bcollate\s+(?:"([^"]+)"|([a-z0-9_]+))/i.exec(
      definition,
    );
    const name = column[1].toLowerCase();
    const defaultMatch =
      /\bdefault\s+(.+?)(?=\s+(?:not\s+null|null|check\s*\(|collate\s+)|$)/is.exec(
        definition,
      );
    const primary =
      /\bprimary\s+key\b/i.test(definition) || tablePrimary.includes(name);
    columns.push({
      table: table.name,
      name,
      type,
      nullable: !primary && !/\bnot\s+null\b/i.test(definition),
      collation:
        (collationMatch?.[1] ?? collationMatch?.[2] ?? null)?.toLowerCase() ??
        null,
      defaultValue: defaultMatch?.[1]?.trim().toLowerCase() ?? null,
    });
    if (/\bprimary\s+key\b/i.test(definition)) keys.push(`PRIMARY KEY:${name}`);
    if (/\bunique\b/i.test(definition)) keys.push(`UNIQUE:${name}`);
  }
  return {
    name: table.name,
    columns,
    keys: keys.sort(),
    checks: checks.sort(),
  };
};

const mysqlDdlTableSql = `create table if not exists ${PRISMA_INSIGHTS_MYSQL_DDL} (
  layout_version int not null,
  ordinal smallint not null,
  statement_key varchar(64) character set ascii collate ascii_bin not null,
  statement_hash binary(32) not null,
  primary key (layout_version,statement_key),
  unique key private_hot_updater_prisma_insights_ddl_ordinal_key (layout_version,ordinal)
) engine=InnoDB`;

export const getExpectedPrismaInsightsCatalog = (
  provider: ORMSQLProvider,
): readonly PrismaInsightsCatalogTable[] => {
  const tables = [
    ...getPrismaInsightsSchemaSql(provider),
    ...(provider === "mysql" ? [mysqlDdlTableSql] : []),
  ]
    .map((statement) => parsePrismaInsightsCatalogTable(provider, statement))
    .filter(
      (table): table is PrismaInsightsCatalogTable =>
        table !== null &&
        table.name.startsWith("private_hot_updater_prisma_insights_"),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  if (provider !== "cockroachdb") return tables;
  return tables.map((table) =>
    table.name === PRISMA_INSIGHTS_REPORT_SORT
      ? {
          ...table,
          columns: [
            ...table.columns,
            {
              table: table.name,
              name: "rowid",
              type: "bigint",
              nullable: false,
              collation: null,
              defaultValue: "unique_rowid()",
            },
          ],
          keys: [
            "PRIMARY KEY:rowid",
            "UNIQUE:job_id,order_kind,metric,sort_pass,sort_run,ordinal",
          ],
        }
      : table,
  );
};

const readPrismaInsightsCatalogColumns = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
): Promise<readonly PrismaInsightsCatalogColumn[]> => {
  if (provider === "sqlite") {
    const rows = await client.$queryRawUnsafe<
      { name: unknown; sql: unknown }[]
    >(
      `select name,sql from sqlite_master where type='table'
       and name like 'private_hot_updater_prisma_insights_%' order by name`,
    );
    return rows.flatMap((row) => {
      if (typeof row.sql !== "string") return [];
      return parsePrismaInsightsCatalogTable(provider, row.sql)?.columns ?? [];
    });
  }
  const schema =
    provider === "mysql"
      ? "table_schema=database()"
      : provider === "mssql"
        ? "table_schema=schema_name()"
        : "table_schema=current_schema()";
  const type =
    provider === "mysql"
      ? "column_type"
      : provider === "mssql"
        ? `case when character_maximum_length=-1 then data_type+'(max)'
             when character_maximum_length is not null then data_type+'('+convert(varchar(16),character_maximum_length)+')'
             else data_type end`
        : `case when data_type='character varying' then 'varchar('||character_maximum_length||')'
             else data_type end`;
  const rows = await client.$queryRawUnsafe<
    {
      table_name: unknown;
      column_name: unknown;
      column_type: unknown;
      is_nullable: unknown;
      collation_name: unknown;
      column_default: unknown;
    }[]
  >(
    `select table_name as table_name,column_name as column_name,
       ${type} as column_type,is_nullable as is_nullable,
       collation_name as collation_name,column_default as column_default
     from information_schema.columns where ${schema}
       and table_name like 'private_hot_updater_prisma_insights_%'
     order by table_name,ordinal_position`,
  );
  return rows.flatMap((row) =>
    typeof row.table_name === "string" &&
    typeof row.column_name === "string" &&
    typeof row.column_type === "string"
      ? [
          {
            table: row.table_name.toLowerCase(),
            name: row.column_name.toLowerCase(),
            type: normalizePrismaInsightsColumnType(provider, row.column_type),
            nullable: row.is_nullable === "YES",
            collation:
              typeof row.collation_name === "string"
                ? row.collation_name.toLowerCase()
                : null,
            defaultValue:
              typeof row.column_default === "string"
                ? row.column_default.toLowerCase()
                : row.column_default === null
                  ? null
                  : "invalid",
          },
        ]
      : [],
  );
};

const readPrismaInsightsCatalogKeys = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
): Promise<ReadonlyMap<string, readonly string[]>> => {
  if (provider === "sqlite") {
    const rows = await client.$queryRawUnsafe<
      { name: unknown; sql: unknown }[]
    >(
      `select name,sql from sqlite_master where type='table'
       and name like 'private_hot_updater_prisma_insights_%' order by name`,
    );
    return new Map(
      rows.flatMap((row) => {
        if (typeof row.sql !== "string") return [];
        const table = parsePrismaInsightsCatalogTable(provider, row.sql);
        return table === null ? [] : [[table.name, table.keys] as const];
      }),
    );
  }
  const schema =
    provider === "mysql"
      ? "tc.table_schema=database()"
      : provider === "mssql"
        ? "tc.table_schema=schema_name()"
        : "tc.table_schema=current_schema()";
  const rows = await client.$queryRawUnsafe<
    {
      table_name: unknown;
      constraint_name: unknown;
      constraint_type: unknown;
      column_name: unknown;
      ordinal_position: unknown;
    }[]
  >(
    `select tc.table_name as table_name,tc.constraint_name as constraint_name,
       tc.constraint_type as constraint_type,kcu.column_name as column_name,
       kcu.ordinal_position as ordinal_position
     from information_schema.table_constraints tc
     join information_schema.key_column_usage kcu
       on kcu.constraint_catalog=tc.constraint_catalog
       and kcu.constraint_schema=tc.constraint_schema
       and kcu.constraint_name=tc.constraint_name
       and kcu.table_name=tc.table_name
     where ${schema} and tc.table_name like 'private_hot_updater_prisma_insights_%'
       and tc.constraint_type in ('PRIMARY KEY','UNIQUE')
     order by tc.table_name,tc.constraint_name,kcu.ordinal_position`,
  );
  const grouped = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    if (
      typeof row.table_name !== "string" ||
      typeof row.constraint_name !== "string" ||
      typeof row.constraint_type !== "string" ||
      typeof row.column_name !== "string"
    )
      continue;
    const table = grouped.get(row.table_name) ?? new Map<string, string[]>();
    const key = `${row.constraint_type}:${row.constraint_name}`;
    const columns = table.get(key) ?? [];
    columns.push(row.column_name.toLowerCase());
    table.set(key, columns);
    grouped.set(row.table_name.toLowerCase(), table);
  }
  return new Map(
    [...grouped].map(([table, constraints]) => [
      table,
      [...constraints]
        .map(
          ([identity, columns]) =>
            `${identity.split(":")[0]}:${columns.join(",")}`,
        )
        .sort(),
    ]),
  );
};

const readPrismaInsightsCatalogChecks = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
): Promise<ReadonlyMap<string, readonly string[]>> => {
  if (provider === "sqlite") {
    const rows = await client.$queryRawUnsafe<
      { name: unknown; sql: unknown }[]
    >(
      `select name,sql from sqlite_master where type='table'
       and name like 'private_hot_updater_prisma_insights_%' order by name`,
    );
    return new Map(
      rows.flatMap((row) => {
        if (typeof row.sql !== "string") return [];
        const table = parsePrismaInsightsCatalogTable(provider, row.sql);
        return table === null ? [] : [[table.name, table.checks] as const];
      }),
    );
  }
  let query: string;
  if (provider === "postgresql") {
    query = `select tables.relname as table_name,pg_get_constraintdef(constraints.oid) as check_clause
      from pg_constraint constraints join pg_class tables on tables.oid=constraints.conrelid
      join pg_namespace namespace on namespace.oid=tables.relnamespace
      where namespace.nspname=current_schema() and constraints.contype='c'
        and tables.relname like 'private_hot_updater_prisma_insights_%'`;
  } else if (provider === "mssql") {
    query = `select object_name(parent_object_id) as table_name,definition as check_clause
      from sys.check_constraints where object_name(parent_object_id)
        like 'private_hot_updater_prisma_insights_%'`;
  } else {
    const schema =
      provider === "mysql"
        ? "tc.table_schema=database()"
        : "tc.table_schema=current_schema()";
    query = `select distinct tc.table_name as table_name,cc.check_clause as check_clause
      from information_schema.table_constraints tc
      join information_schema.check_constraints cc
        on cc.constraint_catalog=tc.constraint_catalog
        and cc.constraint_schema=tc.constraint_schema
        and cc.constraint_name=tc.constraint_name
      where ${schema} and tc.constraint_type='CHECK'
        and tc.table_name like 'private_hot_updater_prisma_insights_%'`;
  }
  const rows =
    await client.$queryRawUnsafe<
      { table_name: unknown; check_clause: unknown }[]
    >(query);
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    if (
      typeof row.table_name !== "string" ||
      typeof row.check_clause !== "string"
    )
      continue;
    const values = grouped.get(row.table_name.toLowerCase()) ?? [];
    const normalized = normalizePrismaInsightsConstraint(row.check_clause);
    if (provider === "cockroachdb" && normalized.endsWith("isnotnull"))
      continue;
    if (!values.includes(normalized)) values.push(normalized);
    grouped.set(row.table_name.toLowerCase(), values);
  }
  return new Map([...grouped].map(([table, checks]) => [table, checks.sort()]));
};

const hasNoUnexpectedPrismaInsightsConstraints = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
): Promise<boolean> => {
  if (provider === "sqlite") {
    const rows = await client.$queryRawUnsafe<{ table_name: unknown }[]>(
      `select tables.name as table_name from sqlite_master tables,
         pragma_foreign_key_list(tables.name) foreign_keys
       where tables.type='table'
         and tables.name like 'private_hot_updater_prisma_insights_%'`,
    );
    return rows.length === 0;
  }
  const schema =
    provider === "mysql"
      ? "table_schema=database()"
      : provider === "mssql"
        ? "table_schema=schema_name()"
        : "table_schema=current_schema()";
  const rows = await client.$queryRawUnsafe<{ constraint_type: unknown }[]>(
    `select constraint_type as constraint_type
     from information_schema.table_constraints where ${schema}
       and table_name like 'private_hot_updater_prisma_insights_%'
       and constraint_type not in ('PRIMARY KEY','UNIQUE','CHECK')`,
  );
  return rows.length === 0;
};

const hasNoUnexpectedPrismaInsightsIndexes = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
): Promise<boolean> => {
  let query: string;
  if (provider === "sqlite") {
    query = `select indexes.name from sqlite_master indexes
      where indexes.type='index' and indexes.sql is not null
        and (indexes.tbl_name like 'private_hot_updater_prisma_insights_%'
          or indexes.tbl_name='bundle_events')`;
  } else if (provider === "postgresql") {
    query = `select indexes.relname as name from pg_index metadata
      join pg_class indexes on indexes.oid=metadata.indexrelid
      join pg_class tables on tables.oid=metadata.indrelid
      join pg_namespace namespace on namespace.oid=tables.relnamespace
      left join pg_constraint constraints on constraints.conindid=indexes.oid
      where namespace.nspname=current_schema() and constraints.oid is null
        and (tables.relname like 'private_hot_updater_prisma_insights_%'
          or tables.relname='bundle_events')`;
  } else if (provider === "mssql") {
    query = `select indexes.name from sys.indexes indexes
      join sys.tables tables on tables.object_id=indexes.object_id
      where indexes.name is not null and indexes.is_primary_key=0
        and indexes.is_unique_constraint=0
        and (tables.name like 'private_hot_updater_prisma_insights_%'
          or tables.name='bundle_events')`;
  } else {
    const schema =
      provider === "mysql"
        ? "statistics.table_schema=database()"
        : "statistics.table_schema=current_schema()";
    query = `select distinct statistics.index_name as name
      from information_schema.statistics statistics
      left join information_schema.table_constraints constraints
        on constraints.constraint_catalog=statistics.table_catalog
        and constraints.constraint_schema=statistics.table_schema
        and constraints.table_name=statistics.table_name
        and constraints.constraint_name=statistics.index_name
        and constraints.constraint_type in ('PRIMARY KEY','UNIQUE')
      where ${schema} and constraints.constraint_name is null
        and (statistics.table_name like 'private_hot_updater_prisma_insights_%'
          or statistics.table_name='bundle_events')`;
  }
  const rows = await client.$queryRawUnsafe<{ name: unknown }[]>(query);
  const expected = new Set<string>(PRISMA_INSIGHTS_REQUIRED_INDEXES);
  return rows.every(
    (row) => typeof row.name === "string" && expected.has(row.name),
  );
};

const hasExactPrismaInsightsCatalog = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
): Promise<boolean> => {
  const expected = getExpectedPrismaInsightsCatalog(provider);
  const columns = await readPrismaInsightsCatalogColumns(client, provider);
  const actualTables = [
    ...new Set(columns.map((column) => column.table)),
  ].sort();
  if (
    JSON.stringify(actualTables) !==
    JSON.stringify(expected.map((table) => table.name))
  )
    return false;
  const keys = await readPrismaInsightsCatalogKeys(client, provider);
  const checks = await readPrismaInsightsCatalogChecks(client, provider);
  if (!(await hasNoUnexpectedPrismaInsightsConstraints(client, provider)))
    return false;
  for (const table of expected) {
    const actualColumns = columns.filter(
      (column) => column.table === table.name,
    );
    if (actualColumns.length !== table.columns.length) return false;
    for (let index = 0; index < table.columns.length; index += 1) {
      const expectedColumn = table.columns[index]!;
      const actualColumn = actualColumns[index]!;
      if (
        actualColumn.name !== expectedColumn.name ||
        actualColumn.type !== expectedColumn.type ||
        actualColumn.nullable !== expectedColumn.nullable ||
        actualColumn.defaultValue !== expectedColumn.defaultValue ||
        (expectedColumn.collation !== null &&
          actualColumn.collation !== expectedColumn.collation)
      )
        return false;
    }
    if (
      JSON.stringify(keys.get(table.name) ?? []) !== JSON.stringify(table.keys)
    )
      return false;
    const actualChecks = checks.get(table.name) ?? [];
    if (
      actualChecks.length !== table.checks.length ||
      !table.checks.every((expectedCheck) =>
        actualChecks.some((actualCheck) => actualCheck.includes(expectedCheck)),
      )
    )
      return false;
  }
  return hasNoUnexpectedPrismaInsightsIndexes(client, provider);
};

export const hasCompletePrismaInsightsLayout = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  databaseNamespace: string,
): Promise<boolean> => {
  assertPrismaInsightsDatabaseNamespace(databaseNamespace);
  if (!(await hasExactPrismaInsightsCatalog(client, provider))) return false;
  const source = await client.$queryRawUnsafe<{ source_id: unknown }[]>(
    `select source_id from ${PRISMA_INSIGHTS_SOURCE} where id=1`,
  );
  if (source.length !== 1 || source[0]?.source_id !== databaseNamespace)
    return false;
  const sql = new PrismaInsightsSql(provider);
  if (provider === "mssql") {
    const conditions = PRISMA_INSIGHTS_REQUIRED_INDEXES.map((name) => {
      const table = PRISMA_INSIGHTS_INDEX_TABLES[name];
      if (table === undefined) {
        throw new PrismaInsightsConfigurationError(
          `Missing Prisma Insights index owner for ${name}`,
        );
      }
      return `(indexes.name=${sql.value(name)} and indexes.object_id=object_id(${sql.value(table)}))`;
    });
    const rows = await queryPrismaInsights<
      {
        name: unknown;
        table_name: unknown;
        is_unique: unknown;
        is_disabled: unknown;
        has_filter: unknown;
        key_ordinal: unknown;
        column_name: unknown;
        is_descending_key: unknown;
        computed_definition: unknown;
        is_persisted: unknown;
      }[]
    >(
      client,
      sql.statement(
        `select indexes.name as name,object_name(indexes.object_id) as table_name,
           indexes.is_unique as is_unique,indexes.is_disabled as is_disabled,
           indexes.has_filter as has_filter,
           index_columns.key_ordinal,columns.name as column_name,
           index_columns.is_descending_key as is_descending_key,
           computed.definition as computed_definition,
           computed.is_persisted as is_persisted
         from sys.indexes indexes
         join sys.index_columns index_columns
           on index_columns.object_id=indexes.object_id
           and index_columns.index_id=indexes.index_id
         join sys.columns columns on columns.object_id=index_columns.object_id
           and columns.column_id=index_columns.column_id
         left join sys.computed_columns computed
           on computed.object_id=columns.object_id
           and computed.column_id=columns.column_id
         where ((${conditions.join(" or ")}) or
           (indexes.object_id=object_id(${sql.value(PRISMA_INSIGHTS_EVENTS)})
             and indexes.is_unique=1))
           and index_columns.key_ordinal>0
         order by indexes.name,index_columns.key_ordinal`,
      ),
    );
    const indexes = PRISMA_INSIGHTS_REQUIRED_INDEXES.map((name) => {
      const owner = PRISMA_INSIGHTS_INDEX_TABLES[name]!;
      const keys = rows
        .filter((row) => row.name === name && row.table_name === owner)
        .map((row) => ({
          value:
            name === PRISMA_INSIGHTS_MIGRATION_INDEX
              ? row.computed_definition
              : row.column_name,
          descending: row.is_descending_key,
        }));
      const indexRows = rows.filter(
        (row) => row.name === name && row.table_name === owner,
      );
      const first = indexRows[0];
      return {
        name,
        table: owner,
        unique:
          first === undefined ? undefined : isCatalogTrue(first.is_unique),
        healthy:
          first !== undefined &&
          isCatalogFalse(first.is_disabled) &&
          isCatalogFalse(first.has_filter) &&
          (name !== PRISMA_INSIGHTS_MIGRATION_INDEX ||
            (first.column_name ===
              "private_hot_updater_prisma_insights_migration_id" &&
              isCatalogTrue(first.is_persisted))),
        keys,
      };
    });
    const sourceIndexes = [
      ...groupCatalogRows(
        rows.filter((row) => row.table_name === PRISMA_INSIGHTS_EVENTS),
        (row) => row.name,
      ).entries(),
    ].map(([name, indexRows]) => {
      const first = indexRows[0];
      return {
        name,
        table: PRISMA_INSIGHTS_EVENTS,
        unique:
          first === undefined ? undefined : isCatalogTrue(first.is_unique),
        healthy:
          first !== undefined &&
          isCatalogFalse(first.is_disabled) &&
          isCatalogFalse(first.has_filter),
        keys: indexRows.map((row) => ({
          value: row.column_name,
          descending: row.is_descending_key,
        })),
      };
    });
    return (
      hasExpectedPrismaInsightsIndexLayout(provider, indexes) &&
      hasExpectedSourceGenerationIndex(provider, sourceIndexes)
    );
  }
  if (provider === "sqlite") {
    const requiredQueries = PRISMA_INSIGHTS_REQUIRED_INDEXES.map((name) => {
      const table = PRISMA_INSIGHTS_INDEX_TABLES[name]!;
      return `select required.name,required.table_name,
        list."unique" as is_unique,list.origin as origin,list.partial as partial,
        key.seqno as key_ordinal,
        key.name as column_name,key.desc as is_descending,
        (select sql from sqlite_master where type='index' and name=required.name
           and tbl_name=required.table_name) as index_sql
        from (select ${sql.value(name)} as name,${sql.value(table)} as table_name) required,
          pragma_index_list(required.table_name) list,
          pragma_index_xinfo(required.name) key
        where list.name=required.name and key.key=1`;
    });
    const sourceQuery = `select list.name as name,source.table_name,
      list."unique" as is_unique,list.origin as origin,list.partial as partial,
      key.seqno as key_ordinal,key.name as column_name,
      key.desc as is_descending,
      (select sql from sqlite_master where type='index' and name=list.name
         and tbl_name=source.table_name) as index_sql
      from (select ${sql.value(PRISMA_INSIGHTS_EVENTS)} as table_name) source,
        pragma_index_list(source.table_name) list,
        pragma_index_xinfo(list.name) key
      where list."unique"=1 and key.key=1`;
    const query = `select * from (${[...requiredQueries, sourceQuery].join(
      " union all ",
    )}) order by name,key_ordinal`;
    const rows = await queryPrismaInsights<
      {
        name: unknown;
        table_name: unknown;
        is_unique: unknown;
        origin: unknown;
        partial: unknown;
        key_ordinal: unknown;
        column_name: unknown;
        is_descending: unknown;
        index_sql: unknown;
      }[]
    >(client, sql.statement(query));
    const indexes = PRISMA_INSIGHTS_REQUIRED_INDEXES.map((name) => {
      const table = PRISMA_INSIGHTS_INDEX_TABLES[name]!;
      const indexRows = rows.filter(
        (row) => row.name === name && row.table_name === table,
      );
      const first = indexRows[0];
      const migrationSql =
        typeof first?.index_sql === "string" &&
        normalizeIndexKey(first.index_sql).includes(
          normalizeIndexKey(
            indexKeyValue(
              provider,
              PRISMA_INSIGHTS_REQUIRED_INDEX_LAYOUTS[name].keys[0]!,
            ),
          ),
        );
      return {
        name,
        table,
        unique:
          first === undefined ? undefined : isCatalogTrue(first.is_unique),
        healthy:
          first !== undefined &&
          first.origin === "c" &&
          isCatalogFalse(first.partial) &&
          (name !== PRISMA_INSIGHTS_MIGRATION_INDEX || migrationSql),
        keys: indexRows.map((row) => ({
          value:
            name === PRISMA_INSIGHTS_MIGRATION_INDEX &&
            row.column_name === null &&
            migrationSql
              ? indexKeyValue(
                  provider,
                  PRISMA_INSIGHTS_REQUIRED_INDEX_LAYOUTS[name].keys[0]!,
                )
              : row.column_name,
          descending: row.is_descending,
        })),
      };
    });
    const sourceIndexes = [
      ...groupCatalogRows(
        rows.filter((row) => row.table_name === PRISMA_INSIGHTS_EVENTS),
        (row) => row.name,
      ).entries(),
    ].map(([name, indexRows]) => {
      const first = indexRows[0];
      return {
        name,
        table: PRISMA_INSIGHTS_EVENTS,
        unique:
          first === undefined ? undefined : isCatalogTrue(first.is_unique),
        healthy:
          first !== undefined &&
          (first.origin === "u" || first.origin === "c") &&
          isCatalogFalse(first.partial),
        keys: indexRows.map((row) => ({
          value: row.column_name,
          descending: row.is_descending,
        })),
      };
    });
    return (
      hasExpectedPrismaInsightsIndexLayout(provider, indexes) &&
      hasExpectedSourceGenerationIndex(provider, sourceIndexes)
    );
  }
  const names = PRISMA_INSIGHTS_REQUIRED_INDEXES.map((name) => sql.value(name));
  const filter = `(${names.join(",")})`;
  if (provider === "postgresql") {
    const rows = await queryPrismaInsights<
      {
        name: unknown;
        table_name: unknown;
        is_unique: unknown;
        is_valid: unknown;
        is_ready: unknown;
        is_partial: unknown;
        key_ordinal: unknown;
        key_definition: unknown;
        index_definition: unknown;
        is_descending: unknown;
      }[]
    >(
      client,
      sql.statement(
        `select indexes.relname as name,tables.relname as table_name,
           metadata.indisunique as is_unique,metadata.indisvalid as is_valid,
           metadata.indisready as is_ready,(metadata.indpred is not null) as is_partial,
           keys.position as key_ordinal,
           pg_get_indexdef(metadata.indexrelid,keys.position,false) as key_definition,
           pg_get_indexdef(metadata.indexrelid) as index_definition,
           ((metadata.indoption[keys.position - 1] & 1) <> 0) as is_descending
         from pg_index metadata
         join pg_class indexes on indexes.oid=metadata.indexrelid
         join pg_class tables on tables.oid=metadata.indrelid
         join pg_namespace namespace on namespace.oid=tables.relnamespace
         cross join lateral generate_series(1,metadata.indnkeyatts) keys(position)
         where namespace.nspname=current_schema() and
           (indexes.relname in ${filter} or
             (tables.relname=${sql.value(PRISMA_INSIGHTS_EVENTS)}
               and metadata.indisunique))
         order by indexes.relname,keys.position`,
      ),
    );
    const indexes = PRISMA_INSIGHTS_REQUIRED_INDEXES.map((name) => {
      const table = PRISMA_INSIGHTS_INDEX_TABLES[name]!;
      const indexRows = rows.filter(
        (row) => row.name === name && row.table_name === table,
      );
      const first = indexRows[0];
      const migrationExpression =
        typeof first?.index_definition === "string" &&
        normalizeIndexKey(first.index_definition).includes(
          normalizeIndexKey(
            indexKeyValue(
              provider,
              PRISMA_INSIGHTS_REQUIRED_INDEX_LAYOUTS[name].keys[0]!,
            ),
          ),
        );
      return {
        name,
        table,
        unique:
          first === undefined ? undefined : isCatalogTrue(first.is_unique),
        healthy:
          first !== undefined &&
          isCatalogTrue(first.is_valid) &&
          isCatalogTrue(first.is_ready) &&
          isCatalogFalse(first.is_partial) &&
          (name !== PRISMA_INSIGHTS_MIGRATION_INDEX || migrationExpression),
        keys: indexRows.map((row) => ({
          value:
            name === PRISMA_INSIGHTS_MIGRATION_INDEX && migrationExpression
              ? indexKeyValue(
                  provider,
                  PRISMA_INSIGHTS_REQUIRED_INDEX_LAYOUTS[name].keys[0]!,
                )
              : postgresIndexKey(row.key_definition),
          descending: row.is_descending,
        })),
      };
    });
    const sourceIndexes = [
      ...groupCatalogRows(
        rows.filter((row) => row.table_name === PRISMA_INSIGHTS_EVENTS),
        (row) => row.name,
      ).entries(),
    ].map(([name, indexRows]) => {
      const first = indexRows[0];
      return {
        name,
        table: PRISMA_INSIGHTS_EVENTS,
        unique:
          first === undefined ? undefined : isCatalogTrue(first.is_unique),
        healthy:
          first !== undefined &&
          isCatalogTrue(first.is_valid) &&
          isCatalogTrue(first.is_ready) &&
          isCatalogFalse(first.is_partial),
        keys: indexRows.map((row) => ({
          value: postgresIndexKey(row.key_definition),
          descending: row.is_descending,
        })),
      };
    });
    return (
      hasExpectedPrismaInsightsIndexLayout(provider, indexes) &&
      hasExpectedSourceGenerationIndex(provider, sourceIndexes)
    );
  }
  if (provider === "cockroachdb") {
    const rows = await queryPrismaInsights<
      {
        name: unknown;
        table_name: unknown;
        non_unique: unknown;
        key_ordinal: unknown;
        column_name: unknown;
        direction: unknown;
        implicit: unknown;
        storing: unknown;
      }[]
    >(
      client,
      sql.statement(
        `select index_name as name,table_name as table_name,non_unique as non_unique,
           seq_in_index as key_ordinal,column_name as column_name,
           direction as direction,implicit as implicit,storing as storing
         from information_schema.statistics
         where table_schema=current_schema() and
           (index_name in ${filter} or
             (table_name=${sql.value(PRISMA_INSIGHTS_EVENTS)}
               and non_unique='NO'))
         order by index_name,seq_in_index`,
      ),
    );
    const migrationStatement = await queryPrismaInsights<
      { create_statement: unknown }[]
    >(
      client,
      new PrismaInsightsSql(provider).statement(
        "select create_statement from [show create table bundle_events]",
      ),
    );
    const normalizedMigrationStatement =
      typeof migrationStatement[0]?.create_statement === "string"
        ? normalizeIndexKey(migrationStatement[0].create_statement)
        : "";
    const migrationColumn = normalizeIndexKey(
      `${PRISMA_INSIGHTS_MIGRATION_COLUMN} bytes null as (id::string::bytes) stored`,
    );
    const migrationExpression =
      normalizedMigrationStatement.includes(migrationColumn);
    const indexes = PRISMA_INSIGHTS_REQUIRED_INDEXES.map((name) => {
      const table = PRISMA_INSIGHTS_INDEX_TABLES[name]!;
      const indexRows = rows.filter(
        (row) => row.name === name && row.table_name === table,
      );
      const explicitKeyRows = indexRows.filter(
        (row) => row.implicit === "NO" && row.storing === "NO",
      );
      const first = indexRows[0];
      return {
        name,
        table,
        unique:
          first === undefined ? undefined : isCatalogFalse(first.non_unique),
        healthy:
          first !== undefined &&
          explicitKeyRows.length > 0 &&
          (name !== PRISMA_INSIGHTS_MIGRATION_INDEX || migrationExpression),
        keys: explicitKeyRows.map((row) => ({
          value: row.column_name,
          descending: row.direction === "DESC",
        })),
      };
    });
    const sourceIndexes = [
      ...groupCatalogRows(
        rows.filter((row) => row.table_name === PRISMA_INSIGHTS_EVENTS),
        (row) => row.name,
      ).entries(),
    ].map(([name, indexRows]) => {
      const explicitKeyRows = indexRows.filter(
        (row) => row.implicit === "NO" && row.storing === "NO",
      );
      const first = indexRows[0];
      return {
        name,
        table: PRISMA_INSIGHTS_EVENTS,
        unique:
          first === undefined ? undefined : isCatalogFalse(first.non_unique),
        healthy: first !== undefined && explicitKeyRows.length > 0,
        keys: explicitKeyRows.map((row) => ({
          value: row.column_name,
          descending: row.direction === "DESC",
        })),
      };
    });
    return (
      hasExpectedPrismaInsightsIndexLayout(provider, indexes) &&
      hasExpectedSourceGenerationIndex(provider, sourceIndexes)
    );
  }
  const rows = await queryPrismaInsights<
    {
      name: unknown;
      table_name: unknown;
      non_unique: unknown;
      key_ordinal: unknown;
      column_name: unknown;
      expression: unknown;
      collation: unknown;
      sub_part: unknown;
    }[]
  >(
    client,
    sql.statement(
      `select index_name as name,table_name as table_name,non_unique as non_unique,
         seq_in_index as key_ordinal,column_name as column_name,
         expression as expression,collation as collation,sub_part as sub_part
       from information_schema.statistics
       where table_schema=database() and
         (index_name in ${filter} or
           (table_name=${sql.value(PRISMA_INSIGHTS_EVENTS)} and non_unique=0))
       order by index_name,seq_in_index`,
    ),
  );
  const indexes = PRISMA_INSIGHTS_REQUIRED_INDEXES.map((name) => {
    const table = PRISMA_INSIGHTS_INDEX_TABLES[name]!;
    const indexRows = rows.filter(
      (row) => row.name === name && row.table_name === table,
    );
    const first = indexRows[0];
    return {
      name,
      table,
      unique:
        first === undefined ? undefined : isCatalogFalse(first.non_unique),
      healthy:
        first !== undefined &&
        indexRows.every(
          (row) => row.sub_part === null || row.sub_part === undefined,
        ),
      keys: indexRows.map((row) => ({
        value: row.expression ?? row.column_name,
        descending: row.collation === "D",
      })),
    };
  });
  const sourceIndexes = [
    ...groupCatalogRows(
      rows.filter((row) => row.table_name === PRISMA_INSIGHTS_EVENTS),
      (row) => row.name,
    ).entries(),
  ].map(([name, indexRows]) => {
    const first = indexRows[0];
    return {
      name,
      table: PRISMA_INSIGHTS_EVENTS,
      unique:
        first === undefined ? undefined : isCatalogFalse(first.non_unique),
      healthy:
        first !== undefined &&
        indexRows.every(
          (row) => row.sub_part === null || row.sub_part === undefined,
        ),
      keys: indexRows.map((row) => ({
        value: row.expression ?? row.column_name,
        descending: row.collation === "D",
      })),
    };
  });
  if (
    !hasExpectedPrismaInsightsIndexLayout(provider, indexes) ||
    !hasExpectedSourceGenerationIndex(provider, sourceIndexes)
  )
    return false;
  if (provider !== "mysql") return true;
  const requiredTables = new Set([
    "bundle_events",
    PRISMA_INSIGHTS_MYSQL_DDL,
    PRISMA_INSIGHTS_STATE,
    PRISMA_INSIGHTS_SOURCE,
    PRISMA_INSIGHTS_EVENTS,
    PRISMA_INSIGHTS_LIVE,
    PRISMA_INSIGHTS_ALIASES,
    PRISMA_INSIGHTS_SEARCH_HEADS,
    PRISMA_INSIGHTS_SEARCH_JOBS,
    PRISMA_INSIGHTS_SEARCH_ROWS,
    PRISMA_INSIGHTS_REPORT_HEADS,
    PRISMA_INSIGHTS_REPORT_JOBS,
    PRISMA_INSIGHTS_REPORT_MEMBERS,
    PRISMA_INSIGHTS_REPORT_LATEST,
    PRISMA_INSIGHTS_REPORT_COUNTS,
    PRISMA_INSIGHTS_REPORT_ORDER,
    PRISMA_INSIGHTS_REPORT_SORT,
    PRISMA_INSIGHTS_REPORT_SEALS,
  ]);
  const engines = await client.$queryRawUnsafe<
    { table_name: unknown; engine: unknown }[]
  >(
    `select table_name as table_name,engine as engine from information_schema.tables
     where table_schema=database()`,
  );
  const innoDbTables = new Set(
    engines.flatMap((row) =>
      typeof row.table_name === "string" && row.engine === "InnoDB"
        ? [row.table_name]
        : [],
    ),
  );
  return [...requiredTables].every((table) => innoDbTables.has(table));
};
