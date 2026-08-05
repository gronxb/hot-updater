import { expect, it } from "vitest";

import { createD1AnalyticsReadinessChecker } from "./d1AnalyticsMigration";
import { d1AnalyticsIndexes, d1AnalyticsTableV2 } from "./d1AnalyticsSchema";

it("revalidates physical readiness after a warm marker failure", async () => {
  const queries: string[] = [];
  let marker = "2";
  const assertReady = createD1AnalyticsReadinessChecker({
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("type = 'table'")) {
        return [
          { name: "bundle_events", sql: d1AnalyticsTableV2 },
          {
            name: "private_hot_updater_settings",
            sql: "CREATE TABLE private_hot_updater_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
          },
        ];
      }
      if (sql.includes("key IN ('schema.analytics', 'version')")) {
        return [
          { key: "schema.analytics", value: "2" },
          { key: "version", value: "0.36.0" },
        ];
      }
      if (sql.includes("key = 'schema.analytics'")) {
        return [{ key: "schema.analytics", value: marker }];
      }
      if (sql.includes("type = 'index'")) {
        return d1AnalyticsIndexes.map((indexSql, index) => ({
          name: `analytics-index-${index}`,
          sql: indexSql,
        }));
      }
      return [];
    },
  });

  await Promise.all([assertReady(), assertReady()]);
  marker = "3";
  await expect(assertReady()).rejects.toThrow(
    "Analytics schema is not ready for runtime operations.",
  );
  marker = "2";
  await assertReady();

  expect(queries.filter((sql) => sql.includes("type = 'table'"))).toHaveLength(
    2,
  );
  expect(
    queries.filter((sql) => sql.includes("key = 'schema.analytics'")),
  ).toHaveLength(2);
});

it("preserves D1 query failures during cold row validation", async () => {
  const backendError = new Error("D1 query failed");
  const assertReady = createD1AnalyticsReadinessChecker({
    async query(sql: string) {
      if (sql.includes("type = 'table'")) {
        return [
          { name: "bundle_events", sql: d1AnalyticsTableV2 },
          {
            name: "private_hot_updater_settings",
            sql: "CREATE TABLE private_hot_updater_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
          },
        ];
      }
      if (sql.includes("key IN ('schema.analytics', 'version')")) {
        return [
          { key: "schema.analytics", value: "2" },
          { key: "version", value: "0.36.0" },
        ];
      }
      if (sql.includes("type = 'index'")) {
        return d1AnalyticsIndexes.map((indexSql, index) => ({
          name: `analytics-index-${index}`,
          sql: indexSql,
        }));
      }
      if (sql.includes("FROM bundle_events")) throw backendError;
      return [];
    },
  });

  await expect(assertReady()).rejects.toBe(backendError);
});
