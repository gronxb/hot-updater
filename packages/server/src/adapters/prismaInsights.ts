import type {
  BundleEventRow,
  InsightsCountLatestEventsInput,
  InsightsFindLatestEventsInput,
} from "@hot-updater/plugin-core";
import {
  latestInsightsWhere,
  latestInsightsCountGroups,
} from "@hot-updater/plugin-core/internal";

import type { ORMSQLProvider } from "../db/types";
import { parsePrismaBundleEventRow, PrismaAdapterError } from "./prismaRows";

const headFields = [
  "install_id",
  "id",
  "received_at_ms",
  "user_id",
  "platform",
  "channel",
  "type",
  "from_bundle_id",
  "to_bundle_id",
] as const;

const parameter = (
  provider: ORMSQLProvider,
  index: number,
  field?: string,
): string => {
  if (provider !== "postgresql" && provider !== "cockroachdb") return "?";
  const cast =
    field === "metadata"
      ? "::jsonb"
      : [
            "id",
            "from_release_id",
            "from_bundle_id",
            "to_release_id",
            "to_bundle_id",
          ].includes(field ?? "")
        ? "::uuid"
        : "";
  return `$${index}${cast}`;
};

const headConflict = (provider: ORMSQLProvider): string => {
  const newer =
    "(excluded.received_at_ms > bundle_event_heads.received_at_ms OR (excluded.received_at_ms = bundle_event_heads.received_at_ms AND excluded.id > bundle_event_heads.id))";
  if (provider === "mysql") {
    const mysqlNewer = newer.replace(/excluded\.(\w+)/g, "VALUES($1)");
    // MySQL evaluates assignments from left to right. Update the ordering keys last.
    const fields = [
      ...headFields.filter(
        (field) => !["install_id", "id", "received_at_ms"].includes(field),
      ),
      "id",
      "received_at_ms",
    ];
    return `ON DUPLICATE KEY UPDATE ${fields.map((field) => `${field} = IF(${mysqlNewer}, VALUES(${field}), bundle_event_heads.${field})`).join(", ")}`;
  }
  return `ON CONFLICT (install_id) DO UPDATE SET ${headFields
    .filter((field) => field !== "install_id")
    .map((field) => `${field} = excluded.${field}`)
    .join(", ")} WHERE ${newer}`;
};

const executePrismaInsights = async (
  client: object,
  query: string,
  values: readonly unknown[],
): Promise<void> => {
  if (
    !("$executeRawUnsafe" in client) ||
    typeof client.$executeRawUnsafe !== "function"
  ) {
    throw new PrismaAdapterError("Insights writes require native SQL support");
  }
  await client.$executeRawUnsafe(query, ...values);
};

export const updatePrismaEventHead = (
  client: object,
  provider: ORMSQLProvider,
  event: BundleEventRow,
): Promise<void> =>
  executePrismaInsights(
    client,
    `INSERT INTO bundle_event_heads (${headFields.join(", ")}) VALUES (${headFields.map((field, index) => parameter(provider, index + 1, field)).join(", ")}) ${headConflict(provider)}`,
    headFields.map((field) => event[field]),
  );

/** PostgreSQL clients without callback transactions can publish both rows atomically. */
export const recordPrismaEventWithCte = (
  client: object,
  provider: ORMSQLProvider,
  event: BundleEventRow,
): Promise<void> => {
  if (provider !== "postgresql" && provider !== "cockroachdb") {
    throw new PrismaAdapterError(
      "Insights writes require callback transactions",
    );
  }
  const fields = [
    "id",
    "type",
    "install_id",
    "user_id",
    "from_release_id",
    "from_bundle_id",
    "to_release_id",
    "to_bundle_id",
    "platform",
    "app_version",
    "channel",
    "metadata",
    "received_at_ms",
  ] as const;
  return executePrismaInsights(
    client,
    `WITH inserted AS (INSERT INTO bundle_events (${fields.join(", ")}) VALUES (${fields.map((field, index) => parameter(provider, index + 1, field)).join(", ")}) ON CONFLICT (id) DO NOTHING RETURNING ${headFields.join(", ")}) INSERT INTO bundle_event_heads (${headFields.join(", ")}) SELECT ${headFields.join(", ")} FROM inserted ${headConflict(provider)}`,
    fields.map((field) =>
      field === "metadata" ? JSON.stringify(event[field]) : event[field],
    ),
  );
};

export const queryPrismaLatestEvents = async (
  client: object,
  provider: ORMSQLProvider,
  input: InsightsFindLatestEventsInput | InsightsCountLatestEventsInput,
): Promise<readonly BundleEventRow[] | number> => {
  if (
    !("$queryRawUnsafe" in client) ||
    typeof client.$queryRawUnsafe !== "function"
  ) {
    throw new PrismaAdapterError(
      "Insights reads require native SQL query support",
    );
  }
  const values: unknown[] = [];
  const bind = (value: unknown, field?: string): string => {
    values.push(value);
    return parameter(provider, values.length, field);
  };
  const groups =
    "sinceMs" in input
      ? latestInsightsCountGroups(input)
      : [latestInsightsWhere(input)];
  let firstGroupValues: unknown[] = [];
  const predicates = groups.map((group, index) => {
    const predicate = `(${group
      .map((where) =>
        where.operator === "in" && Array.isArray(where.value)
          ? `${where.field} IN (${where.value.map((value) => bind(value, where.field)).join(", ")})`
          : `${where.field} ${where.operator === "gte" ? ">=" : where.operator === "gt" ? ">" : "="} ${bind(where.value, where.field)}`,
      )
      .join(" AND ")})`;
    if (index === 0) firstGroupValues = values.slice();
    return predicate;
  });

  const counting = "sinceMs" in input;
  const page = counting
    ? ""
    : ` ORDER BY install_id ASC LIMIT ${bind("installId" in input ? 1 : input.limit)}`;
  // Only fixed identifiers/operators enter SQL; every input value is bound.
  let selection = `SELECT ${counting ? "COUNT(*) AS count" : "id, install_id"} FROM bundle_event_heads WHERE (${predicates.join(" OR ")})${page}`;
  if (counting && provider === "mysql" && predicates.length === 2) {
    // Separate ranges let MySQL use each bundle index within one snapshot.
    // IS NOT TRUE also retains rows where the first predicate is NULL.
    selection = `SELECT (SELECT COUNT(*) FROM bundle_event_heads WHERE ${predicates[0]}) + (SELECT COUNT(*) FROM bundle_event_heads WHERE ${predicates[1]} AND ${predicates[0]} IS NOT TRUE) AS count`;
    values.push(...firstGroupValues);
  }
  const rows: unknown = await client.$queryRawUnsafe(
    counting
      ? selection
      : `SELECT event.* FROM (${selection}) AS head JOIN bundle_events AS event ON event.id = head.id ORDER BY head.install_id ASC`,
    ...values,
  );
  if (!Array.isArray(rows))
    throw new PrismaAdapterError("invalid latest-event query result");
  if (counting) {
    const count = rows[0]?.count;
    if (typeof count !== "number" && typeof count !== "bigint")
      throw new PrismaAdapterError("invalid latest-event count");
    return Number(count);
  }
  return rows.map(parsePrismaBundleEventRow);
};
