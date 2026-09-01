import { createHash } from "node:crypto";

import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import {
  assertInsightsEventContract,
  assertInsightsEventRow,
  databaseFields,
  isCanonicalInsightsEventId,
} from "@hot-updater/plugin-core/internal";
import { sql, type Kysely, type QueryExecutorProvider } from "kysely";

import {
  assertPostgresInsightsEventCandidates,
  postgresInsightsEventVariableBytes,
  recordPostgresInsightsPreparationFailure,
  type PostgresInsightsEventCandidate,
} from "./postgresInsightsContract";
import {
  POSTGRES_INSIGHTS_LIVE_TABLE,
  postgresInsightsInstallKey,
} from "./postgresInsightsLive";

// The shard layout is part of source generation v1, never caller configuration.
export const POSTGRES_SOURCE_SHARDS = 16;
const clocks = "private_hot_updater_insights_source_clocks";
const stateTable = "private_hot_updater_insights_source_state";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decimal = /^(0|[1-9][0-9]{0,18})$/;
const maxSequence = 9_223_372_036_854_775_807n;
const eventColumns = () =>
  sql.join(databaseFields.bundle_events.map((field) => sql.ref(field)));

const sequence = (value: unknown): value is string =>
  typeof value === "string" &&
  decimal.test(value) &&
  BigInt(value) <= maxSequence;

export const assertPostgresInsightsSourceIndex = async (
  db: QueryExecutorProvider,
): Promise<void> => {
  // Recheck the complete owned layout for every logical operation. A missing
  // writer fence or malformed clock/state table must never permit a raw-history
  // fallback or let an old writer silently omit source markers.
  const { rows } = await sql<{ ready: boolean }>`select exists (
    select 1 from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_am am on am.oid = c.relam
    where i.indexrelid = to_regclass('bundle_events_source_idx')
      and i.indrelid = to_regclass('bundle_events')
      and i.indisvalid and i.indisready and i.indisunique
      and i.indnkeyatts = 2 and i.indnatts = 2 and i.indexprs is null
      and am.amname = 'btree'
      and pg_get_indexdef(i.indexrelid, 1, false) = 'insights_source_shard'
      and pg_get_indexdef(i.indexrelid, 2, false) = 'insights_source_seq'
      and pg_get_expr(i.indpred, i.indrelid) = '(insights_source_shard IS NOT NULL)'
      and not exists (select 1 from unnest(i.indoption) option_bits
        where option_bits <> 0)
      and not exists (select 1 from unnest(i.indclass) class_id
        join pg_opclass opclass on opclass.oid = class_id
        where not opclass.opcdefault)
  ) and (select array_agg(a.attname || ':' || format_type(a.atttypid,a.atttypmod)
        || ':' || a.attnotnull::text || ':' || a.atthasdef::text
        || ':' || a.attidentity::text || ':' || a.attgenerated::text
      order by a.attnum) from pg_attribute a
      where a.attrelid = to_regclass('private_hot_updater_insights_source_state')
        and a.attnum > 0 and not a.attisdropped) = array[
          'id:integer:true:false::','version:integer:true:false::',
          'source_id:uuid:true:true::','initialized:boolean:true:false::',
          'ready:boolean:true:false::','failed:boolean:true:false::',
          'failure:text:false:false::','upper_id:uuid:false:false::',
          'after_id:uuid:false:false::','revision:bigint:true:false::']
    and (select pg_get_expr(d.adbin,d.adrelid) from pg_attrdef d
      join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum
      where d.adrelid=to_regclass('private_hot_updater_insights_source_state')
        and a.attname='source_id') = 'gen_random_uuid()'
    and (select array_agg(a.attname || ':' || format_type(a.atttypid,a.atttypmod)
        || ':' || a.attnotnull::text || ':' || a.atthasdef::text
        || ':' || a.attidentity::text || ':' || a.attgenerated::text
      order by a.attnum) from pg_attribute a
      where a.attrelid = to_regclass('private_hot_updater_insights_source_clocks')
        and a.attnum > 0 and not a.attisdropped) = array[
          'shard:smallint:true:false::','committed_seq:bigint:true:false::']
    and (select array_agg(a.attname || ':' || format_type(a.atttypid,a.atttypmod)
        || ':' || a.attnotnull::text || ':' || a.atthasdef::text
        || ':' || a.attidentity::text || ':' || a.attgenerated::text
      order by a.attnum) from pg_attribute a
      where a.attrelid = to_regclass('bundle_events')
        and a.attname in ('insights_source_shard','insights_source_seq','insights_event')
        and a.attnum > 0 and not a.attisdropped) = array[
          'insights_source_shard:smallint:false:false::',
          'insights_source_seq:bigint:false:false::',
          'insights_event:jsonb:false:false::']
    and (select array_agg(pg_get_constraintdef(c.oid,false)
        order by pg_get_constraintdef(c.oid,false))
      from pg_constraint c
      where c.conrelid=to_regclass('private_hot_updater_insights_source_clocks')) = array[
        'CHECK (((shard >= 0) AND (shard <= 15)))',
        'CHECK ((committed_seq >= 0))','PRIMARY KEY (shard)']
    and (select bool_and(c.convalidated and not c.condeferrable
        and not c.condeferred and c.connoinherit=(c.contype='p'))
      from pg_constraint c
      where c.conrelid=to_regclass('private_hot_updater_insights_source_clocks'))
    and (select array_agg(pg_get_constraintdef(c.oid,false)
        order by pg_get_constraintdef(c.oid,false))
      from pg_constraint c
      where c.conrelid=to_regclass('private_hot_updater_insights_source_state')) = array[
        'CHECK (((failed AND (NOT ready) AND (failure IS NOT NULL)) OR ((NOT failed) AND (failure IS NULL))))',
        'CHECK (((failure IS NULL) OR (octet_length(failure) <= 64)))',
        'CHECK ((id = 1))','CHECK ((revision > 0))','CHECK ((version = 1))',
        'PRIMARY KEY (id)']
    and (select bool_and(c.convalidated and not c.condeferrable
        and not c.condeferred and c.connoinherit=(c.contype='p'))
      from pg_constraint c
      where c.conrelid=to_regclass('private_hot_updater_insights_source_state'))
    and exists (select 1 from pg_constraint c
      where c.conrelid=to_regclass('bundle_events')
        and c.conname='bundle_events_source_required' and c.contype='c'
        and not c.convalidated and not c.condeferrable and not c.condeferred
        and not c.connoinherit
        and pg_get_constraintdef(c.oid,false) =
          'CHECK (((insights_source_shard IS NOT NULL) AND ((insights_source_shard >= 0) AND (insights_source_shard <= 15)) AND (insights_source_seq IS NOT NULL) AND (insights_source_seq > 0) AND (insights_event IS NOT NULL))) NOT VALID')
    and (select count(*) from pg_constraint c
      where c.conrelid=to_regclass('bundle_events')
        and c.conname='bundle_events_source_required')=1
    and (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and c.relpersistence='p'
        and c.relname in ('bundle_events','private_hot_updater_insights_source_clocks',
          'private_hot_updater_insights_source_state'))=3
    and (select count(*)=16 and min(shard)=0 and max(shard)=15
      and count(distinct shard)=16 and bool_and(committed_seq >= 0)
      from ${sql.table(clocks)})
    and (select count(*)=1 and bool_and(id=1 and version=1)
      from ${sql.table(stateTable)}) as ready`.execute(db);
  if (!rows[0]?.ready) throw new InsightsQueryNotReadyError();
};

export const postgresEventSourceShard = (id: string): number => {
  if (!isCanonicalInsightsEventId(id))
    throw new DatabasePluginInputError("invalid-data");
  return createHash("sha256").update(id).digest()[0]! % POSTGRES_SOURCE_SHARDS;
};

export const lockPostgresEventSourceShards = async (
  db: QueryExecutorProvider,
  ids: readonly string[],
): Promise<void> => {
  const shards = [...new Set(ids.map(postgresEventSourceShard))].sort(
    (a, b) => a - b,
  );
  if (shards.length === 0) return;
  const result = await sql<{
    shard: number;
  }>`select shard from ${sql.table(clocks)}
    where shard in (${sql.join(shards)}) order by shard for update`.execute(db);
  if (result.rows.length !== shards.length)
    throw new InsightsQueryNotReadyError();
};

export const appendPostgresInsightsEvent = async (
  db: QueryExecutorProvider,
  row: BundleEventRow,
): Promise<BundleEventRow> => {
  assertInsightsEventContract(row);
  assertInsightsEventRow(row);
  const shard = postgresEventSourceShard(row.id);
  const installKey = postgresInsightsInstallKey(row.install_id);
  // The UPDATE lock lasts until the surrounding commit. Unlike nextval(), a
  // later counter value cannot commit while an earlier allocation is pending.
  const result = await sql<BundleEventRow>`with allocated as (
    update ${sql.table(clocks)} set committed_seq = committed_seq + 1
    where shard = ${shard} returning committed_seq
  ), inserted as (insert into bundle_events (${eventColumns()}, insights_source_shard, insights_source_seq, insights_event, insights_live_version)
    select ${sql.join(databaseFields.bundle_events.map((field) => row[field]))},
      ${shard}, committed_seq, ${JSON.stringify(row)}::jsonb, 1 from allocated
    returning ${eventColumns()}), latest as (
      insert into ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)}
        (install_key,install_id,event_id,received_at_ms,event)
      select ${installKey},install_id,id,received_at_ms,${JSON.stringify(row)}::jsonb
        from inserted
      on conflict (install_key) do update set
        install_id = case when ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)}.install_id = excluded.install_id
          then excluded.install_id else null end,
        event_id=excluded.event_id,received_at_ms=excluded.received_at_ms,event=excluded.event
      where ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)}.install_id <> excluded.install_id
        or (${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)}.received_at_ms,
          ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)}.event_id)
          < (excluded.received_at_ms,excluded.event_id)
      returning install_key
    ) select ${eventColumns()} from inserted`.execute(db);
  if (result.rows.length !== 1) throw new InsightsQueryNotReadyError();
  return result.rows[0]!;
};

type SourceState = {
  version: number;
  initialized: boolean;
  ready: boolean;
  failed: boolean;
  upper_id: string | null;
  after_id: string | null;
};

type StoredEvent = BundleEventRow & {
  insights_source_shard: number | null;
  insights_source_seq: string | null;
  insights_event: BundleEventRow | null;
};

const readGeneration = (
  value: string,
): { sourceId: string; counters: readonly string[] } => {
  let decoded: unknown;
  try {
    if (typeof value !== "string" || value.length > 1024) throw new Error();
    decoded = JSON.parse(value);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 3 ||
    decoded[0] !== 1 ||
    typeof decoded[1] !== "string" ||
    !uuid.test(decoded[1]) ||
    !Array.isArray(decoded[2]) ||
    decoded[2].length !== POSTGRES_SOURCE_SHARDS ||
    !decoded[2].every(sequence)
  )
    throw new DatabasePluginInputError("invalid-query");
  return { sourceId: decoded[1], counters: decoded[2] };
};

export const validatePostgresInsightsSourcePage = async (
  db: QueryExecutorProvider,
  input: {
    readonly sourceGeneration: string;
    readonly shard: number;
    readonly afterSequence: string;
    readonly limit: number;
  },
): Promise<number> => {
  const { sourceId, counters } = readGeneration(input.sourceGeneration);
  if (
    !Number.isSafeInteger(input.shard) ||
    input.shard < 0 ||
    input.shard >= POSTGRES_SOURCE_SHARDS ||
    !sequence(input.afterSequence) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 200 ||
    BigInt(input.afterSequence) > BigInt(counters[input.shard]!)
  )
    throw new DatabasePluginInputError("invalid-query");
  await assertPostgresInsightsSourceIndex(db);
  const upper = counters[input.shard]!;
  const candidates = await sql<
    PostgresInsightsEventCandidate & {
      source_id: string;
      ready: boolean;
      source_sequence: string;
    }
  >`with candidates as materialized (
      select id, (${postgresInsightsEventVariableBytes})::text variable_bytes,
        insights_source_seq::text source_sequence
      from bundle_events where insights_source_shard=${input.shard}
        and insights_source_seq > ${input.afterSequence}::bigint
        and insights_source_seq <= ${upper}::bigint
      order by insights_source_seq limit ${input.limit}
    ) select state.source_id, state.ready, candidates.*
    from ${sql.table(stateTable)} state left join candidates on true
    where state.id=1 and state.version=1
    order by candidates.source_sequence nulls last
    limit ${input.limit + 1}`.execute(db);
  if (
    candidates.rows.length < 1 ||
    candidates.rows[0]?.source_id !== sourceId ||
    !candidates.rows[0]?.ready
  )
    throw new InsightsQueryNotReadyError();
  const present = candidates.rows.filter(
    (row) => row.id !== null,
  ) as (typeof candidates.rows)[number][];
  assertPostgresInsightsEventCandidates(present);
  if (present.length === 0) return 0;
  const rows = await sql<
    BundleEventRow & {
      source_sequence: string;
      insights_event: BundleEventRow | null;
    }
  >`select ${eventColumns()}, insights_event,
      insights_source_seq::text source_sequence
    from bundle_events
    where id in (${sql.join(present.map(({ id }) => sql`${id}::uuid`))})
      and insights_source_shard=${input.shard}
      and insights_source_seq > ${input.afterSequence}::bigint
      and insights_source_seq <= ${upper}::bigint
    order by insights_source_seq limit ${input.limit + 1}`.execute(db);
  if (
    rows.rows.length !== present.length ||
    rows.rows.some(
      (row, index) =>
        row.id !== present[index]!.id ||
        row.source_sequence !== present[index]!.source_sequence,
    )
  )
    throw new DatabasePluginInputError("invalid-result");
  for (const { source_sequence: _, insights_event, ...stored } of rows.rows) {
    const event = insights_event ?? stored;
    assertInsightsEventContract(event);
    assertInsightsEventRow(event);
  }
  return rows.rows.length;
};

export const readPostgresInsightsSourceGeneration = async (
  db: QueryExecutorProvider,
): Promise<string> => {
  await assertPostgresInsightsSourceIndex(db);
  const { rows } = await sql<{
    source_id: string;
    shard: number;
    committed_seq: string;
  }>`select s.source_id, c.shard, c.committed_seq::text
    from ${sql.table(clocks)} c
    join ${sql.table(stateTable)} s on s.id = 1
    where s.version = 1 and s.initialized and s.ready and not s.failed
    order by c.shard limit ${POSTGRES_SOURCE_SHARDS + 1}`.execute(db);
  if (
    rows.length !== POSTGRES_SOURCE_SHARDS ||
    rows.some(
      (row, index) =>
        row.shard !== index ||
        !sequence(row.committed_seq) ||
        !uuid.test(row.source_id) ||
        row.source_id !== rows[0]?.source_id,
    )
  ) {
    throw new InsightsQueryNotReadyError();
  }
  return JSON.stringify([
    1,
    rows[0]!.source_id,
    rows.map((row) => row.committed_seq),
  ]);
};

export const createPostgresInsightsSourceTools = <TDatabase extends object>(
  db: Kysely<TDatabase>,
) => {
  // Captures must not include the caller's own uncommitted source allocations.
  if (db.isTransaction) throw new DatabasePluginInputError("invalid-query");
  return {
    async capture(): Promise<string> {
      return readPostgresInsightsSourceGeneration(db);
    },

    async readPage(input: {
      sourceGeneration: string;
      shard: number;
      afterSequence?: string;
      limit: number;
    }): Promise<readonly { sequence: string; event: BundleEventRow }[]> {
      const { sourceId, counters: prefix } = readGeneration(
        input.sourceGeneration,
      );
      const after = input.afterSequence ?? "0";
      if (
        !Number.isSafeInteger(input.shard) ||
        input.shard < 0 ||
        input.shard >= POSTGRES_SOURCE_SHARDS ||
        !sequence(after) ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 200 ||
        BigInt(after) > BigInt(prefix[input.shard]!)
      ) {
        throw new DatabasePluginInputError("invalid-query");
      }
      return db
        .transaction()
        .setIsolationLevel("repeatable read")
        .setAccessMode("read only")
        .execute(async (transaction) => {
          const identity = await sql<{
            source_id: string;
            ready: boolean;
          }>`select source_id, ready
        from ${sql.table(stateTable)} where id = 1 and version = 1`.execute(
            transaction,
          );
          if (
            identity.rows[0]?.source_id !== sourceId ||
            !identity.rows[0]?.ready
          ) {
            throw new InsightsQueryNotReadyError();
          }
          await assertPostgresInsightsSourceIndex(transaction);
          const { rows } = await sql<
            BundleEventRow & {
              source_sequence: string;
              insights_event: BundleEventRow | null;
            }
          >`
        select ${eventColumns()}, insights_event,
          insights_source_seq::text as source_sequence
        from bundle_events where insights_source_shard = ${input.shard}
          and insights_source_seq > ${after}::bigint
          and insights_source_seq <= ${prefix[input.shard]}::bigint
        order by insights_source_seq asc limit ${input.limit}`.execute(
            transaction,
          );
          let previous = BigInt(after);
          if (rows.length > input.limit)
            throw new DatabasePluginInputError("invalid-result");
          const page = rows.map(
            ({ source_sequence, insights_event, ...stored }) => {
              const event = insights_event ?? stored;
              assertInsightsEventRow(event);
              assertInsightsEventContract(event);
              if (
                !sequence(source_sequence) ||
                BigInt(source_sequence) !== previous + 1n ||
                BigInt(source_sequence) > BigInt(prefix[input.shard]!)
              ) {
                throw new DatabasePluginInputError("invalid-result");
              }
              previous = BigInt(source_sequence);
              return { sequence: source_sequence, event };
            },
          );
          if (
            rows.length < input.limit &&
            previous !== BigInt(prefix[input.shard]!)
          ) {
            throw new DatabasePluginInputError("invalid-result");
          }
          return page;
        });
    },

    async backfillStep(
      limit: number,
    ): Promise<{ ready: boolean; processed: number }> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new DatabasePluginInputError("invalid-query");
      }
      try {
        return await db.transaction().execute(async (transaction) => {
          await assertPostgresInsightsSourceIndex(transaction);
          const saved =
            await sql<SourceState>`select version, initialized, ready,
          failed, upper_id, after_id from ${sql.table(stateTable)} where id = 1 for update`.execute(
              transaction,
            );
          const state = saved.rows[0];
          if (!state || state.version !== 1)
            throw new InsightsQueryNotReadyError();
          if (state.failed) throw new InsightsQueryNotReadyError();
          if (state.ready) return { ready: true, processed: 0 };
          if (!state.initialized) {
            const upper = await sql<{ id: string }>`select id from bundle_events
            order by id desc limit 1`.execute(transaction);
            const upperId = upper.rows[0]?.id ?? null;
            await sql`update ${sql.table(stateTable)} set initialized = true,
            upper_id = ${upperId}::uuid, ready = ${upperId === null},
            revision = revision + 1 where id = 1`.execute(transaction);
            return { ready: upperId === null, processed: 0 };
          }
          if (state.upper_id === null)
            throw new DatabasePluginInputError("invalid-result");
          // Limit the raw PK range itself. Filtering for unassigned rows before
          // LIMIT could scan arbitrarily many newly indexed events between them.
          // Read lengths first so legacy poison cannot force an unbounded text
          // value through the driver before the public event validator runs.
          const candidates = await sql<PostgresInsightsEventCandidate>`select
          id, (${postgresInsightsEventVariableBytes})::text variable_bytes
          from bundle_events where id <= ${state.upper_id}::uuid
          ${state.after_id === null ? sql`` : sql`and id > ${state.after_id}::uuid`}
          order by id asc limit ${limit}`.execute(transaction);
          assertPostgresInsightsEventCandidates(candidates.rows);
          const result =
            candidates.rows.length === 0
              ? { rows: [] as StoredEvent[] }
              : await sql<StoredEvent>`select ${eventColumns()}, insights_event,
          insights_source_shard, insights_source_seq::text from bundle_events
          where id in (${sql.join(candidates.rows.map(({ id }) => sql`${id}::uuid`))})
          order by id asc limit ${limit}`.execute(transaction);
          if (result.rows.length !== candidates.rows.length)
            throw new DatabasePluginInputError("invalid-result");
          const pending: StoredEvent[] = [];
          for (const row of result.rows) {
            const event =
              row.insights_event ??
              Object.fromEntries(
                databaseFields.bundle_events.map((field) => [
                  field,
                  row[field],
                ]),
              );
            assertInsightsEventContract(event);
            assertInsightsEventRow(event);
            const shard = postgresEventSourceShard(row.id);
            if (
              row.insights_source_shard === null &&
              row.insights_source_seq === null
            ) {
              pending.push(row);
            } else if (
              row.insights_source_shard !== shard ||
              !sequence(row.insights_source_seq) ||
              row.insights_source_seq === "0"
            ) {
              throw new DatabasePluginInputError("invalid-result");
            }
          }
          await lockPostgresEventSourceShards(
            transaction,
            pending.map((row) => row.id),
          );
          for (const row of pending) {
            const shard = postgresEventSourceShard(row.id);
            const updated = await sql<{ id: string }>`with allocated as (
            update ${sql.table(clocks)} set committed_seq = committed_seq + 1
            where shard = ${shard} returning committed_seq
          ) update bundle_events set insights_source_shard = ${shard},
            insights_source_seq = allocated.committed_seq,
            insights_event = ${JSON.stringify(
              row.insights_event ??
                Object.fromEntries(
                  databaseFields.bundle_events.map((field) => [
                    field,
                    row[field],
                  ]),
                ),
            )}::jsonb from allocated
            where id = ${row.id}::uuid and insights_source_shard is null
              and insights_source_seq is null returning id`.execute(
              transaction,
            );
            if (updated.rows.length !== 1)
              throw new DatabasePluginInputError("invalid-result");
          }
          const afterId = result.rows.at(-1)?.id ?? state.after_id;
          const ready =
            result.rows.length < limit || afterId === state.upper_id;
          await sql`update ${sql.table(stateTable)} set after_id = ${afterId}::uuid,
          ready = ${ready}, revision = revision + 1 where id = 1`.execute(
            transaction,
          );
          return { ready, processed: result.rows.length };
        });
      } catch (error) {
        await recordPostgresInsightsPreparationFailure(db, stateTable, error);
        throw error;
      }
    },
  };
};
