import type { BundleEventRow } from "@hot-updater/plugin-core";
import {
  assertInsightsEventContract,
  canonicalInsightsJson,
} from "@hot-updater/plugin-core/internal";

import type { ORMSQLProvider } from "../../../db/types";
import {
  getPrismaBundleEventDelegate,
  prismaBundleEventFields,
} from "../../prismaRows";
import {
  executePrismaInsights,
  PrismaInsightsSql,
  PrismaInsightsConfigurationError,
  queryPrismaInsights,
  type PrismaInsightsRawClient,
  type PrismaInsightsStatement,
} from "./client";
import {
  getPrismaInsightsAliases,
  prismaInsightsEventOrder,
  prismaInsightsInstallKey,
} from "./codec";
import {
  PRISMA_INSIGHTS_ALIASES,
  PRISMA_INSIGHTS_EVENTS,
  PRISMA_INSIGHTS_LIVE,
  PRISMA_INSIGHTS_SOURCE,
} from "./schema";
import { readPrismaInsightsState } from "./source";

const integer = (value: bigint | number | string): bigint => {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed < 1n)
    throw new PrismaInsightsConfigurationError("invalid source generation");
  return parsed;
};

const allocateGeneration = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  count = 1,
): Promise<bigint> => {
  if (!Number.isSafeInteger(count) || count < 1 || count > 200) {
    throw new PrismaInsightsConfigurationError("invalid generation range");
  }
  if (provider === "mysql") {
    const changed = await client.$executeRawUnsafe(
      `update ${PRISMA_INSIGHTS_SOURCE}
       set generation=generation+? where id=1`,
      count,
    );
    if (changed !== 1) {
      throw new PrismaInsightsConfigurationError(
        "Prisma Insights source is not ready",
      );
    }
    const rows = await client.$queryRawUnsafe<
      { readonly generation: bigint | number | string }[]
    >(`select generation from ${PRISMA_INSIGHTS_SOURCE} where id=1`);
    const generation = rows[0]?.generation;
    if (generation === undefined) {
      throw new PrismaInsightsConfigurationError(
        "Prisma Insights state is missing",
      );
    }
    return integer(generation);
  }
  const returning =
    provider === "mssql"
      ? `update ${PRISMA_INSIGHTS_SOURCE} set generation=generation+${count}
         output inserted.generation as generation
         where id=1`
      : `update ${PRISMA_INSIGHTS_SOURCE} set generation=generation+${count}
         where id=1
         returning generation`;
  const rows =
    await client.$queryRawUnsafe<
      { readonly generation: bigint | number | string }[]
    >(returning);
  const generation = rows[0]?.generation;
  if (generation === undefined) {
    throw new PrismaInsightsConfigurationError(
      "Prisma Insights source is not ready",
    );
  }
  return integer(generation);
};

const insertStatement = (
  provider: ORMSQLProvider,
  table: string,
  columns: readonly string[],
  values: readonly unknown[],
): PrismaInsightsStatement => {
  const sql = new PrismaInsightsSql(provider);
  return sql.statement(
    `insert into ${table} (${columns.join(",")}) values (${values
      .map((value) => sql.value(value))
      .join(",")})`,
  );
};

const insertMany = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): Promise<void> => {
  const maxRows = Math.max(1, Math.floor(1_800 / columns.length));
  for (let offset = 0; offset < rows.length; offset += maxRows) {
    const chunk = rows.slice(offset, offset + maxRows);
    const sql = new PrismaInsightsSql(provider);
    const tuples = chunk.map(
      (row) => `(${row.map((value) => sql.value(value)).join(",")})`,
    );
    const inserted = await executePrismaInsights(
      client,
      sql.statement(
        `insert into ${table} (${columns.join(",")}) values ${tuples.join(",")}`,
      ),
    );
    if (inserted !== chunk.length) {
      throw new PrismaInsightsConfigurationError(
        `Prisma Insights batch insert mismatch for ${table}`,
      );
    }
  }
};

const readByKeys = async <TRow>(
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  table: string,
  columns: readonly string[],
  keyColumn: string,
  keys: readonly unknown[],
): Promise<TRow[]> => {
  const result: TRow[] = [];
  for (let offset = 0; offset < keys.length; offset += 500) {
    const chunk = keys.slice(offset, offset + 500);
    const sql = new PrismaInsightsSql(provider);
    result.push(
      ...(await queryPrismaInsights<TRow[]>(
        client,
        sql.statement(
          `select ${columns.join(",")} from ${table}
           where ${keyColumn} in (${chunk.map((key) => sql.value(key)).join(",")})`,
        ),
      )),
    );
  }
  return result;
};

const updateLiveStatement = (
  provider: ORMSQLProvider,
  row: BundleEventRow,
  generation: bigint,
  eventJson: string,
): PrismaInsightsStatement => {
  const sql = new PrismaInsightsSql(provider);
  const values: readonly [string, unknown][] = [
    ["install_id", row.install_id],
    ["event_id", row.id],
    ["received_at_ms", row.received_at_ms],
    ["event_order", prismaInsightsEventOrder(row.id)],
    ["source_generation", generation],
    ["event_json", eventJson],
  ];
  const assignments = values.map(
    ([column, value]) => `${column}=${sql.value(value)}`,
  );
  const key = sql.value(prismaInsightsInstallKey(row.install_id));
  return sql.statement(
    `update ${PRISMA_INSIGHTS_LIVE} set ${assignments.join(",")} where install_key=${key}`,
  );
};

type StoredLive = {
  install_id: string;
  event_id: string;
  received_at_ms: number;
  event_order: Uint8Array;
};

const upsertLive = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  row: BundleEventRow,
  generation: bigint,
  eventJson: string,
): Promise<void> => {
  const key = prismaInsightsInstallKey(row.install_id);
  const sql = new PrismaInsightsSql(provider);
  const saved = await queryPrismaInsights<StoredLive[]>(
    client,
    sql.statement(
      `select install_id,event_id,received_at_ms,event_order
       from ${PRISMA_INSIGHTS_LIVE} where install_key=${sql.value(key)}`,
    ),
  );
  const current = saved[0];
  if (
    saved.length > 1 ||
    (current !== undefined && current.install_id !== row.install_id)
  ) {
    throw new PrismaInsightsConfigurationError(
      "Prisma Insights installation hash collision",
    );
  }
  if (current === undefined) {
    await executePrismaInsights(
      client,
      insertStatement(
        provider,
        PRISMA_INSIGHTS_LIVE,
        [
          "install_key",
          "install_id",
          "event_id",
          "received_at_ms",
          "event_order",
          "source_generation",
          "event_json",
        ],
        [
          key,
          row.install_id,
          row.id,
          row.received_at_ms,
          prismaInsightsEventOrder(row.id),
          generation,
          eventJson,
        ],
      ),
    );
    return;
  }
  if (
    current.received_at_ms > row.received_at_ms ||
    (current.received_at_ms === row.received_at_ms &&
      current.event_id >= row.id)
  ) {
    return;
  }
  if (
    !Buffer.from(current.event_order).equals(
      prismaInsightsEventOrder(current.event_id),
    )
  ) {
    throw new PrismaInsightsConfigurationError(
      "Prisma Insights live row is corrupt",
    );
  }
  const updated = await executePrismaInsights(
    client,
    updateLiveStatement(provider, row, generation, eventJson),
  );
  if (updated !== 1) {
    throw new PrismaInsightsConfigurationError(
      "Prisma Insights live update lost ownership",
    );
  }
};

type StoredAlias = {
  alias_kind: string;
  normalized_alias: string;
  original_alias: string;
  install_key: Uint8Array;
  install_id: string;
};

const insertAliases = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  row: BundleEventRow,
  generation: bigint,
): Promise<void> => {
  const installKey = prismaInsightsInstallKey(row.install_id);
  for (const alias of getPrismaInsightsAliases(row)) {
    const sql = new PrismaInsightsSql(provider);
    const saved = await queryPrismaInsights<StoredAlias[]>(
      client,
      sql.statement(
        `select alias_kind,normalized_alias,original_alias,install_key,install_id
         from ${PRISMA_INSIGHTS_ALIASES} where alias_key=${sql.value(alias.aliasKey)}`,
      ),
    );
    const current = saved[0];
    if (saved.length > 1) {
      throw new PrismaInsightsConfigurationError(
        "Prisma Insights alias is corrupt",
      );
    }
    if (current !== undefined) {
      if (
        current.alias_kind !== alias.kind ||
        current.normalized_alias !== alias.normalized ||
        current.install_id !== row.install_id ||
        !Buffer.from(current.install_key).equals(installKey)
      ) {
        throw new PrismaInsightsConfigurationError(
          "Prisma Insights alias hash collision",
        );
      }
      continue;
    }
    await executePrismaInsights(
      client,
      insertStatement(
        provider,
        PRISMA_INSIGHTS_ALIASES,
        [
          "alias_key",
          "alias_kind",
          "normalized_alias",
          "original_alias",
          "install_key",
          "install_id",
          "source_generation",
        ],
        [
          alias.aliasKey,
          alias.kind,
          alias.normalized,
          alias.original,
          installKey,
          row.install_id,
          generation,
        ],
      ),
    );
  }
};

const pickDatabaseEvent = (row: BundleEventRow): BundleEventRow =>
  Object.fromEntries(
    prismaBundleEventFields.map((field) => [field, row[field]]),
  ) as unknown as BundleEventRow;

/** Must run inside the caller's serializable Prisma callback transaction. */
export const appendPrismaInsightsEvent = async (
  client: PrismaInsightsRawClient & object,
  provider: ORMSQLProvider,
  databaseNamespace: string,
  row: BundleEventRow,
): Promise<void> => {
  assertInsightsEventContract(row);
  const eventJson = canonicalInsightsJson(row);
  if (provider === "sqlite") {
    const locked = await client.$executeRawUnsafe(
      `update ${PRISMA_INSIGHTS_SOURCE}
       set generation=generation where id=1`,
    );
    if (locked !== 1) {
      throw new PrismaInsightsConfigurationError(
        "Prisma Insights source is not ready",
      );
    }
  }
  const state = await readPrismaInsightsState(client, databaseNamespace);
  if (state.failedReason !== null) {
    throw new PrismaInsightsConfigurationError(
      "Prisma Insights source is not ready",
    );
  }
  await recordPrismaInsightsEvent(client, provider, row, eventJson, true);
};

/** Migration path for a raw row which already exists in bundle_events. */
export const backfillPrismaInsightsEvent = async (
  client: PrismaInsightsRawClient & object,
  provider: ORMSQLProvider,
  row: BundleEventRow,
): Promise<void> => {
  assertInsightsEventContract(row);
  const eventJson = canonicalInsightsJson(row);
  const sql = new PrismaInsightsSql(provider);
  const stored = await queryPrismaInsights<{ event_json: string }[]>(
    client,
    sql.statement(
      `select event_json from ${PRISMA_INSIGHTS_EVENTS}
       where event_id=${sql.value(row.id)}`,
    ),
  );
  if (stored.length > 1)
    throw new PrismaInsightsConfigurationError(
      "Prisma Insights event index is corrupt",
    );
  if (stored[0] !== undefined) {
    if (stored[0].event_json !== eventJson)
      throw new PrismaInsightsConfigurationError(
        "Prisma Insights event ID collision",
      );
    return;
  }
  await recordPrismaInsightsEvent(client, provider, row, eventJson, false);
};

/** Bounded migration writer. The caller owns the Serializable transaction. */
export const backfillPrismaInsightsEvents = async (
  client: PrismaInsightsRawClient & object,
  provider: ORMSQLProvider,
  rows: readonly BundleEventRow[],
): Promise<void> => {
  if (rows.length === 0 || rows.length > 200) {
    throw new PrismaInsightsConfigurationError("invalid backfill batch");
  }
  const canonical = rows.map((row) => {
    assertInsightsEventContract(row);
    return { row, eventJson: canonicalInsightsJson(row) };
  });
  const storedEvents = await readByKeys<{
    event_id: string;
    event_json: string;
  }>(
    client,
    provider,
    PRISMA_INSIGHTS_EVENTS,
    ["event_id", "event_json"],
    "event_id",
    canonical.map(({ row }) => row.id),
  );
  const storedById = new Map(
    storedEvents.map((stored) => [stored.event_id, stored.event_json]),
  );
  const fresh = canonical.filter(({ row, eventJson }) => {
    const stored = storedById.get(row.id);
    if (stored === undefined) return true;
    if (stored !== eventJson) {
      throw new PrismaInsightsConfigurationError(
        "Prisma Insights event ID collision",
      );
    }
    return false;
  });
  if (fresh.length === 0) return;

  const latestByInstall = new Map<
    string,
    { row: BundleEventRow; eventJson: string; installKey: Buffer }
  >();
  for (const item of fresh) {
    const installKey = prismaInsightsInstallKey(item.row.install_id);
    const digest = installKey.toString("hex");
    const current = latestByInstall.get(digest);
    if (current && current.row.install_id !== item.row.install_id) {
      throw new PrismaInsightsConfigurationError(
        "Prisma Insights installation hash collision",
      );
    }
    if (
      !current ||
      current.row.received_at_ms < item.row.received_at_ms ||
      (current.row.received_at_ms === item.row.received_at_ms &&
        current.row.id < item.row.id)
    ) {
      latestByInstall.set(digest, { ...item, installKey });
    }
  }
  const storedLive = await readByKeys<StoredLive & { install_key: Uint8Array }>(
    client,
    provider,
    PRISMA_INSIGHTS_LIVE,
    ["install_key", "install_id", "event_id", "received_at_ms", "event_order"],
    "install_key",
    [...latestByInstall.values()].map(({ installKey }) => installKey),
  );
  const liveByKey = new Map(
    storedLive.map((stored) => [
      Buffer.from(stored.install_key).toString("hex"),
      stored,
    ]),
  );
  for (const [digest, item] of latestByInstall) {
    const stored = liveByKey.get(digest);
    if (stored === undefined) continue;
    if (
      stored.install_id !== item.row.install_id ||
      !Buffer.from(stored.event_order).equals(
        prismaInsightsEventOrder(stored.event_id),
      )
    ) {
      throw new PrismaInsightsConfigurationError(
        "Prisma Insights live identity mismatch",
      );
    }
  }

  const aliases = new Map<
    string,
    ReturnType<typeof getPrismaInsightsAliases>[number] & {
      installKey: Buffer;
      installId: string;
      eventId: string;
    }
  >();
  for (const { row } of fresh) {
    const installKey = prismaInsightsInstallKey(row.install_id);
    for (const alias of getPrismaInsightsAliases(row)) {
      const digest = alias.aliasKey.toString("hex");
      const current = aliases.get(digest);
      if (
        current &&
        (current.kind !== alias.kind ||
          current.normalized !== alias.normalized ||
          current.installId !== row.install_id ||
          !current.installKey.equals(installKey))
      ) {
        throw new PrismaInsightsConfigurationError(
          "Prisma Insights alias hash collision",
        );
      }
      aliases.set(digest, {
        ...alias,
        installKey,
        installId: row.install_id,
        eventId: row.id,
      });
    }
  }
  const storedAliases = await readByKeys<
    StoredAlias & { alias_key: Uint8Array }
  >(
    client,
    provider,
    PRISMA_INSIGHTS_ALIASES,
    [
      "alias_key",
      "alias_kind",
      "normalized_alias",
      "original_alias",
      "install_key",
      "install_id",
    ],
    "alias_key",
    [...aliases.values()].map(({ aliasKey }) => aliasKey),
  );
  const storedAliasKeys = new Set<string>();
  for (const stored of storedAliases) {
    const digest = Buffer.from(stored.alias_key).toString("hex");
    const expected = aliases.get(digest);
    if (
      !expected ||
      stored.alias_kind !== expected.kind ||
      stored.normalized_alias !== expected.normalized ||
      stored.install_id !== expected.installId ||
      !Buffer.from(stored.install_key).equals(expected.installKey)
    ) {
      throw new PrismaInsightsConfigurationError(
        "Prisma Insights alias identity mismatch",
      );
    }
    storedAliasKeys.add(digest);
  }

  const finalGeneration = await allocateGeneration(
    client,
    provider,
    fresh.length,
  );
  const firstGeneration = finalGeneration - BigInt(fresh.length) + 1n;
  const generations = new Map(
    fresh.map(({ row }, index) => [row.id, firstGeneration + BigInt(index)]),
  );
  await insertMany(
    client,
    provider,
    PRISMA_INSIGHTS_EVENTS,
    [
      "event_id",
      "source_generation",
      "received_at_ms",
      "event_order",
      "install_key",
      "install_id",
      "type",
      "to_bundle_id",
      "from_bundle_id",
      "event_json",
    ],
    fresh.map(({ row, eventJson }) => [
      row.id,
      generations.get(row.id)!,
      row.received_at_ms,
      prismaInsightsEventOrder(row.id),
      prismaInsightsInstallKey(row.install_id),
      row.install_id,
      row.type,
      row.to_bundle_id,
      row.from_bundle_id,
      eventJson,
    ]),
  );

  const missingLive: unknown[][] = [];
  for (const [digest, item] of latestByInstall) {
    const generation = generations.get(item.row.id)!;
    const stored = liveByKey.get(digest);
    if (stored === undefined) {
      missingLive.push([
        item.installKey,
        item.row.install_id,
        item.row.id,
        item.row.received_at_ms,
        prismaInsightsEventOrder(item.row.id),
        generation,
        item.eventJson,
      ]);
    } else if (
      stored.received_at_ms < item.row.received_at_ms ||
      (stored.received_at_ms === item.row.received_at_ms &&
        stored.event_id < item.row.id)
    ) {
      const updated = await executePrismaInsights(
        client,
        updateLiveStatement(provider, item.row, generation, item.eventJson),
      );
      if (updated !== 1) {
        throw new PrismaInsightsConfigurationError(
          "Prisma Insights live batch update lost ownership",
        );
      }
    }
  }
  await insertMany(
    client,
    provider,
    PRISMA_INSIGHTS_LIVE,
    [
      "install_key",
      "install_id",
      "event_id",
      "received_at_ms",
      "event_order",
      "source_generation",
      "event_json",
    ],
    missingLive,
  );

  await insertMany(
    client,
    provider,
    PRISMA_INSIGHTS_ALIASES,
    [
      "alias_key",
      "alias_kind",
      "normalized_alias",
      "original_alias",
      "install_key",
      "install_id",
      "source_generation",
    ],
    [...aliases.entries()]
      .filter(([digest]) => !storedAliasKeys.has(digest))
      .map(([, alias]) => [
        alias.aliasKey,
        alias.kind,
        alias.normalized,
        alias.original,
        alias.installKey,
        alias.installId,
        generations.get(alias.eventId)!,
      ]),
  );
};

const recordPrismaInsightsEvent = async (
  client: PrismaInsightsRawClient & object,
  provider: ORMSQLProvider,
  row: BundleEventRow,
  eventJson: string,
  insertRaw: boolean,
): Promise<void> => {
  const generation = await allocateGeneration(client, provider);
  await executePrismaInsights(
    client,
    insertStatement(
      provider,
      PRISMA_INSIGHTS_EVENTS,
      [
        "event_id",
        "source_generation",
        "received_at_ms",
        "event_order",
        "install_key",
        "install_id",
        "type",
        "to_bundle_id",
        "from_bundle_id",
        "event_json",
      ],
      [
        row.id,
        generation,
        row.received_at_ms,
        prismaInsightsEventOrder(row.id),
        prismaInsightsInstallKey(row.install_id),
        row.install_id,
        row.type,
        row.to_bundle_id,
        row.from_bundle_id,
        eventJson,
      ],
    ),
  );
  if (insertRaw) {
    await getPrismaBundleEventDelegate(client).create({
      data: pickDatabaseEvent(row),
    });
  }
  await upsertLive(client, provider, row, generation, eventJson);
  await insertAliases(client, provider, row, generation);
};
