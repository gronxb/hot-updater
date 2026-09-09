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
  const bind = (value: unknown): string => {
    values.push(value);
    return provider === "postgresql" || provider === "cockroachdb"
      ? `$${values.length}`
      : "?";
  };
  const groups =
    "sinceMs" in input
      ? latestInsightsCountGroups(input)
      : [latestInsightsWhere(input)];
  const predicates = [
    groups
      .map(
        (group) =>
          `(${group
            .map((where) =>
              where.operator === "in" && Array.isArray(where.value)
                ? `${where.field} IN (${where.value.map(bind).join(", ")})`
                : `${where.field} ${where.operator === "gte" ? ">=" : where.operator === "gt" ? ">" : "="} ${bind(where.value)}`,
            )
            .join(" AND ")})`,
      )
      .join(" OR "),
  ];
  predicates[0] = `(${predicates[0]})`;

  predicates.push(
    "NOT EXISTS (SELECT 1 FROM bundle_events AS newer WHERE newer.install_id = bundle_events.install_id AND (newer.received_at_ms > bundle_events.received_at_ms OR (newer.received_at_ms = bundle_events.received_at_ms AND newer.id > bundle_events.id)))",
  );
  const counting = "sinceMs" in input;
  const page = counting
    ? ""
    : ` ORDER BY install_id ASC LIMIT ${bind("installId" in input ? 1 : input.limit)}`;
  // Only fixed identifiers/operators enter SQL; every input value is bound.
  const rows: unknown = await client.$queryRawUnsafe(
    `SELECT ${counting ? "COUNT(*) AS count" : "*"} FROM bundle_events WHERE ${predicates.join(" AND ")}${page}`,
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
