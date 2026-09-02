import { createHash } from "node:crypto";

import {
  DatabasePluginInputError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import {
  assertInsightsEventContract,
  assertInsightsInstallationIdentityDigest,
  canonicalInsightsJson,
  getCanonicalInsightsJsonByteLength,
  getInsightsInstallationOrderKey,
} from "@hot-updater/plugin-core/internal";
import { sql, type SQL } from "drizzle-orm";

import type { DrizzleProvider } from "../../drizzle";
import {
  mutateDrizzleInsights,
  queryDrizzleInsights,
  type DrizzleDB,
} from "../../drizzleLazyDB";
import { DRIZZLE_INSIGHTS_EVENTS, DRIZZLE_INSIGHTS_LIVE } from "./schema";

export type DrizzleInsightsStoredEvent = {
  readonly seq: number;
  readonly event_id: string;
  readonly event_order_key: Uint8Array;
  readonly received_at_ms: number;
  readonly event_type: BundleEventRow["type"];
  readonly install_id: string;
  readonly install_key: string;
  readonly user_alias: string | null;
  readonly username_alias: string | null;
  readonly from_bundle_id: string | null;
  readonly from_bundle_key: string | null;
  readonly to_bundle_id: string;
  readonly to_bundle_key: string;
  readonly raw_event: string;
};

export const drizzleInsightsRawEventColumns = [
  "id",
  "type",
  "install_id",
  "user_id",
  "username",
  "from_release_id",
  "from_bundle_id",
  "to_release_id",
  "to_bundle_id",
  "platform",
  "app_version",
  "channel",
  "cohort",
  "update_strategy",
  "fingerprint_hash",
  "sdk_version",
  "received_at_ms",
] as const satisfies readonly (keyof BundleEventRow)[];

export type DrizzleInsightsRawEventColumn =
  (typeof drizzleInsightsRawEventColumns)[number];

const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};

const integer = (value: unknown): number => {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0)
    return invalid();
  return parsed;
};

const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return invalid();
};

export const drizzleInsightsEventOrderKey = (id: string): Uint8Array => {
  const value = Buffer.from(id.replaceAll("-", ""), "hex");
  if (value.length !== 16) return invalid();
  return value;
};

export const drizzleInsightsInstallKey = async (
  installId: string,
): Promise<string> =>
  Buffer.from(await getInsightsInstallationOrderKey(installId)).toString("hex");

export const drizzleInsightsSemanticKey = (value: unknown): string =>
  createHash("sha256").update(canonicalInsightsJson(value)).digest("hex");

export const readDrizzleInsightsEvent = (value: unknown): BundleEventRow => {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return invalid();
  }
  assertInsightsEventContract(parsed);
  return parsed;
};

export const readDrizzleInsightsStoredEvent = (
  row: Record<string, unknown>,
): DrizzleInsightsStoredEvent & { readonly event: BundleEventRow } => {
  const event = readDrizzleInsightsEvent(row["raw_event"]);
  const eventType = row["event_type"];
  if (
    eventType !== "UNCHANGED" &&
    eventType !== "UPDATE_APPLIED" &&
    eventType !== "RECOVERED" &&
    eventType !== "RELEASE_ADOPTED"
  ) {
    return invalid();
  }
  const stored: DrizzleInsightsStoredEvent = {
    seq: integer(row["seq"]),
    event_id: String(row["event_id"]),
    event_order_key: bytes(row["event_order_key"]),
    received_at_ms: integer(row["received_at_ms"]),
    event_type: eventType,
    install_id: String(row["install_id"]),
    install_key: String(row["install_key"]),
    user_alias: row["user_alias"] === null ? null : String(row["user_alias"]),
    username_alias:
      row["username_alias"] === null ? null : String(row["username_alias"]),
    from_bundle_id:
      row["from_bundle_id"] === null ? null : String(row["from_bundle_id"]),
    from_bundle_key:
      row["from_bundle_key"] === null ? null : String(row["from_bundle_key"]),
    to_bundle_id: String(row["to_bundle_id"]),
    to_bundle_key: String(row["to_bundle_key"]),
    raw_event: String(row["raw_event"]),
  };
  if (
    stored.event_id !== event.id ||
    Buffer.compare(
      stored.event_order_key,
      drizzleInsightsEventOrderKey(event.id),
    ) !== 0 ||
    stored.received_at_ms !== event.received_at_ms ||
    stored.event_type !== event.type ||
    stored.install_id !== event.install_id ||
    stored.user_alias !== (event.user_id?.toLowerCase() ?? null) ||
    stored.username_alias !== (event.username?.toLowerCase() ?? null) ||
    stored.from_bundle_id !== event.from_bundle_id ||
    stored.from_bundle_key !==
      (event.from_bundle_id === null
        ? null
        : drizzleInsightsSemanticKey(["bundle", event.from_bundle_id])) ||
    stored.to_bundle_id !== event.to_bundle_id ||
    stored.to_bundle_key !==
      drizzleInsightsSemanticKey(["bundle", event.to_bundle_id])
  ) {
    return invalid();
  }
  return { ...stored, event };
};

export const assertDrizzleInsightsStoredInstallation = async (
  stored: Pick<DrizzleInsightsStoredEvent, "install_id" | "install_key">,
): Promise<void> =>
  assertInsightsInstallationIdentityDigest({
    digestHex: stored.install_key,
    installId: stored.install_id,
  });

export const toDrizzleInsightsStoredEvent = async (
  event: BundleEventRow,
): Promise<Omit<DrizzleInsightsStoredEvent, "seq">> => {
  assertInsightsEventContract(event);
  return {
    event_id: event.id,
    event_order_key: drizzleInsightsEventOrderKey(event.id),
    received_at_ms: event.received_at_ms,
    event_type: event.type,
    install_id: event.install_id,
    install_key: await drizzleInsightsInstallKey(event.install_id),
    user_alias: event.user_id?.toLowerCase() ?? null,
    username_alias: event.username?.toLowerCase() ?? null,
    from_bundle_id: event.from_bundle_id,
    from_bundle_key:
      event.from_bundle_id === null
        ? null
        : drizzleInsightsSemanticKey(["bundle", event.from_bundle_id]),
    to_bundle_id: event.to_bundle_id,
    to_bundle_key: drizzleInsightsSemanticKey(["bundle", event.to_bundle_id]),
    raw_event: canonicalInsightsJson(event),
  };
};

const values = (event: BundleEventRow): readonly unknown[] =>
  drizzleInsightsRawEventColumns.map((field) => event[field]);

export const insertDrizzleRawEvent = async (
  db: DrizzleDB,
  event: BundleEventRow,
): Promise<void> => {
  await mutateDrizzleInsights(
    db,
    sql`insert into ${sql.identifier("bundle_events")}
      (${sql.join(drizzleInsightsRawEventColumns.map(sql.identifier), sql.raw(","))})
      values (${sql.join(
        values(event).map((value) => sql`${value}`),
        sql.raw(","),
      )})`,
  );
};

const sourceInsert = (
  provider: DrizzleProvider,
  event: Omit<DrizzleInsightsStoredEvent, "seq">,
  ignore: boolean,
): SQL => {
  const base = sql`insert into ${sql.identifier(DRIZZLE_INSIGHTS_EVENTS)}
    (event_id,event_order_key,received_at_ms,event_type,install_id,install_key,user_alias,
      username_alias,from_bundle_id,from_bundle_key,to_bundle_id,to_bundle_key,raw_event)
    values (${event.event_id},${event.event_order_key},${event.received_at_ms},${event.event_type},
      ${event.install_id},${event.install_key},${event.user_alias},
      ${event.username_alias},${event.from_bundle_id},${event.from_bundle_key},${event.to_bundle_id},${event.to_bundle_key},
      ${event.raw_event})`;
  if (!ignore) return base;
  return provider === "mysql"
    ? sql`insert ignore into ${sql.identifier(DRIZZLE_INSIGHTS_EVENTS)}
      (event_id,event_order_key,received_at_ms,event_type,install_id,install_key,user_alias,
        username_alias,from_bundle_id,from_bundle_key,to_bundle_id,to_bundle_key,raw_event)
      values (${event.event_id},${event.event_order_key},${event.received_at_ms},${event.event_type},
        ${event.install_id},${event.install_key},${event.user_alias},
        ${event.username_alias},${event.from_bundle_id},${event.from_bundle_key},${event.to_bundle_id},${event.to_bundle_key},
        ${event.raw_event})`
    : sql`${base} on conflict(event_id) do nothing`;
};

const assertNoInstallKeyCollision = async (
  db: DrizzleDB,
  event: Omit<DrizzleInsightsStoredEvent, "seq">,
): Promise<void> => {
  const existing = await queryDrizzleInsights<{ install_id: unknown }>(
    db,
    sql`select install_id from ${sql.identifier(DRIZZLE_INSIGHTS_LIVE)}
      where install_key=${event.install_key}`,
  );
  if (
    existing.length > 1 ||
    (existing[0] !== undefined && existing[0].install_id !== event.install_id)
  ) {
    throw new DatabasePluginInputError("invalid-data");
  }
};

const upsertLive = (
  provider: DrizzleProvider,
  event: Omit<DrizzleInsightsStoredEvent, "seq">,
): SQL => {
  const insert = sql`insert into ${sql.identifier(DRIZZLE_INSIGHTS_LIVE)}
    (install_key,install_id,event_id,event_order_key,received_at_ms,raw_event)
    values (${event.install_key},${event.install_id},${event.event_id},
      ${event.event_order_key},${event.received_at_ms},${event.raw_event})`;
  if (provider === "mysql") {
    return sql`${insert} on duplicate key update
      raw_event=if(received_at_ms < values(received_at_ms) or
        (received_at_ms = values(received_at_ms) and event_order_key < values(event_order_key)),
        values(raw_event),raw_event),
      event_id=if(received_at_ms < values(received_at_ms) or
        (received_at_ms = values(received_at_ms) and event_order_key < values(event_order_key)),
        values(event_id),event_id),
      event_order_key=if(received_at_ms < values(received_at_ms) or
        (received_at_ms = values(received_at_ms) and event_order_key < values(event_order_key)),
        values(event_order_key),event_order_key),
      received_at_ms=greatest(received_at_ms,values(received_at_ms))`;
  }
  return sql`${insert} on conflict(install_key) do update set
    install_id=excluded.install_id,event_id=excluded.event_id,
    event_order_key=excluded.event_order_key,
    received_at_ms=excluded.received_at_ms,raw_event=excluded.raw_event
    where ${sql.identifier(DRIZZLE_INSIGHTS_LIVE)}.received_at_ms < excluded.received_at_ms
      or (${sql.identifier(DRIZZLE_INSIGHTS_LIVE)}.received_at_ms = excluded.received_at_ms
        and ${sql.identifier(DRIZZLE_INSIGHTS_LIVE)}.event_order_key < excluded.event_order_key)`;
};

export const persistDrizzleInsightsProjection = async (
  db: DrizzleDB,
  provider: DrizzleProvider,
  event: BundleEventRow,
  ignoreSourceConflict: boolean,
): Promise<void> => {
  const stored = await toDrizzleInsightsStoredEvent(event);
  await assertNoInstallKeyCollision(db, stored);
  await mutateDrizzleInsights(
    db,
    sourceInsert(provider, stored, ignoreSourceConflict),
  );
  await mutateDrizzleInsights(db, upsertLive(provider, stored));
};

export const getDrizzleInsightsEventBytes = (event: BundleEventRow): number =>
  getCanonicalInsightsJsonByteLength(event);
