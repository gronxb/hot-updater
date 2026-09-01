import { sql, type QueryExecutorProvider } from "kysely";

import type { SQLProvider as KyselySQLProvider } from "../../kysely";
import { KYSELY_INSIGHTS_LAYOUT_REVISION, tables } from "./constants";
import { newOpaqueId } from "./utils";

const text = (provider: KyselySQLProvider): string =>
  provider === "mysql" ? "longtext" : "text";
const bool = (provider: KyselySQLProvider): string =>
  provider === "sqlite" ? "integer" : "boolean";
const asciiText = (provider: KyselySQLProvider, size: number): string =>
  provider === "mysql"
    ? `varchar(${size}) character set ascii collate ascii_bin`
    : provider === "sqlite"
      ? `text collate binary`
      : provider === "cockroachdb"
        ? `varchar(${size})`
        : `varchar(${size}) collate "C"`;
const identityText = (provider: KyselySQLProvider): string =>
  provider === "mysql"
    ? "varchar(1024) character set utf8mb4 collate utf8mb4_bin"
    : provider === "sqlite"
      ? "text collate binary"
      : provider === "cockroachdb"
        ? "varchar(1024)"
        : `varchar(1024) collate "C"`;
const jsonText = text;
const bytes = (provider: KyselySQLProvider, size: number): string =>
  provider === "mysql"
    ? `varbinary(${size})`
    : provider === "sqlite"
      ? "blob"
      : provider === "cockroachdb"
        ? "bytes"
        : "bytea";

export const getKyselyInsightsDDL = (
  provider: KyselySQLProvider,
): readonly string[] => {
  const large = text(provider);
  const flag = bool(provider);
  const falseLiteral = provider === "sqlite" ? "0" : "false";
  const trueLiteral = provider === "sqlite" ? "1" : "true";
  const key64 = asciiText(provider, 64);
  const id = identityText(provider);
  const uuid = asciiText(provider, 36);
  const json = jsonText(provider);
  const labelOrder = bytes(provider, 2_048);
  const sourceId = newOpaqueId();
  const legacyOrder = "id";
  const index = (
    name: string,
    table: string,
    columns: string,
    storing = "",
  ): string[] =>
    provider === "mysql"
      ? []
      : [
          `create index if not exists ${name} on ${table}(${columns})${
            provider === "cockroachdb" && storing ? ` storing (${storing})` : ""
          }`,
        ];
  return [
    `create table if not exists ${tables.state} (id integer primary key, layout_revision integer not null, source_id ${uuid} not null, next_seq bigint not null, ready ${flag} not null, migration_upper_id ${large}, migration_after_id ${large}, poison_event_id ${large})`,
    `insert into ${tables.state} (id, layout_revision, source_id, next_seq, ready, migration_upper_id, migration_after_id, poison_event_id) select 1, ${KYSELY_INSIGHTS_LAYOUT_REVISION}, '${sourceId}', 0, ${falseLiteral}, null, null, null where not exists (select 1 from ${tables.state} where id = 1)`,
    `create table if not exists ${tables.events} (event_id ${uuid} primary key, source_seq bigint not null unique, received_at_ms bigint not null, install_key ${key64} not null, install_id ${id} not null, event_type varchar(32) not null, to_bundle_id ${uuid} not null, from_bundle_id ${uuid}, raw_json ${large} not null${provider === "mysql" ? ", index kysely_insights_events_order_idx (received_at_ms, event_id), index kysely_insights_events_install_idx (install_key, event_type, received_at_ms, event_id), index kysely_insights_events_install_source_idx (install_key, source_seq), index kysely_insights_events_to_bundle_idx (event_type, to_bundle_id, received_at_ms, event_id), index kysely_insights_events_from_bundle_idx (event_type, from_bundle_id, received_at_ms, event_id)" : ""})`,
    ...index(
      "kysely_insights_events_order_idx",
      tables.events,
      "received_at_ms desc, event_id desc",
      "source_seq, install_key, install_id, raw_json",
    ),
    ...index(
      "kysely_insights_events_install_idx",
      tables.events,
      "install_key, event_type, received_at_ms desc, event_id desc",
      "source_seq, install_id, raw_json",
    ),
    ...index(
      "kysely_insights_events_install_source_idx",
      tables.events,
      "install_key, source_seq",
    ),
    ...index(
      "kysely_insights_events_to_bundle_idx",
      tables.events,
      "event_type, to_bundle_id, received_at_ms, event_id",
      "source_seq, install_key, install_id, raw_json",
    ),
    ...index(
      "kysely_insights_events_from_bundle_idx",
      tables.events,
      "event_type, from_bundle_id, received_at_ms, event_id",
      "source_seq, install_key, install_id, raw_json",
    ),
    `create table if not exists ${tables.live} (install_key ${key64} primary key, install_id ${id} not null, first_source_seq bigint not null, received_at_ms bigint not null, event_id ${uuid} not null, source_seq bigint not null, raw_json ${large} not null)`,
    `create table if not exists ${tables.liveVersions} (install_key ${key64} not null, source_seq bigint not null, install_id ${id} not null, received_at_ms bigint not null, event_id ${uuid} not null, raw_json ${large} not null, primary key (install_key, source_seq))`,
    `create table if not exists ${tables.aliases} (install_key ${key64} not null, install_id ${id} not null, alias_kind varchar(16) not null, alias_hash ${key64} not null, value_json ${large} not null, normalized_json ${large} not null, source_seq bigint not null, primary key (install_key, alias_kind, alias_hash)${provider === "mysql" ? ", index kysely_insights_alias_order_idx (install_key, alias_kind, alias_hash), index kysely_insights_alias_source_idx (source_seq, install_key, alias_kind, alias_hash)" : ""})`,
    ...index(
      "kysely_insights_alias_order_idx",
      tables.aliases,
      "install_key, alias_kind, alias_hash",
    ),
    ...index(
      "kysely_insights_alias_source_idx",
      tables.aliases,
      "source_seq, install_key, alias_kind, alias_hash",
    ),
    `create table if not exists ${tables.searchHeads} (query_hash ${key64} primary key, normalized_json ${large} not null, active_job_id ${uuid}, publication_job_id ${uuid}, failed_job_id ${uuid})`,
    `create table if not exists ${tables.searchJobs} (id ${uuid} primary key, query_hash ${key64} not null, normalized_json ${large} not null, state varchar(16) not null, source_id ${uuid} not null, source_upper bigint not null, as_of_ms bigint not null, completed_at_ms bigint, after_source_seq bigint not null, after_install_key ${key64}, after_alias_kind varchar(16), after_alias_hash ${key64}, total bigint not null, failure_json ${json}, foreign key (query_hash) references ${tables.searchHeads}(query_hash)${provider === "mysql" ? ", index kysely_insights_search_work_idx (state, as_of_ms, id)" : ""})`,
    ...index(
      "kysely_insights_search_work_idx",
      tables.searchJobs,
      "state, as_of_ms, id",
    ),
    `create table if not exists ${tables.searchRows} (job_id ${uuid} not null, install_key ${key64} not null, install_id ${id} not null, raw_json ${large} not null, primary key (job_id, install_key))`,
    `create table if not exists ${tables.reportHeads} (query_hash ${key64} primary key, query_json ${json} not null, active_job_id ${uuid}, publication_job_id ${uuid}, failed_job_id ${uuid})`,
    `create table if not exists ${tables.reportJobs} (id ${uuid} primary key, query_hash ${key64} not null, query_json ${json} not null, state varchar(20) not null, phase varchar(20) not null, source_id ${uuid} not null, source_upper bigint not null, as_of_ms bigint not null, completed_at_ms bigint, after_source_seq bigint not null, after_member_key ${key64}, after_install_key ${key64}, order_phase integer not null, order_after_value bigint, order_after_label ${labelOrder}, next_ordinal bigint not null, publication_json ${json}, failure_json ${json}, foreign key (query_hash) references ${tables.reportHeads}(query_hash)${provider === "mysql" ? ", index kysely_insights_report_work_idx (state, as_of_ms, id)" : ""})`,
    ...index(
      "kysely_insights_report_work_idx",
      tables.reportJobs,
      "state, as_of_ms, id",
    ),
    `create table if not exists ${tables.reportMembers} (job_id ${uuid} not null, member_key ${key64} not null, section varchar(32) not null, metric varchar(16) not null, label ${large} not null, bucket_start_ms bigint not null, primary key (job_id, member_key)${provider === "mysql" ? ", index kysely_insights_members_order_idx (job_id, member_key)" : ""})`,
    ...index(
      "kysely_insights_members_order_idx",
      tables.reportMembers,
      "job_id, member_key",
    ),
    `create table if not exists ${tables.reportLatest} (job_id ${uuid} not null, install_key ${key64} not null, bucket_index integer not null, received_at_ms bigint not null, event_id ${uuid} not null, raw_json ${large} not null, primary key (job_id, install_key, bucket_index)${provider === "mysql" ? ", index kysely_insights_latest_install_idx (job_id, bucket_index, install_key)" : ""})`,
    ...index(
      "kysely_insights_latest_install_idx",
      tables.reportLatest,
      "job_id, bucket_index, install_key",
    ),
    `create table if not exists ${tables.reportCounts} (job_id ${uuid} not null, count_key ${key64} not null, section varchar(32) not null, metric varchar(16) not null, label ${large} not null, label_order ${labelOrder} not null, bucket_start_ms bigint not null, value bigint not null, primary key (job_id, count_key)${provider === "mysql" ? ", index kysely_insights_counts_page_idx (job_id, section, metric, bucket_start_ms), index kysely_insights_counts_order_idx (job_id, section, metric, bucket_start_ms, label_order), index kysely_insights_counts_rank_idx (job_id, section, metric, bucket_start_ms, value desc, label_order)" : ""})`,
    ...index(
      "kysely_insights_counts_page_idx",
      tables.reportCounts,
      "job_id, section, metric, bucket_start_ms",
    ),
    ...index(
      "kysely_insights_counts_order_idx",
      tables.reportCounts,
      "job_id, section, metric, bucket_start_ms, label_order",
    ),
    ...index(
      "kysely_insights_counts_rank_idx",
      tables.reportCounts,
      "job_id, section, metric, bucket_start_ms, value desc, label_order",
    ),
    `create table if not exists ${tables.reportOrder} (job_id ${uuid} not null, order_kind varchar(32) not null, metric varchar(16) not null, ordinal bigint not null, label ${large} not null, label_key ${key64} not null, label_ordinal bigint not null, bucket_start_ms bigint not null, value bigint not null, primary key (job_id, order_kind, metric, ordinal)${provider === "mysql" ? ", index kysely_insights_order_label_idx (job_id, order_kind, metric, label_key, label_ordinal)" : ""})`,
    ...index(
      "kysely_insights_order_label_idx",
      tables.reportOrder,
      "job_id, order_kind, metric, label_key, label_ordinal",
    ),
    `create table if not exists ${tables.reportPageTotals} (job_id ${uuid} not null, section varchar(32) not null, metric varchar(16) not null, label ${large} not null, label_key ${key64} not null, total bigint not null, primary key (job_id, section, metric, label_key))`,
    `update ${tables.state} set migration_upper_id = (select id from bundle_events order by ${legacyOrder} desc limit 1) where id = 1 and ready = ${falseLiteral} and migration_upper_id is null and exists (select 1 from bundle_events)`,
    `update ${tables.state} set ready = ${trueLiteral} where id = 1 and migration_upper_id is null and not exists (select 1 from bundle_events)`,
  ];
};

export const migrateKyselyInsights = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  statements = getKyselyInsightsDDL(provider),
): Promise<void> => {
  for (const statement of statements) {
    await sql.raw(statement).execute(db);
  }
  const state = await sql<{
    layout_revision: unknown;
  }>`select layout_revision from ${sql.table(
    tables.state,
  )} where id = 1`.execute(db);
  if (
    state.rows.length > 0 &&
    Number(state.rows[0]?.layout_revision) !== KYSELY_INSIGHTS_LAYOUT_REVISION
  ) {
    throw new Error("Unsupported Kysely Insights layout revision.");
  }
};
