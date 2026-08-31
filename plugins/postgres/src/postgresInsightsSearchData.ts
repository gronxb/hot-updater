import { createHash } from "node:crypto";

import {
  DatabasePluginInputError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import { assertInsightsEventRow } from "@hot-updater/plugin-core/internal";
import { sql, type Transaction } from "kysely";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = (identity: string) =>
  createHash("sha256").update(identity).digest("hex");
const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};

/**
 * One set entry per matching installation, never an activity counter. The caller
 * checks report indexes and commits this batch with its leased alias checkpoint.
 * At most two SQL statements and 200 returned identities; no scan or refill.
 */
export const savePostgresInsightsSearchMatches = async <TDatabase>(
  db: Transaction<TDatabase>,
  jobId: string,
  matches: readonly { installKey: string; event: BundleEventRow }[],
): Promise<void> => {
  if (
    !db.isTransaction ||
    typeof jobId !== "string" ||
    !uuid.test(jobId) ||
    !Array.isArray(matches) ||
    matches.length > 200
  )
    throw new DatabasePluginInputError("invalid-query");
  const expected = new Map<string, { identity: string; installId: string }>();
  for (const row of matches) {
    if (typeof row !== "object" || row === null) invalid();
    assertInsightsEventRow(row.event);
    if (row.installKey !== hash(JSON.stringify(row.event.install_id)))
      invalid();
    const identity = JSON.stringify([
      "installationIds",
      "",
      row.event.install_id,
      -1,
    ]);
    const key = hash(identity);
    const prior = expected.get(key);
    if (prior !== undefined && prior.identity !== identity) invalid();
    expected.set(key, { identity, installId: row.event.install_id });
  }
  if (expected.size === 0) return;
  await sql`insert into private_hot_updater_insights_report_counts
    (job_id, count_key, identity, section, metric, label, bucket_start_ms, value)
    values ${sql.join(
      [...expected].map(
        ([key, { identity, installId }]) =>
          sql`(${jobId}::uuid, ${key}, ${identity}::jsonb, 'installationIds', '', ${installId}, -1, 1)`,
      ),
    )}
    on conflict (job_id, count_key) do nothing`.execute(db);
  const saved = await sql<{
    count_key: string;
    identity: unknown;
    section: string;
    metric: string;
    label: string;
    bucket_start_ms: string;
    value: string;
  }>`
    select count_key, identity, section, metric, label, bucket_start_ms::text, value::text
    from private_hot_updater_insights_report_counts
    where job_id = ${jobId}::uuid and count_key in (${sql.join([...expected.keys()])})
    limit ${expected.size}`.execute(db);
  if (saved.rows.length !== expected.size) invalid();
  for (const row of saved.rows) {
    const identity = expected.get(row.count_key);
    if (
      row.value !== "1" ||
      row.section !== "installationIds" ||
      row.metric !== "" ||
      row.bucket_start_ms !== "-1" ||
      identity?.installId !== row.label ||
      identity.identity !== JSON.stringify(row.identity)
    )
      invalid();
    expected.delete(row.count_key);
  }
  if (expected.size !== 0) invalid();
};
