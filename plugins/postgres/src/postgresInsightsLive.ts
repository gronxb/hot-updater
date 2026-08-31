import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
  type InsightsInstallationRow,
  type InsightsInstallationPage,
  type InsightsInstallationPageInput,
} from "@hot-updater/plugin-core";
import {
  assertInsightsEventRow,
  databaseFields,
} from "@hot-updater/plugin-core/internal";
import { sql, type Kysely, type QueryExecutorProvider } from "kysely";

export const POSTGRES_INSIGHTS_LIVE_TABLE =
  "private_hot_updater_insights_live_installations";
const stateTable = "private_hot_updater_insights_live_state";
const cursorRevision = "live-installations-sha256-json-v1";
const hex = /^[0-9a-f]{64}$/;

export const postgresInsightsInstallKey = (installId: string): Buffer =>
  createHash("sha256").update(JSON.stringify(installId)).digest();

const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};

type Stored = {
  install_key: string;
  install_id: string;
  event_id: string;
  received_at_ms: number;
  event: BundleEventRow;
};

const readStored = (row: Stored): BundleEventRow => {
  assertInsightsEventRow(row.event);
  if (
    !hex.test(row.install_key) ||
    postgresInsightsInstallKey(row.install_id).toString("hex") !==
      row.install_key ||
    row.event.install_id !== row.install_id ||
    row.event.id !== row.event_id ||
    row.event.received_at_ms !== row.received_at_ms
  )
    invalid();
  return row.event;
};

const toInstallationRow = (event: BundleEventRow): InsightsInstallationRow => {
  const {
    id,
    install_id,
    user_id,
    username,
    to_bundle_id,
    type,
    platform,
    app_version,
    channel,
    cohort,
    received_at_ms,
  } = event;
  return {
    id,
    install_id,
    user_id,
    username,
    to_bundle_id,
    type,
    platform,
    app_version,
    channel,
    cohort,
    received_at_ms,
  };
};

export const assertPostgresInsightsLiveReady = async (
  db: QueryExecutorProvider,
  requireBackfill = true,
): Promise<number> => {
  const layout = await sql<{ ready: boolean }>`select
    exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
      join pg_am am on am.oid = c.relam
      where i.indexrelid = to_regclass('private_hot_updater_insights_live_installations_pkey')
        and i.indrelid = to_regclass('private_hot_updater_insights_live_installations')
        and i.indisvalid and i.indisready and i.indisunique and i.indisprimary
        and i.indnkeyatts = 1 and i.indnatts = 1 and i.indexprs is null
        and i.indpred is null and am.amname = 'btree'
        and pg_get_indexdef(i.indexrelid, 1, false) = 'install_key'
        and not exists (select 1 from unnest(i.indoption) bits where bits <> 0)
        and not exists (select 1 from unnest(i.indclass) class_id
          join pg_opclass opclass on opclass.oid = class_id where not opclass.opcdefault))
    and (select array_agg(a.attname || ':' || a.atttypid::regtype::text || ':' || a.attnotnull::text
      order by a.attnum) from pg_attribute a
      where a.attrelid = to_regclass('private_hot_updater_insights_live_installations')
        and a.attnum > 0 and not a.attisdropped) = array[
          'install_key:bytea:true','install_id:text:true','event_id:uuid:true',
          'received_at_ms:double precision:true','event:jsonb:true']
    and exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
      join pg_am am on am.oid = c.relam
      where i.indexrelid = to_regclass('private_hot_updater_insights_live_state_pkey')
        and i.indrelid = to_regclass('private_hot_updater_insights_live_state')
        and i.indisvalid and i.indisready and i.indisunique and i.indisprimary
        and i.indnkeyatts = 1 and i.indnatts = 1 and i.indexprs is null
        and i.indpred is null and am.amname = 'btree'
        and pg_get_indexdef(i.indexrelid, 1, false) = 'id'
        and not exists (select 1 from unnest(i.indoption) bits where bits <> 0)
        and not exists (select 1 from unnest(i.indclass) class_id
          join pg_opclass opclass on opclass.oid = class_id where not opclass.opcdefault))
    and (select array_agg(a.attname || ':' || a.atttypid::regtype::text || ':' || a.attnotnull::text
      order by a.attnum) from pg_attribute a
      where a.attrelid = to_regclass('private_hot_updater_insights_live_state')
        and a.attnum > 0 and not a.attisdropped) = array[
          'id:integer:true','version:integer:true','initialized:boolean:true',
          'ready:boolean:true','upper_id:uuid:false','after_id:uuid:false',
          'revision:bigint:true']
    and exists (select 1 from pg_constraint
      where conrelid = to_regclass('bundle_events')
        and conname = 'bundle_events_live_required'
        and pg_get_constraintdef(oid) = 'CHECK (((insights_live_version IS NOT NULL) AND (insights_live_version = 1))) NOT VALID')
    and exists (select 1 from pg_attribute
      where attrelid = to_regclass('bundle_events')
        and attname = 'insights_live_version' and atttypid = 'int2'::regtype
        and not attnotnull and not attisdropped)
    as ready`.execute(db);
  if (!layout.rows[0]?.ready) throw new InsightsQueryNotReadyError();
  const state = await sql<{ ready: boolean; observed_at_ms: number }>`select
    exists (select 1 from ${sql.table(stateTable)}
      where id = 1 and version = 1
        and (${requireBackfill} = false or ready)) as ready,
    floor(extract(epoch from statement_timestamp())*1000)::float8 observed_at_ms`.execute(
    db,
  );
  if (!state.rows[0]?.ready) throw new InsightsQueryNotReadyError();
  const observedAtMs = state.rows[0].observed_at_ms;
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) invalid();
  return observedAtMs;
};

const upsertLatest = async (
  db: QueryExecutorProvider,
  events: readonly BundleEventRow[],
): Promise<void> => {
  if (events.length === 0) return;
  const latest = new Map<string, BundleEventRow>();
  for (const event of events) {
    const key = postgresInsightsInstallKey(event.install_id).toString("hex");
    const current = latest.get(key);
    if (current !== undefined && current.install_id !== event.install_id)
      invalid();
    if (
      current === undefined ||
      current.received_at_ms < event.received_at_ms ||
      (current.received_at_ms === event.received_at_ms && current.id < event.id)
    )
      latest.set(key, event);
  }
  const values = [...latest.values()].map(
    (event) =>
      sql`(${postgresInsightsInstallKey(event.install_id)}, ${event.install_id},
      ${event.id}::uuid, ${event.received_at_ms}, ${JSON.stringify(event)}::jsonb)`,
  );
  await sql`insert into ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)}
    (install_key,install_id,event_id,received_at_ms,event) values ${sql.join(values)}
    on conflict (install_key) do update set
      event_id = excluded.event_id, received_at_ms = excluded.received_at_ms,
      event = excluded.event
    where ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)}.install_id = excluded.install_id
      and (${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)}.received_at_ms,
        ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)}.event_id)
        < (excluded.received_at_ms, excluded.event_id)`.execute(db);
  const keys = [...latest.values()].map((event) =>
    postgresInsightsInstallKey(event.install_id),
  );
  const checked =
    await sql<Stored>`select encode(install_key,'hex') install_key,
    install_id,event_id,received_at_ms,event
    from ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)}
    where install_key in (${sql.join(keys)}) limit ${keys.length}`.execute(db);
  const byKey = new Map(checked.rows.map((row) => [row.install_key, row]));
  for (const event of events) {
    const key = postgresInsightsInstallKey(event.install_id).toString("hex");
    const row = byKey.get(key);
    if (row === undefined) return invalid();
    const saved = readStored(row);
    if (
      saved.install_id !== event.install_id ||
      saved.received_at_ms < event.received_at_ms ||
      (saved.received_at_ms === event.received_at_ms && saved.id < event.id)
    )
      invalid();
  }
};

type State = {
  version: number;
  initialized: boolean;
  ready: boolean;
  upper_id: string | null;
  after_id: string | null;
};

export const createPostgresInsightsLiveTools = <TDatabase extends object>(
  db: Kysely<TDatabase>,
) => ({
  async backfillStep(
    limit: number,
  ): Promise<{ ready: boolean; processed: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new DatabasePluginInputError("invalid-query");
    return db.transaction().execute(async (transaction) => {
      await assertPostgresInsightsLiveReady(transaction, false);
      const saved =
        await sql<State>`select version,initialized,ready,upper_id,after_id
        from ${sql.table(stateTable)} where id=1 for update`.execute(
          transaction,
        );
      const state = saved.rows[0];
      if (!state || state.version !== 1) throw new InsightsQueryNotReadyError();
      if (state.ready) return { ready: true, processed: 0 };
      if (!state.initialized) {
        const upper = await sql<{ id: string }>`select id from bundle_events
          order by id desc limit 1`.execute(transaction);
        const upperId = upper.rows[0]?.id ?? null;
        await sql`update ${sql.table(stateTable)} set initialized=true,
          upper_id=${upperId}::uuid, ready=${upperId === null}, revision=revision+1
          where id=1`.execute(transaction);
        return { ready: upperId === null, processed: 0 };
      }
      if (state.upper_id === null) invalid();
      const result = await sql<
        BundleEventRow & { live_marker: number | null }
      >`select
        ${sql.join(databaseFields.bundle_events.map((field) => sql.ref(field)))},
        insights_live_version live_marker
        from bundle_events where id <= ${state.upper_id}::uuid
        ${state.after_id === null ? sql`` : sql`and id > ${state.after_id}::uuid`}
        order by id asc limit ${limit}`.execute(transaction);
      for (const event of result.rows) {
        assertInsightsEventRow(event);
        if (event.live_marker !== null && event.live_marker !== 1) invalid();
      }
      await upsertLatest(
        transaction,
        result.rows.map(({ live_marker: _, ...event }) => event),
      );
      const pending = result.rows.filter((event) => event.live_marker === null);
      if (pending.length > 0) {
        const updated = await sql<{ id: string }>`update bundle_events
          set insights_live_version=1 where id in (${sql.join(pending.map(({ id }) => sql`${id}::uuid`))})
          and insights_live_version is null returning id`.execute(transaction);
        if (updated.rows.length !== pending.length) invalid();
      }
      const afterId = result.rows.at(-1)?.id ?? state.after_id;
      const ready = result.rows.length < limit || afterId === state.upper_id;
      await sql`update ${sql.table(stateTable)} set after_id=${afterId}::uuid,
        ready=${ready}, revision=revision+1 where id=1`.execute(transaction);
      return { ready, processed: result.rows.length };
    });
  },
});

type AllInput = Extract<InsightsInstallationPageInput, { kind: "all" }>;

export const createPostgresInsightsLivePages = (db: QueryExecutorProvider) => ({
  async pageAll(input: AllInput): Promise<InsightsInstallationPage> {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !["kind", "limit", "cursor"].includes(key),
      ) ||
      input.kind !== "all" ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new DatabasePluginInputError("invalid-query");
    let after: string | null = null;
    if (input.cursor !== undefined) {
      if (typeof input.cursor !== "string" || input.cursor.length > 160)
        throw new DatabasePluginInputError("invalid-query");
      let cursor: unknown;
      try {
        cursor = JSON.parse(input.cursor);
      } catch {
        throw new DatabasePluginInputError("invalid-query");
      }
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 3 ||
        cursor[0] !== 1 ||
        cursor[1] !== cursorRevision ||
        typeof cursor[2] !== "string" ||
        !hex.test(cursor[2])
      )
        throw new DatabasePluginInputError("invalid-query");
      after = cursor[2];
    }
    const observedAtMs = await assertPostgresInsightsLiveReady(db);
    const result = await sql<Stored>`select
      encode(live.install_key,'hex') install_key,live.install_id,live.event_id,
      live.received_at_ms,live.event
      from ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)} live
      ${after === null ? sql`` : sql`where live.install_key > decode(${after},'hex')`}
      order by live.install_key asc limit ${input.limit + 1}`.execute(db);
    let previous = after;
    for (const row of result.rows) {
      if (previous !== null && row.install_key <= previous) invalid();
      previous = row.install_key;
      readStored(row);
    }
    const emitted = result.rows.slice(0, input.limit);
    return {
      state: "ready",
      consistency: "live",
      observedAtMs,
      rows: emitted.map((row) => toInstallationRow(readStored(row))),
      nextCursor:
        result.rows.length > input.limit
          ? JSON.stringify([1, cursorRevision, emitted.at(-1)!.install_key])
          : null,
    };
  },
});

export const getPostgresInsightsLiveMigrationSQL = (): Promise<string> =>
  readFile(new URL("../sql/insights-live-v1.sql", import.meta.url), "utf8");

export const migratePostgresInsightsLive = async <TDatabase extends object>(
  db: Kysely<TDatabase>,
): Promise<void> => {
  if (db.isTransaction)
    throw new Error(
      "Live installation migration requires a root database connection.",
    );
  const migration = await getPostgresInsightsLiveMigrationSQL();
  await db.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtext('hot-updater:insights-live:v1'))`.execute(
      transaction,
    );
    const installed = await sql<{
      present: boolean;
    }>`select to_regclass('private_hot_updater_insights_live_state') is not null present`.execute(
      transaction,
    );
    const sourceLayout = await sql<{ present: boolean }>`select
      to_regclass('private_hot_updater_insights_source_state') is not null present`.execute(
      transaction,
    );
    if (!sourceLayout.rows[0]?.present) throw new InsightsQueryNotReadyError();
    const source = await sql<{ ready: boolean }>`select exists (
      select 1 from private_hot_updater_insights_source_state
      where id=1 and version=1 and initialized and ready
    ) ready`.execute(transaction);
    if (!source.rows[0]?.ready) throw new InsightsQueryNotReadyError();
    if (!installed.rows[0]?.present)
      for (const statement of migration
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean))
        await sql.raw(statement).execute(transaction);
    await assertPostgresInsightsLiveReady(transaction, false);
  });
};
