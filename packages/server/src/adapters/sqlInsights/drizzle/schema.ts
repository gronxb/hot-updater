import {
  createUUIDv7,
  InsightsQueryNotReadyError,
} from "@hot-updater/plugin-core";
import { sql } from "drizzle-orm";

import type { DrizzleProvider } from "../../drizzle";
import {
  mutateDrizzleInsights,
  queryDrizzleInsights,
  type DrizzleDB,
} from "../../drizzleLazyDB";

export const DRIZZLE_INSIGHTS_STATE =
  "private_hot_updater_drizzle_insights_state";
export const DRIZZLE_INSIGHTS_EVENTS =
  "private_hot_updater_drizzle_insights_events";
export const DRIZZLE_INSIGHTS_LIVE =
  "private_hot_updater_drizzle_insights_live";
export const DRIZZLE_INSIGHTS_JOBS =
  "private_hot_updater_drizzle_insights_jobs";
export const DRIZZLE_INSIGHTS_SEARCH_RESULTS =
  "private_hot_updater_drizzle_insights_search_results";
export const DRIZZLE_INSIGHTS_REPORT_DISTINCT =
  "private_hot_updater_drizzle_insights_report_distinct";
export const DRIZZLE_INSIGHTS_REPORT_LATEST =
  "private_hot_updater_drizzle_insights_report_latest";
export const DRIZZLE_INSIGHTS_REPORT_OUTPUT =
  "private_hot_updater_drizzle_insights_report_output";

const sqliteDDL = [
  `create index if not exists drizzle_insights_legacy_id_bytes_idx
    on bundle_events(cast(id as blob))`,
  `create table if not exists ${DRIZZLE_INSIGHTS_STATE} (
    id integer primary key check (id = 1), revision integer not null,
    source_id text not null, status text not null, upper_id text,
    after_id text, error text, committed_seq integer not null,
    updated_at_ms integer not null, check (revision = 1),
    check (status in ('new','preparing','ready','failed'))
  )`,
  `create table if not exists ${DRIZZLE_INSIGHTS_EVENTS} (
    seq integer primary key autoincrement, event_id text not null unique,
    event_order_key blob not null, received_at_ms integer not null,
    event_type text not null,
    install_id text not null, install_key text not null,
    user_alias text, username_alias text, from_bundle_id text,
    from_bundle_key text, to_bundle_id text not null,
    to_bundle_key text not null, raw_event text not null
  )`,
  `create index if not exists drizzle_insights_events_order_idx on ${DRIZZLE_INSIGHTS_EVENTS}
    (received_at_ms desc, event_order_key desc, seq)`,
  `create index if not exists drizzle_insights_events_install_idx on ${DRIZZLE_INSIGHTS_EVENTS}
    (install_key, event_type, received_at_ms desc, event_order_key desc, seq)`,
  `create index if not exists drizzle_insights_events_to_bundle_idx on ${DRIZZLE_INSIGHTS_EVENTS}
    (to_bundle_key, event_type, received_at_ms desc, event_order_key desc, seq)`,
  `create index if not exists drizzle_insights_events_from_bundle_idx on ${DRIZZLE_INSIGHTS_EVENTS}
    (from_bundle_key, event_type, received_at_ms desc, event_order_key desc, seq)`,
  `create index if not exists drizzle_insights_events_live_idx on ${DRIZZLE_INSIGHTS_EVENTS}
    (install_key, received_at_ms desc, event_order_key desc, seq)`,
  `create table if not exists ${DRIZZLE_INSIGHTS_LIVE} (
    install_key text primary key, install_id text not null,
    event_id text not null, event_order_key blob not null,
    received_at_ms integer not null,
    raw_event text not null
  )`,
  `create table if not exists ${DRIZZLE_INSIGHTS_JOBS} (
    job_id text primary key, job_order_key blob not null,
    job_kind text not null, semantic_key text not null,
    reservation_key text not null unique, query_json text not null,
    source_id text not null, source_max_seq integer not null,
    cursor_seq integer not null, phase text not null,
    phase_section text not null, phase_key text not null,
    status text not null, as_of_ms integer not null,
    completed_at_ms integer, total integer, error text
  )`,
  `create index if not exists drizzle_insights_jobs_semantic_idx on ${DRIZZLE_INSIGHTS_JOBS}
    (job_kind,semantic_key,as_of_ms desc,job_order_key desc)`,
  `create index if not exists drizzle_insights_jobs_status_idx on ${DRIZZLE_INSIGHTS_JOBS}
    (job_kind,semantic_key,status,as_of_ms desc,job_order_key desc)`,
  `create index if not exists drizzle_insights_jobs_source_idx on ${DRIZZLE_INSIGHTS_JOBS}
    (job_kind,semantic_key,source_id,as_of_ms desc,job_order_key desc)`,
  `create index if not exists drizzle_insights_jobs_source_status_idx on ${DRIZZLE_INSIGHTS_JOBS}
    (job_kind,semantic_key,source_id,status,as_of_ms desc,job_order_key desc)`,
  `create table if not exists ${DRIZZLE_INSIGHTS_SEARCH_RESULTS} (
    job_id text not null, install_key text not null, install_id text not null,
    matched integer not null,
    event_id text not null, event_order_key blob not null,
    received_at_ms integer not null, raw_event text not null,
    primary key(job_id, install_key)
  )`,
  `create index if not exists drizzle_insights_search_matched_idx on ${DRIZZLE_INSIGHTS_SEARCH_RESULTS}
    (job_id,matched,install_key)`,
  `create table if not exists ${DRIZZLE_INSIGHTS_REPORT_DISTINCT} (
    job_id text not null, section text not null, entry_key text not null,
    key1 text not null,
    key2 text not null, key2_digest text not null,
    key3 text not null, key3_digest text not null, bucket_ms integer not null,
    received_at_ms integer, event_order_key blob,
    primary key(job_id, section, entry_key)
  )`,
  `create index if not exists drizzle_insights_distinct_active_idx on ${DRIZZLE_INSIGHTS_REPORT_DISTINCT}
    (job_id,section,key2_digest,bucket_ms,key3_digest)`,
  `create table if not exists ${DRIZZLE_INSIGHTS_REPORT_LATEST} (
    job_id text not null, install_key text not null, install_id text not null,
    event_id text not null, event_order_key blob not null,
    received_at_ms integer not null, raw_event text not null,
    user_id text, user_key text, to_bundle_id text not null,
    primary key(job_id, install_key)
  )`,
  `create index if not exists drizzle_insights_latest_identity_idx on ${DRIZZLE_INSIGHTS_REPORT_LATEST}
    (job_id,user_key,install_key)`,
  `create table if not exists ${DRIZZLE_INSIGHTS_REPORT_OUTPUT} (
    job_id text not null, section_key text not null, row_key text not null,
    sort_number integer not null, sort_text blob not null,
    row_json text not null, value integer not null, page_ordinal integer,
    primary key(job_id, section_key, row_key)
  )`,
  `create index if not exists drizzle_insights_output_text_idx on ${DRIZZLE_INSIGHTS_REPORT_OUTPUT}
    (job_id,section_key,sort_text,row_key)`,
  `create index if not exists drizzle_insights_output_value_idx on ${DRIZZLE_INSIGHTS_REPORT_OUTPUT}
    (job_id,section_key,value desc,sort_text,row_key)`,
  `create index if not exists drizzle_insights_output_page_idx on ${DRIZZLE_INSIGHTS_REPORT_OUTPUT}
    (job_id,section_key,page_ordinal)`,
  `create index if not exists drizzle_insights_output_pending_text_idx on ${DRIZZLE_INSIGHTS_REPORT_OUTPUT}
    (job_id,section_key,page_ordinal,sort_text,row_key)`,
  `create index if not exists drizzle_insights_output_pending_value_idx on ${DRIZZLE_INSIGHTS_REPORT_OUTPUT}
    (job_id,section_key,page_ordinal,value desc,sort_text,row_key)`,
];

const postgresDDL = sqliteDDL.map((statement) =>
  statement
    .replace("on bundle_events(cast(id as blob))", "on bundle_events(id)")
    .replace(
      "seq integer primary key autoincrement",
      "seq bigserial primary key",
    )
    .replaceAll("integer", "bigint")
    .replaceAll("blob", "bytea")
    .replace("status text", "status varchar(32)")
    .replace("job_kind text", "job_kind varchar(32)"),
);

const mysqlDDL = [
  `create table if not exists ${DRIZZLE_INSIGHTS_STATE} (
    id int primary key check (id=1), revision int not null check (revision=1),
    source_id varchar(36) not null,
    status varchar(32) not null, upper_id varchar(36), after_id varchar(36),
    error text, committed_seq bigint not null, updated_at_ms bigint not null,
    check (status in ('new','preparing','ready','failed'))
  )`,
  `create table if not exists ${DRIZZLE_INSIGHTS_EVENTS} (
    seq bigint not null auto_increment primary key, event_id varchar(36) not null unique,
    event_order_key binary(16) not null, received_at_ms bigint not null,
    event_type varchar(32) not null,
    install_id varchar(1024) not null, install_key char(64) not null,
    user_alias varchar(1024), username_alias varchar(1024),
    from_bundle_id varchar(1024), from_bundle_key char(64),
    to_bundle_id varchar(1024) not null, to_bundle_key char(64) not null,
    raw_event mediumtext not null,
    key drizzle_insights_events_order_idx(received_at_ms desc,event_order_key desc,seq),
    key drizzle_insights_events_install_idx(install_key,event_type,received_at_ms desc,event_order_key desc,seq),
    key drizzle_insights_events_to_bundle_idx(to_bundle_key,event_type,received_at_ms desc,event_order_key desc,seq),
    key drizzle_insights_events_from_bundle_idx(from_bundle_key,event_type,received_at_ms desc,event_order_key desc,seq)
    ,key drizzle_insights_events_live_idx(install_key,received_at_ms desc,event_order_key desc,seq)
  )`,
  `create table if not exists ${DRIZZLE_INSIGHTS_LIVE} (
    install_key char(64) primary key, install_id varchar(1024) not null,
    event_id varchar(36) not null, event_order_key binary(16) not null,
    received_at_ms bigint not null,
    raw_event mediumtext not null
  )`,
  `create table if not exists ${DRIZZLE_INSIGHTS_JOBS} (
    job_id varchar(36) primary key, job_order_key binary(16) not null,
    job_kind varchar(32) not null,
    semantic_key varchar(64) not null, reservation_key char(64) not null unique,
    query_json mediumtext not null,
    source_id varchar(36) not null, source_max_seq bigint not null,
    cursor_seq bigint not null, phase varchar(32) not null,
    phase_section varchar(32) not null, phase_key char(64) not null,
    status varchar(32) not null, as_of_ms bigint not null,
    completed_at_ms bigint, total bigint, error text,
    key drizzle_insights_jobs_semantic_idx(job_kind,semantic_key,as_of_ms desc,job_order_key desc),
    key drizzle_insights_jobs_status_idx(job_kind,semantic_key,status,as_of_ms desc,job_order_key desc),
    key drizzle_insights_jobs_source_idx(job_kind,semantic_key,source_id,as_of_ms desc,job_order_key desc),
    key drizzle_insights_jobs_source_status_idx(job_kind,semantic_key,source_id,status,as_of_ms desc,job_order_key desc)
  )`,
  `create table if not exists ${DRIZZLE_INSIGHTS_SEARCH_RESULTS} (
    job_id varchar(36) not null, install_key char(64) not null,
    install_id varchar(1024) not null, matched tinyint not null,
    event_id varchar(36) not null,
    event_order_key binary(16) not null,
    received_at_ms bigint not null, raw_event mediumtext not null,
    primary key(job_id,install_key),
    key drizzle_insights_search_matched_idx(job_id,matched,install_key)
  )`,
  `create table if not exists ${DRIZZLE_INSIGHTS_REPORT_DISTINCT} (
    job_id varchar(36) not null, section varchar(32) not null,
    entry_key char(64) not null,
    key1 varchar(1024) not null, key2 varchar(1024) not null,
    key2_digest char(64) not null, key3 varchar(1024) not null,
    key3_digest char(64) not null, bucket_ms bigint not null,
    received_at_ms bigint, event_order_key binary(16),
    primary key(job_id,section,entry_key),
    key drizzle_insights_distinct_active_idx(job_id,section,key2_digest,bucket_ms,key3_digest)
  )`,
  `create table if not exists ${DRIZZLE_INSIGHTS_REPORT_LATEST} (
    job_id varchar(36) not null, install_key char(64) not null,
    install_id varchar(1024) not null, event_id varchar(36) not null,
    event_order_key binary(16) not null,
    received_at_ms bigint not null, raw_event mediumtext not null,
    user_id varchar(1024), user_key char(64),
    to_bundle_id varchar(1024) not null,
    primary key(job_id,install_key),
    key drizzle_insights_latest_identity_idx(job_id,user_key,install_key)
  )`,
  `create table if not exists ${DRIZZLE_INSIGHTS_REPORT_OUTPUT} (
    job_id char(36) character set ascii not null,
    section_key varchar(128) character set ascii not null,
    row_key varchar(64) character set ascii not null,
    sort_number bigint not null, sort_text varbinary(2048) not null,
    row_json mediumtext not null, value bigint not null, page_ordinal bigint,
    primary key(job_id,section_key,row_key),
    key drizzle_insights_output_text_idx(job_id,section_key,sort_text,row_key),
    key drizzle_insights_output_value_idx(job_id,section_key,value desc,sort_text,row_key),
    key drizzle_insights_output_page_idx(job_id,section_key,page_ordinal),
    key drizzle_insights_output_pending_text_idx(job_id,section_key,page_ordinal,sort_text,row_key),
    key drizzle_insights_output_pending_value_idx(job_id,section_key,page_ordinal,value desc,sort_text,row_key)
  )`,
];

const ddl = (provider: DrizzleProvider): readonly string[] =>
  provider === "sqlite"
    ? sqliteDDL
    : provider === "mysql"
      ? mysqlDDL
      : postgresDDL;

type IndexColumn = {
  readonly value: string;
  readonly direction?: "desc";
};

const requiredIndexes: Readonly<
  Record<
    string,
    { readonly table: string; readonly columns: readonly IndexColumn[] }
  >
> = {
  drizzle_insights_legacy_id_bytes_idx: {
    table: "bundle_events",
    columns: [{ value: "id" }],
  },
  drizzle_insights_events_order_idx: {
    table: DRIZZLE_INSIGHTS_EVENTS,
    columns: [
      { value: "received_at_ms", direction: "desc" },
      { value: "event_order_key", direction: "desc" },
      { value: "seq" },
    ],
  },
  drizzle_insights_events_install_idx: {
    table: DRIZZLE_INSIGHTS_EVENTS,
    columns: [
      { value: "install_key" },
      { value: "event_type" },
      { value: "received_at_ms", direction: "desc" },
      { value: "event_order_key", direction: "desc" },
      { value: "seq" },
    ],
  },
  drizzle_insights_events_to_bundle_idx: {
    table: DRIZZLE_INSIGHTS_EVENTS,
    columns: [
      { value: "to_bundle_key" },
      { value: "event_type" },
      { value: "received_at_ms", direction: "desc" },
      { value: "event_order_key", direction: "desc" },
      { value: "seq" },
    ],
  },
  drizzle_insights_events_from_bundle_idx: {
    table: DRIZZLE_INSIGHTS_EVENTS,
    columns: [
      { value: "from_bundle_key" },
      { value: "event_type" },
      { value: "received_at_ms", direction: "desc" },
      { value: "event_order_key", direction: "desc" },
      { value: "seq" },
    ],
  },
  drizzle_insights_events_live_idx: {
    table: DRIZZLE_INSIGHTS_EVENTS,
    columns: [
      { value: "install_key" },
      { value: "received_at_ms", direction: "desc" },
      { value: "event_order_key", direction: "desc" },
      { value: "seq" },
    ],
  },
  drizzle_insights_output_text_idx: {
    table: DRIZZLE_INSIGHTS_REPORT_OUTPUT,
    columns: [
      { value: "job_id" },
      { value: "section_key" },
      { value: "sort_text" },
      { value: "row_key" },
    ],
  },
  drizzle_insights_output_value_idx: {
    table: DRIZZLE_INSIGHTS_REPORT_OUTPUT,
    columns: [
      { value: "job_id" },
      { value: "section_key" },
      { value: "value", direction: "desc" },
      { value: "sort_text" },
      { value: "row_key" },
    ],
  },
  drizzle_insights_output_page_idx: {
    table: DRIZZLE_INSIGHTS_REPORT_OUTPUT,
    columns: [
      { value: "job_id" },
      { value: "section_key" },
      { value: "page_ordinal" },
    ],
  },
  drizzle_insights_output_pending_text_idx: {
    table: DRIZZLE_INSIGHTS_REPORT_OUTPUT,
    columns: [
      { value: "job_id" },
      { value: "section_key" },
      { value: "page_ordinal" },
      { value: "sort_text" },
      { value: "row_key" },
    ],
  },
  drizzle_insights_output_pending_value_idx: {
    table: DRIZZLE_INSIGHTS_REPORT_OUTPUT,
    columns: [
      { value: "job_id" },
      { value: "section_key" },
      { value: "page_ordinal" },
      { value: "value", direction: "desc" },
      { value: "sort_text" },
      { value: "row_key" },
    ],
  },
  drizzle_insights_distinct_active_idx: {
    table: DRIZZLE_INSIGHTS_REPORT_DISTINCT,
    columns: [
      { value: "job_id" },
      { value: "section" },
      { value: "key2_digest" },
      { value: "bucket_ms" },
      { value: "key3_digest" },
    ],
  },
  drizzle_insights_latest_identity_idx: {
    table: DRIZZLE_INSIGHTS_REPORT_LATEST,
    columns: [
      { value: "job_id" },
      { value: "user_key" },
      { value: "install_key" },
    ],
  },
  drizzle_insights_jobs_semantic_idx: {
    table: DRIZZLE_INSIGHTS_JOBS,
    columns: [
      { value: "job_kind" },
      { value: "semantic_key" },
      { value: "as_of_ms", direction: "desc" },
      { value: "job_order_key", direction: "desc" },
    ],
  },
  drizzle_insights_jobs_status_idx: {
    table: DRIZZLE_INSIGHTS_JOBS,
    columns: [
      { value: "job_kind" },
      { value: "semantic_key" },
      { value: "status" },
      { value: "as_of_ms", direction: "desc" },
      { value: "job_order_key", direction: "desc" },
    ],
  },
  drizzle_insights_jobs_source_idx: {
    table: DRIZZLE_INSIGHTS_JOBS,
    columns: [
      { value: "job_kind" },
      { value: "semantic_key" },
      { value: "source_id" },
      { value: "as_of_ms", direction: "desc" },
      { value: "job_order_key", direction: "desc" },
    ],
  },
  drizzle_insights_jobs_source_status_idx: {
    table: DRIZZLE_INSIGHTS_JOBS,
    columns: [
      { value: "job_kind" },
      { value: "semantic_key" },
      { value: "source_id" },
      { value: "status" },
      { value: "as_of_ms", direction: "desc" },
      { value: "job_order_key", direction: "desc" },
    ],
  },
  drizzle_insights_search_matched_idx: {
    table: DRIZZLE_INSIGHTS_SEARCH_RESULTS,
    columns: [
      { value: "job_id" },
      { value: "matched" },
      { value: "install_key" },
    ],
  },
};

type ColumnShape = {
  readonly name: string;
  readonly postgresql: string;
  readonly mysql: string;
  readonly nullable?: true;
  readonly postgresLength?: number;
  readonly mysqlCharset?: "ascii";
  readonly generated?: true;
};

const column = (
  name: string,
  postgresql: string,
  mysql: string,
  options: Omit<ColumnShape, "name" | "postgresql" | "mysql"> = {},
): ColumnShape => ({ name, postgresql, mysql, ...options });
const textColumn = (
  name: string,
  mysql = "varchar(1024)",
  options: Omit<ColumnShape, "name" | "postgresql" | "mysql"> = {},
) => column(name, "text", mysql, options);
const numberColumn = (
  name: string,
  mysql = "bigint",
  options: Omit<ColumnShape, "name" | "postgresql" | "mysql"> = {},
) => column(name, "int8", mysql, options);
const binaryColumn = (
  name: string,
  mysql = "binary(16)",
  options: Omit<ColumnShape, "name" | "postgresql" | "mysql"> = {},
) => column(name, "bytea", mysql, options);

const requiredTables: Readonly<Record<string, readonly ColumnShape[]>> = {
  [DRIZZLE_INSIGHTS_STATE]: [
    numberColumn("id", "int"),
    numberColumn("revision", "int"),
    textColumn("source_id", "varchar(36)"),
    column("status", "varchar", "varchar(32)", { postgresLength: 32 }),
    textColumn("upper_id", "varchar(36)", { nullable: true }),
    textColumn("after_id", "varchar(36)", { nullable: true }),
    textColumn("error", "text", { nullable: true }),
    numberColumn("committed_seq"),
    numberColumn("updated_at_ms"),
  ],
  [DRIZZLE_INSIGHTS_EVENTS]: [
    numberColumn("seq", "bigint", { generated: true }),
    textColumn("event_id", "varchar(36)"),
    binaryColumn("event_order_key"),
    numberColumn("received_at_ms"),
    textColumn("event_type", "varchar(32)"),
    textColumn("install_id"),
    textColumn("install_key", "char(64)"),
    textColumn("user_alias", "varchar(1024)", { nullable: true }),
    textColumn("username_alias", "varchar(1024)", { nullable: true }),
    textColumn("from_bundle_id", "varchar(1024)", { nullable: true }),
    textColumn("from_bundle_key", "char(64)", { nullable: true }),
    textColumn("to_bundle_id"),
    textColumn("to_bundle_key", "char(64)"),
    textColumn("raw_event", "mediumtext"),
  ],
  [DRIZZLE_INSIGHTS_LIVE]: [
    textColumn("install_key", "char(64)"),
    textColumn("install_id"),
    textColumn("event_id", "varchar(36)"),
    binaryColumn("event_order_key"),
    numberColumn("received_at_ms"),
    textColumn("raw_event", "mediumtext"),
  ],
  [DRIZZLE_INSIGHTS_JOBS]: [
    textColumn("job_id", "varchar(36)"),
    binaryColumn("job_order_key"),
    column("job_kind", "varchar", "varchar(32)", { postgresLength: 32 }),
    textColumn("semantic_key", "varchar(64)"),
    textColumn("reservation_key", "char(64)"),
    textColumn("query_json", "mediumtext"),
    textColumn("source_id", "varchar(36)"),
    numberColumn("source_max_seq"),
    numberColumn("cursor_seq"),
    textColumn("phase", "varchar(32)"),
    textColumn("phase_section", "varchar(32)"),
    textColumn("phase_key", "char(64)"),
    column("status", "varchar", "varchar(32)", { postgresLength: 32 }),
    numberColumn("as_of_ms"),
    numberColumn("completed_at_ms", "bigint", { nullable: true }),
    numberColumn("total", "bigint", { nullable: true }),
    textColumn("error", "text", { nullable: true }),
  ],
  [DRIZZLE_INSIGHTS_SEARCH_RESULTS]: [
    textColumn("job_id", "varchar(36)"),
    textColumn("install_key", "char(64)"),
    textColumn("install_id"),
    numberColumn("matched", "tinyint"),
    textColumn("event_id", "varchar(36)"),
    binaryColumn("event_order_key"),
    numberColumn("received_at_ms"),
    textColumn("raw_event", "mediumtext"),
  ],
  [DRIZZLE_INSIGHTS_REPORT_DISTINCT]: [
    textColumn("job_id", "varchar(36)"),
    textColumn("section", "varchar(32)"),
    textColumn("entry_key", "char(64)"),
    textColumn("key1"),
    textColumn("key2"),
    textColumn("key2_digest", "char(64)"),
    textColumn("key3"),
    textColumn("key3_digest", "char(64)"),
    numberColumn("bucket_ms"),
    numberColumn("received_at_ms", "bigint", { nullable: true }),
    binaryColumn("event_order_key", "binary(16)", { nullable: true }),
  ],
  [DRIZZLE_INSIGHTS_REPORT_LATEST]: [
    textColumn("job_id", "varchar(36)"),
    textColumn("install_key", "char(64)"),
    textColumn("install_id"),
    textColumn("event_id", "varchar(36)"),
    binaryColumn("event_order_key"),
    numberColumn("received_at_ms"),
    textColumn("raw_event", "mediumtext"),
    textColumn("user_id", "varchar(1024)", { nullable: true }),
    textColumn("user_key", "char(64)", { nullable: true }),
    textColumn("to_bundle_id"),
  ],
  [DRIZZLE_INSIGHTS_REPORT_OUTPUT]: [
    textColumn("job_id", "char(36)", { mysqlCharset: "ascii" }),
    textColumn("section_key", "varchar(128)", { mysqlCharset: "ascii" }),
    textColumn("row_key", "varchar(64)", { mysqlCharset: "ascii" }),
    numberColumn("sort_number"),
    binaryColumn("sort_text", "varbinary(2048)"),
    textColumn("row_json", "mediumtext"),
    numberColumn("value"),
    numberColumn("page_ordinal", "bigint", { nullable: true }),
  ],
};

const requiredPrimaryKeys: Readonly<Record<string, readonly string[]>> = {
  [DRIZZLE_INSIGHTS_STATE]: ["id"],
  [DRIZZLE_INSIGHTS_EVENTS]: ["seq"],
  [DRIZZLE_INSIGHTS_LIVE]: ["install_key"],
  [DRIZZLE_INSIGHTS_JOBS]: ["job_id"],
  [DRIZZLE_INSIGHTS_SEARCH_RESULTS]: ["job_id", "install_key"],
  [DRIZZLE_INSIGHTS_REPORT_DISTINCT]: ["job_id", "section", "entry_key"],
  [DRIZZLE_INSIGHTS_REPORT_LATEST]: ["job_id", "install_key"],
  [DRIZZLE_INSIGHTS_REPORT_OUTPUT]: ["job_id", "section_key", "row_key"],
};

const requiredUniqueKeys: Readonly<Record<string, readonly string[][]>> = {
  [DRIZZLE_INSIGHTS_EVENTS]: [["event_id"]],
  [DRIZZLE_INSIGHTS_JOBS]: [["reservation_key"]],
};

const normalized = (value: unknown): string =>
  typeof value === "string"
    ? value.toLowerCase().replaceAll(/[\s`"']/g, "")
    : "";

const assertDrizzleInsightsTables = async (
  db: DrizzleDB,
  provider: DrizzleProvider,
): Promise<void> => {
  if (provider === "sqlite") {
    const rows = await queryDrizzleInsights<{
      name: unknown;
      definition: unknown;
    }>(
      db,
      sql`select name,sql definition from sqlite_master where type='table'
        and name like 'private_hot_updater_drizzle_insights_%'`,
    );
    const actual = new Map(
      rows.map((row) => [String(row.name), normalized(row.definition)]),
    );
    if (actual.size !== Object.keys(requiredTables).length) {
      throw new InsightsQueryNotReadyError();
    }
    for (const table of Object.keys(requiredTables)) {
      const statement = sqliteDDL.find((candidate) =>
        normalized(candidate).startsWith(`createtableifnotexists${table}`),
      );
      if (
        statement === undefined ||
        actual.get(table) !== normalized(statement).replace("ifnotexists", "")
      ) {
        throw new InsightsQueryNotReadyError();
      }
    }
    return;
  }
  const columns = await queryDrizzleInsights<{
    relation_name: unknown;
    field_name: unknown;
    ordinal: unknown;
    field_type: unknown;
    nullable_value: unknown;
    maximum_length: unknown;
    default_value: unknown;
    extra_value: unknown;
    charset_value: unknown;
  }>(
    db,
    provider === "postgresql"
      ? sql`select table_name relation_name,column_name field_name,
          ordinal_position ordinal,udt_name field_type,
          is_nullable nullable_value,character_maximum_length maximum_length,
          column_default default_value,null::text extra_value,
          null::text charset_value
        from information_schema.columns where table_schema=current_schema()
          and table_name like 'private_hot_updater_drizzle_insights_%'
        order by table_name,ordinal_position`
      : sql`select table_name relation_name,column_name field_name,
          ordinal_position ordinal,column_type field_type,
          is_nullable nullable_value,character_maximum_length maximum_length,
          column_default default_value,extra extra_value,
          character_set_name charset_value
        from information_schema.columns where table_schema=database()
          and table_name like 'private_hot_updater_drizzle_insights_%'
        order by table_name,ordinal_position`,
  );
  const actualTableNames = new Set(
    columns.map((row) => String(row.relation_name)),
  );
  if (
    actualTableNames.size !== Object.keys(requiredTables).length ||
    [...actualTableNames].some((table) => !(table in requiredTables))
  ) {
    throw new InsightsQueryNotReadyError();
  }
  for (const [table, expected] of Object.entries(requiredTables)) {
    const actual = columns.filter((row) => row.relation_name === table);
    if (
      actual.length !== expected.length ||
      actual.some((row, position) => {
        const shape = expected[position]!;
        const expectedType = shape[provider];
        return (
          row.field_name !== shape.name ||
          Number(row.ordinal) !== position + 1 ||
          normalized(row.field_type) !== normalized(expectedType) ||
          row.nullable_value !== (shape.nullable ? "YES" : "NO") ||
          (provider === "postgresql" &&
            (shape.postgresLength === undefined
              ? row.maximum_length !== null
              : Number(row.maximum_length) !== shape.postgresLength)) ||
          (provider === "postgresql" &&
            (shape.generated
              ? !normalized(row.default_value).includes("nextval(")
              : row.default_value !== null)) ||
          (provider === "mysql" &&
            (shape.generated
              ? normalized(row.extra_value) !== "auto_increment"
              : normalized(row.extra_value) !== "")) ||
          (provider === "mysql" &&
            shape.mysqlCharset !== undefined &&
            row.charset_value !== shape.mysqlCharset)
        );
      })
    ) {
      throw new InsightsQueryNotReadyError();
    }
  }
  const keys = await queryDrizzleInsights<{
    relation_name: unknown;
    constraint_name_value: unknown;
    constraint_kind: unknown;
    field_name: unknown;
    ordinal: unknown;
  }>(
    db,
    provider === "postgresql"
      ? sql`select constraints.table_name relation_name,
          constraints.constraint_name constraint_name_value,
          constraints.constraint_type constraint_kind,
          key_columns.column_name field_name,key_columns.ordinal_position ordinal
        from information_schema.table_constraints constraints
        join information_schema.key_column_usage key_columns
          on key_columns.constraint_schema=constraints.constraint_schema
          and key_columns.constraint_name=constraints.constraint_name
          and key_columns.table_name=constraints.table_name
        where constraints.table_schema=current_schema()
          and constraints.table_name like 'private_hot_updater_drizzle_insights_%'
          and constraints.constraint_type in ('PRIMARY KEY','UNIQUE')
        order by constraints.table_name,constraints.constraint_name,
          key_columns.ordinal_position`
      : sql`select constraints.table_name relation_name,
          constraints.constraint_name constraint_name_value,
          constraints.constraint_type constraint_kind,
          key_columns.column_name field_name,key_columns.ordinal_position ordinal
        from information_schema.table_constraints constraints
        join information_schema.key_column_usage key_columns
          on key_columns.constraint_schema=constraints.constraint_schema
          and key_columns.constraint_name=constraints.constraint_name
          and key_columns.table_name=constraints.table_name
        where constraints.table_schema=database()
          and constraints.table_name like 'private_hot_updater_drizzle_insights_%'
          and constraints.constraint_type in ('PRIMARY KEY','UNIQUE')
        order by constraints.table_name,constraints.constraint_name,
          key_columns.ordinal_position`,
  );
  const actualKeys = new Map<string, string[]>();
  for (const row of keys) {
    const key = `${String(row.relation_name)}:${String(row.constraint_kind)}:${String(row.constraint_name_value)}`;
    actualKeys.set(key, [
      ...(actualKeys.get(key) ?? []),
      String(row.field_name),
    ]);
  }
  const expectedKeys = new Set<string>();
  for (const [table, fields] of Object.entries(requiredPrimaryKeys)) {
    expectedKeys.add(`${table}:PRIMARY KEY:${fields.join(",")}`);
  }
  for (const [table, groups] of Object.entries(requiredUniqueKeys)) {
    for (const fields of groups) {
      expectedKeys.add(`${table}:UNIQUE:${fields.join(",")}`);
    }
  }
  const keyLayouts = new Set(
    [...actualKeys.entries()].map(([key, fields]) => {
      const [table, kind] = key.split(":");
      return `${table}:${kind}:${fields.join(",")}`;
    }),
  );
  if (
    keyLayouts.size !== expectedKeys.size ||
    [...expectedKeys].some((key) => !keyLayouts.has(key))
  ) {
    throw new InsightsQueryNotReadyError();
  }
  const checks = await queryDrizzleInsights<{ definition: unknown }>(
    db,
    provider === "postgresql"
      ? sql`select pg_get_constraintdef(constraints.oid) definition
        from pg_constraint constraints
        join pg_class tables on tables.oid=constraints.conrelid
        join pg_namespace namespace on namespace.oid=tables.relnamespace
        where namespace.nspname=current_schema()
          and tables.relname=${DRIZZLE_INSIGHTS_STATE}
          and constraints.contype='c'`
      : sql`select checks.check_clause definition
        from information_schema.table_constraints constraints
        join information_schema.check_constraints checks
          on checks.constraint_schema=constraints.constraint_schema
          and checks.constraint_name=constraints.constraint_name
        where constraints.table_schema=database()
          and constraints.table_name=${DRIZZLE_INSIGHTS_STATE}
          and constraints.constraint_type='CHECK'`,
  );
  const definitions = checks.map((row) => normalized(row.definition));
  if (
    definitions.length !== 3 ||
    !definitions.some((definition) => definition.includes("id=1")) ||
    !definitions.some((definition) => definition.includes("revision=1")) ||
    !definitions.some(
      (definition) =>
        definition.includes("status") &&
        ["new", "preparing", "ready", "failed"].every((status) =>
          definition.includes(status),
        ),
    )
  ) {
    throw new InsightsQueryNotReadyError();
  }
};

export const assertDrizzleInsightsIndexes = async (
  db: DrizzleDB,
  provider: DrizzleProvider,
): Promise<void> => {
  await assertDrizzleInsightsTables(db, provider);
  if (provider === "sqlite") {
    const rows = await queryDrizzleInsights<{
      name: unknown;
      table_name: unknown;
      definition: unknown;
    }>(
      db,
      sql`select name,tbl_name table_name,sql definition from sqlite_master
        where type='index' and name like 'drizzle_insights_%'`,
    );
    const actual = new Map(
      rows.map((row) => [
        String(row.name),
        {
          table: String(row.table_name),
          definition: normalized(row.definition).replace("ifnotexists", ""),
        },
      ]),
    );
    if (actual.size !== Object.keys(requiredIndexes).length) {
      throw new InsightsQueryNotReadyError();
    }
    for (const [name, expected] of Object.entries(requiredIndexes)) {
      const index = actual.get(name);
      const statement = sqliteDDL.find((candidate) => candidate.includes(name));
      if (
        index === undefined ||
        statement === undefined ||
        index.table !== expected.table ||
        index.definition !== normalized(statement).replace("ifnotexists", "")
      ) {
        throw new InsightsQueryNotReadyError();
      }
    }
    return;
  }
  if (provider === "postgresql") {
    const rows = await queryDrizzleInsights<{
      name: unknown;
      table_name: unknown;
      is_unique: unknown;
      is_valid: unknown;
      is_ready: unknown;
      predicate: unknown;
      position: unknown;
      expression: unknown;
      is_desc: unknown;
    }>(
      db,
      sql`select index_table.relname name,source_table.relname table_name,
          source_index.indisunique is_unique,
          source_index.indisvalid is_valid,
          source_index.indisready is_ready,
          pg_get_expr(source_index.indpred,source_index.indrelid) predicate,
          keys.position,pg_get_indexdef(source_index.indexrelid,keys.position,true) expression,
          (source_index.indoption[keys.position - 1] & 1) = 1 is_desc
        from pg_index source_index
        join pg_class index_table on index_table.oid=source_index.indexrelid
        join pg_class source_table on source_table.oid=source_index.indrelid
        join pg_namespace source_namespace on source_namespace.oid=source_table.relnamespace
        cross join lateral generate_series(1,source_index.indnkeyatts) keys(position)
        where source_namespace.nspname=current_schema()
          and index_table.relname like 'drizzle_insights_%'
        order by index_table.relname,keys.position`,
    );
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const name = String(row.name);
      grouped.set(name, [...(grouped.get(name) ?? []), row]);
    }
    if (grouped.size !== Object.keys(requiredIndexes).length) {
      throw new InsightsQueryNotReadyError();
    }
    for (const [name, expected] of Object.entries(requiredIndexes)) {
      const index = grouped.get(name);
      if (
        index === undefined ||
        index.length !== expected.columns.length ||
        index.some(
          (row) =>
            row.table_name !== expected.table ||
            row.is_unique !== false ||
            row.is_valid !== true ||
            row.is_ready !== true ||
            row.predicate !== null,
        ) ||
        index.some(
          (row, position) =>
            normalized(row.expression) !==
              normalized(expected.columns[position]!.value) ||
            Boolean(row.is_desc) !==
              (expected.columns[position]!.direction === "desc"),
        )
      ) {
        throw new InsightsQueryNotReadyError();
      }
    }
    return;
  }
  const rows = await queryDrizzleInsights<{
    name: unknown;
    source_table: unknown;
    is_non_unique: unknown;
    position: unknown;
    indexed_column: unknown;
    indexed_expression: unknown;
    prefix_length: unknown;
    index_collation: unknown;
    index_type_value: unknown;
    visible_value: unknown;
  }>(
    db,
    sql`select index_name name,table_name source_table,non_unique is_non_unique,
        seq_in_index position,column_name indexed_column,
        expression indexed_expression,sub_part prefix_length,
        collation index_collation,index_type index_type_value,
        is_visible visible_value
      from information_schema.statistics where table_schema=database()
        and index_name like 'drizzle_insights_%'
      order by index_name,seq_in_index`,
  );
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const name = String(row.name);
    grouped.set(name, [...(grouped.get(name) ?? []), row]);
  }
  if (grouped.size !== Object.keys(requiredIndexes).length) {
    throw new InsightsQueryNotReadyError();
  }
  for (const [name, expected] of Object.entries(requiredIndexes)) {
    const index = grouped.get(name);
    if (
      index === undefined ||
      index.length !== expected.columns.length ||
      index.some(
        (row) =>
          row.source_table !== expected.table ||
          Number(row.is_non_unique) !== 1 ||
          row.prefix_length !== null ||
          row.index_type_value !== "BTREE" ||
          row.visible_value !== "YES",
      ) ||
      index.some((row, position) => {
        const column = expected.columns[position]!;
        const expression =
          name === "drizzle_insights_legacy_id_bytes_idx"
            ? normalized(row.indexed_expression)
            : normalized(row.indexed_column);
        return (
          (name === "drizzle_insights_legacy_id_bytes_idx"
            ? expression !== "cast(idasbinary)" &&
              expression !== "cast(idascharcharsetbinary)"
            : expression !== normalized(column.value)) ||
          (column.direction === "desc"
            ? row.index_collation !== "D"
            : row.index_collation !== "A")
        );
      })
    ) {
      throw new InsightsQueryNotReadyError();
    }
  }
};

export const ensureDrizzleInsightsSchema = async (
  db: DrizzleDB,
  provider: DrizzleProvider,
): Promise<void> => {
  if (provider === "mysql") {
    const indexes = await queryDrizzleInsights<{ name: unknown }>(
      db,
      sql`select distinct index_name name from information_schema.statistics
        where table_schema=database() and table_name='bundle_events'
          and index_name='drizzle_insights_legacy_id_bytes_idx'`,
    );
    if (indexes.length === 0) {
      try {
        await mutateDrizzleInsights(
          db,
          sql.raw(`create index drizzle_insights_legacy_id_bytes_idx
            on bundle_events ((cast(id as binary)))`),
        );
      } catch (error) {
        const existing = await queryDrizzleInsights(
          db,
          sql`select index_name from information_schema.statistics
            where table_schema=database() and table_name='bundle_events'
              and index_name='drizzle_insights_legacy_id_bytes_idx' limit 1`,
        );
        if (existing.length === 0) throw error;
      }
    }
  }
  for (const statement of ddl(provider)) {
    await mutateDrizzleInsights(db, sql.raw(statement));
  }
  const rows = await queryDrizzleInsights<{ source_id: unknown }>(
    db,
    sql`select source_id from ${sql.identifier(DRIZZLE_INSIGHTS_STATE)} where id = 1`,
  );
  if (rows.length === 0) {
    const retained = await queryDrizzleInsights(
      db,
      sql`select id from ${sql.identifier("bundle_events")} limit 1`,
    );
    const initialStatus = retained.length === 0 ? "ready" : "new";
    await mutateDrizzleInsights(
      db,
      provider === "mysql"
        ? sql`insert ignore into ${sql.identifier(DRIZZLE_INSIGHTS_STATE)}
            (id,revision,source_id,status,upper_id,after_id,error,committed_seq,updated_at_ms)
            values (1,1,${createUUIDv7()},${initialStatus},null,null,null,0,${Date.now()})`
        : sql`insert into ${sql.identifier(DRIZZLE_INSIGHTS_STATE)}
            (id,revision,source_id,status,upper_id,after_id,error,committed_seq,updated_at_ms)
            values (1,1,${createUUIDv7()},${initialStatus},null,null,null,0,${Date.now()})
            on conflict(id) do nothing`,
    );
  }
};
