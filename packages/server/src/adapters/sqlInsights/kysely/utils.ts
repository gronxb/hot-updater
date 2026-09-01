import { createHash, randomUUID } from "node:crypto";

import {
  DatabasePluginInputError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import {
  assertInsightsEventRow,
  getInsightsInstallationOrderKey,
} from "@hot-updater/plugin-core/internal";
import { sql, type QueryExecutorProvider } from "kysely";

import type { SQLProvider as KyselySQLProvider } from "../../kysely";

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const installationKey = async (installId: string): Promise<string> =>
  Buffer.from(await getInsightsInstallationOrderKey(installId)).toString("hex");

export const newOpaqueId = (): string => randomUUID();

export const toSafeInteger = (value: unknown): number => {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return parsed;
};

export const readRawEvent = (value: unknown): BundleEventRow => {
  if (typeof value !== "string") {
    throw new DatabasePluginInputError("invalid-result");
  }
  let event: unknown;
  try {
    event = JSON.parse(value);
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
  assertInsightsEventRow(event);
  return event;
};

export const insertIgnore = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  table: string,
  row: Readonly<Record<string, unknown>>,
): Promise<boolean> => {
  const entries = Object.entries(row);
  const columns = sql.join(entries.map(([column]) => sql.ref(column)));
  const values = sql.join(entries.map(([, value]) => value));
  const firstColumn = entries[0]?.[0];
  if (!firstColumn) throw new DatabasePluginInputError("invalid-result");
  const query =
    provider === "mysql"
      ? sql`insert into ${sql.table(table)} (${columns}) values (${values})
          on duplicate key update ${sql.ref(firstColumn)} = ${sql.ref(firstColumn)}`
      : provider === "sqlite"
        ? sql`insert or ignore into ${sql.table(table)} (${columns}) values (${values})`
        : sql`insert into ${sql.table(table)} (${columns}) values (${values}) on conflict do nothing`;
  const result = await query.execute(db);
  return Number(result.numAffectedRows ?? 0) > 0;
};

export const executeSerializable = async <TDatabase, TResult>(
  db: import("kysely").Kysely<TDatabase>,
  provider: KyselySQLProvider,
  callback: (transaction: QueryExecutorProvider) => Promise<TResult>,
): Promise<TResult> => {
  const attempts = provider === "cockroachdb" ? 5 : 1;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction().execute(callback);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "";
      if (attempt + 1 >= attempts || code !== "40001") throw error;
    }
  }
};

export const lockState = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
): Promise<void> => {
  if (provider === "sqlite") {
    await sql`update private_hot_updater_kysely_insights_state set next_seq = next_seq where id = 1`.execute(
      db,
    );
    return;
  }
  await sql`select id from private_hot_updater_kysely_insights_state where id = 1 for update`.execute(
    db,
  );
};

export const lockRow = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  table: string,
  keyColumn: string,
  keyValue: string,
): Promise<void> => {
  if (provider === "sqlite") {
    await sql`update ${sql.table(table)} set ${sql.ref(keyColumn)} = ${sql.ref(
      keyColumn,
    )} where ${sql.ref(keyColumn)} = ${keyValue}`.execute(db);
    return;
  }
  await sql`select ${sql.ref(keyColumn)} from ${sql.table(table)}
    where ${sql.ref(keyColumn)} = ${keyValue} for update`.execute(db);
};

export const escapedLike = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
