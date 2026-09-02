import { createHash } from "node:crypto";

import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import { sql, type QueryExecutorProvider, type Transaction } from "kysely";

import {
  assertPostgresInsightsStoredEvent,
  assertPostgresInsightsTableLayouts,
} from "./postgresInsightsContract";

const aliases = "private_hot_updater_insights_report_aliases";
const hashPattern = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};
const assertJob = (jobId: string) => {
  if (typeof jobId !== "string" || !uuid.test(jobId))
    throw new DatabasePluginInputError("invalid-query");
};

export interface PostgresInsightsAliasRow {
  readonly aliasKey: string;
  readonly installKey: string;
  readonly installId: string;
  readonly kind: "installation" | "user" | "username";
  readonly normalizedAlias: string;
  readonly originalAlias: string;
}
type StoredAlias = {
  alias_key: string;
  install_key: string;
  identity: unknown;
};
const parseAlias = (row: StoredAlias): PostgresInsightsAliasRow => {
  const identity = row.identity;
  if (
    !Array.isArray(identity) ||
    identity.length !== 4 ||
    !["installation", "user", "username"].includes(identity[0]) ||
    typeof identity[1] !== "string" ||
    typeof identity[2] !== "string" ||
    typeof identity[3] !== "string" ||
    identity[1] !== identity[1].toLowerCase() ||
    identity[1] !== identity[2].toLowerCase() ||
    hash(JSON.stringify(identity)) !== row.alias_key ||
    hash(JSON.stringify(identity[3])) !== row.install_key
  )
    return invalid();
  return {
    aliasKey: row.alias_key,
    installKey: row.install_key,
    installId: identity[3],
    kind: identity[0],
    normalizedAlias: identity[1],
    originalAlias: identity[2],
  };
};

export const assertPostgresInsightsAliasIndex = async (
  db: QueryExecutorProvider,
): Promise<void> => {
  await assertPostgresInsightsTableLayouts(db, [
    {
      table: aliases,
      columns: [
        "job_id:uuid:true:false::::",
        "alias_key:text:true:false::C::",
        "install_key:text:true:false::default::",
        "identity:json:true:false::::",
      ],
      constraints: ["PRIMARY KEY (job_id, alias_key)"],
    },
  ]);
  const result = await sql<{ ready: boolean }>`select exists (
    select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
    join pg_am am on am.oid = c.relam
    where i.indexrelid = to_regclass(${`${aliases}_pkey`}) and i.indrelid = to_regclass(${aliases})
      and i.indisvalid and i.indisready and i.indisunique
      and i.indnkeyatts = 2 and i.indnatts = 2
      and i.indexprs is null and i.indpred is null and am.amname = 'btree'
      and pg_get_indexdef(i.indexrelid, 1, false) = 'job_id'
      and pg_get_indexdef(i.indexrelid, 2, false) = 'alias_key'
      and not exists (select 1 from unnest(i.indoption) bits where bits <> 0)
      and not exists (select 1 from unnest(i.indclass) class_id
        join pg_opclass opclass on opclass.oid = class_id where not opclass.opcdefault)
      and not exists (select 1 from unnest(i.indcollation) collation_id
        join pg_collation co on co.oid = collation_id where co.collname <> 'C')
  ) as ready`.execute(db);
  if (!result.rows[0]?.ready) throw new InsightsQueryNotReadyError();
};

/** Global overview workers commit these aliases and the source checkpoint together. */
export const savePostgresInsightsAliases = async <TDatabase>(
  db: Transaction<TDatabase>,
  jobId: string,
  event: BundleEventRow,
): Promise<void> => {
  assertJob(jobId);
  if (!db.isTransaction) throw new DatabasePluginInputError("invalid-query");
  assertPostgresInsightsStoredEvent(event);
  const expected = new Map<string, string>();
  for (const [kind, value] of [
    ["installation", event.install_id],
    ["user", event.user_id],
    ["username", event.username],
  ] as const) {
    if (value === null) continue;
    const identity = JSON.stringify([
      kind,
      value.toLowerCase(),
      value,
      event.install_id,
    ]);
    const aliasKey = hash(identity);
    if (expected.has(aliasKey) && expected.get(aliasKey) !== identity)
      invalid();
    expected.set(aliasKey, identity);
  }
  const installKey = hash(JSON.stringify(event.install_id));
  await sql`insert into ${sql.table(aliases)}(job_id,alias_key,install_key,identity)
    values ${sql.join(
      [...expected].map(
        ([aliasKey, identity]) =>
          sql`(${jobId}::uuid,${aliasKey},${installKey},${identity}::json)`,
      ),
    )}
    on conflict (job_id,alias_key) do nothing`.execute(db);
  const result =
    await sql<StoredAlias>`select alias_key,install_key,identity from ${sql.table(aliases)}
    where job_id = ${jobId}::uuid and alias_key in (${sql.join([...expected.keys()])})
    limit ${expected.size}`.execute(db);
  if (result.rows.length !== expected.size) invalid();
  for (const row of result.rows) {
    const parsed = parseAlias(row);
    if (expected.get(parsed.aliasKey) !== JSON.stringify(row.identity))
      invalid();
    expected.delete(parsed.aliasKey);
  }
  if (expected.size !== 0) invalid();
};

export const readPostgresInsightsAliasPage = async (
  db: QueryExecutorProvider,
  jobId: string,
  afterKey: string | null,
  limit: number,
): Promise<readonly PostgresInsightsAliasRow[]> => {
  assertJob(jobId);
  if (
    (afterKey !== null &&
      (typeof afterKey !== "string" || !hashPattern.test(afterKey))) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    throw new DatabasePluginInputError("invalid-query");
  await assertPostgresInsightsAliasIndex(db);
  const result =
    await sql<StoredAlias>`select alias_key,install_key,identity from ${sql.table(aliases)}
    where job_id = ${jobId}::uuid ${afterKey === null ? sql`` : sql`and alias_key > ${afterKey}`}
    order by alias_key limit ${limit}`.execute(db);
  if (result.rows.length > limit) invalid();
  let previous = afterKey;
  return result.rows.map((row) => {
    const parsed = parseAlias(row);
    if (previous !== null && parsed.aliasKey <= previous) invalid();
    previous = parsed.aliasKey;
    return parsed;
  });
};
