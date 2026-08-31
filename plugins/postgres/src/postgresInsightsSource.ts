import { createHash } from "node:crypto";

import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import {
  assertInsightsEventRow,
  databaseFields,
} from "@hot-updater/plugin-core/internal";
import { sql, type Kysely, type QueryExecutorProvider } from "kysely";

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
  // Recheck each logical operation: do not turn a dropped index into a raw
  // history scan. Concurrent manual DDL remains outside the migration contract.
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
  ) as ready`.execute(db);
  if (!rows[0]?.ready) throw new InsightsQueryNotReadyError();
};

export const postgresEventSourceShard = (id: string): number => {
  const canonical = id.toLowerCase();
  if (!uuid.test(canonical)) throw new DatabasePluginInputError("invalid-data");
  return (
    createHash("sha256").update(canonical).digest()[0]! % POSTGRES_SOURCE_SHARDS
  );
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
  const shard = postgresEventSourceShard(row.id);
  // The UPDATE lock lasts until the surrounding commit. Unlike nextval(), a
  // later counter value cannot commit while an earlier allocation is pending.
  const result = await sql<BundleEventRow>`with allocated as (
    update ${sql.table(clocks)} set committed_seq = committed_seq + 1
    where shard = ${shard} returning committed_seq
  ) insert into bundle_events (${eventColumns()}, insights_source_shard, insights_source_seq)
    select ${sql.join(databaseFields.bundle_events.map((field) => row[field]))},
      ${shard}, committed_seq from allocated
    returning ${eventColumns()}`.execute(db);
  if (result.rows.length !== 1) throw new InsightsQueryNotReadyError();
  return result.rows[0]!;
};

type SourceState = {
  version: number;
  initialized: boolean;
  ready: boolean;
  upper_id: string | null;
  after_id: string | null;
};
type StoredEvent = BundleEventRow & {
  insights_source_shard: number | null;
  insights_source_seq: string | null;
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

export const createPostgresInsightsSourceTools = <TDatabase extends object>(
  db: Kysely<TDatabase>,
) => {
  // Captures must not include the caller's own uncommitted source allocations.
  if (db.isTransaction) throw new DatabasePluginInputError("invalid-query");
  return {
    async capture(): Promise<string> {
      await assertPostgresInsightsSourceIndex(db);
      const { rows } = await sql<{
        source_id: string;
        shard: number;
        committed_seq: string;
      }>`
        select s.source_id, c.shard, c.committed_seq::text from ${sql.table(clocks)} c
        join ${sql.table(stateTable)} s on s.id = 1
        where s.version = 1 and s.initialized and s.ready
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
            BundleEventRow & { source_sequence: string }
          >`
        select ${eventColumns()}, insights_source_seq::text as source_sequence
        from bundle_events where insights_source_shard = ${input.shard}
          and insights_source_seq > ${after}::bigint
          and insights_source_seq <= ${prefix[input.shard]}::bigint
        order by insights_source_seq asc limit ${input.limit}`.execute(
            transaction,
          );
          let previous = BigInt(after);
          if (rows.length > input.limit)
            throw new DatabasePluginInputError("invalid-result");
          const page = rows.map(({ source_sequence, ...event }) => {
            assertInsightsEventRow(event);
            if (
              !sequence(source_sequence) ||
              BigInt(source_sequence) !== previous + 1n ||
              BigInt(source_sequence) > BigInt(prefix[input.shard]!)
            ) {
              throw new DatabasePluginInputError("invalid-result");
            }
            previous = BigInt(source_sequence);
            return { sequence: source_sequence, event };
          });
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
      return db.transaction().execute(async (transaction) => {
        await assertPostgresInsightsSourceIndex(transaction);
        const saved = await sql<SourceState>`select version, initialized, ready,
          upper_id, after_id from ${sql.table(stateTable)} where id = 1 for update`.execute(
          transaction,
        );
        const state = saved.rows[0];
        if (!state || state.version !== 1)
          throw new InsightsQueryNotReadyError();
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
        const result = await sql<StoredEvent>`select ${eventColumns()},
          insights_source_shard, insights_source_seq::text from bundle_events
          where id <= ${state.upper_id}::uuid
          ${state.after_id === null ? sql`` : sql`and id > ${state.after_id}::uuid`}
          order by id asc limit ${limit}`.execute(transaction);
        const pending: StoredEvent[] = [];
        for (const row of result.rows) {
          assertInsightsEventRow(row);
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
            insights_source_seq = allocated.committed_seq from allocated
            where id = ${row.id}::uuid and insights_source_shard is null
              and insights_source_seq is null returning id`.execute(
            transaction,
          );
          if (updated.rows.length !== 1)
            throw new DatabasePluginInputError("invalid-result");
        }
        const afterId = result.rows.at(-1)?.id ?? state.after_id;
        const ready = result.rows.length < limit || afterId === state.upper_id;
        await sql`update ${sql.table(stateTable)} set after_id = ${afterId}::uuid,
          ready = ${ready}, revision = revision + 1 where id = 1`.execute(
          transaction,
        );
        return { ready, processed: result.rows.length };
      });
    },
  };
};
