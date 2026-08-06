import {
  parseBundleEventPersistenceRow,
  type AnalyticsPersistence,
} from "@hot-updater/analytics/provider";

import { createD1AnalyticsReadinessChecker } from "./d1AnalyticsMigration";
import { d1AnalyticsColumns } from "./d1AnalyticsSchema";
import type { D1Executor } from "./d1Implementation";
import { d1Placeholders, encodeD1Values } from "./d1Sql";

const jsonPlaceholder = "json_extract(?, '$')";

export const createD1AnalyticsPersistence = (
  executor: D1Executor,
): AnalyticsPersistence => {
  const assertReady = createD1AnalyticsReadinessChecker(executor);
  return {
    async append(row) {
      await assertReady();
      const rowValues = d1AnalyticsColumns.map((column) => row[column]);
      await executor.query(
        `INSERT INTO bundle_events (${d1AnalyticsColumns.join(", ")}) VALUES (${d1Placeholders(rowValues.length)})`,
        encodeD1Values(rowValues),
      );
    },
    async scan(input) {
      await assertReady();
      const { after } = input;
      const cursorClause =
        after === undefined
          ? ""
          : ` AND (received_at_ms > ${jsonPlaceholder} OR (received_at_ms = ${jsonPlaceholder} AND id > ${jsonPlaceholder}))`;
      const params =
        after === undefined
          ? [input.beforeReceivedAtMs, input.limit]
          : [
              input.beforeReceivedAtMs,
              after.receivedAtMs,
              after.receivedAtMs,
              after.id,
              input.limit,
            ];
      const rows = await executor.query(
        `SELECT ${d1AnalyticsColumns.join(", ")} FROM bundle_events WHERE received_at_ms < ${jsonPlaceholder}${cursorClause} ORDER BY received_at_ms ASC, id ASC LIMIT ${jsonPlaceholder}`,
        encodeD1Values(params),
      );
      return rows.map(parseBundleEventPersistenceRow);
    },
  };
};
