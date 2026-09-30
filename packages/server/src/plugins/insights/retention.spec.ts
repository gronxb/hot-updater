import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { createPluginTestHarness } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { HotUpdaterConfigError } from "../../assembly/configError";
import * as engine from "../../database";
import { resolveSchema } from "../../database/resolveSchema";
import { createHotUpdater } from "../../index";
import { insights } from "./index";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T = Date.UTC(2026, 8, 23, 10);

/** Each table's retention in days, or null where rows are kept. */
const periods = (plugin: ReturnType<typeof insights>) =>
  Object.fromEntries(
    resolveSchema([{ id: "insights", schema: plugin.schema }]).tables.map(
      (table) => [
        table.name,
        table.retention ? table.retention.ms / DAY : null,
      ],
    ),
  );

describe("insights retention", () => {
  it("keeps raw events and hourly rows 90 days, daily rows and heads 400, lifetime rows always", () => {
    expect(periods(insights())).toEqual({
      bundle_events: 90,
      bundle_event_heads: 400,
      insights_overview: 90,
      insights_sketches: 90,
      insights_overview_daily: 400,
      insights_sketches_daily: 400,
      insights_overview_lifetime: null,
      insights_sketches_lifetime: null,
      insights_distribution: 400,
      insights_latest_by_bundle: 400,
      insights_outcomes: 90,
      insights_failures: 90,
    });
  });

  it("takes other periods, whose tables are the same", () => {
    const plugin = insights({ retention: { rawDays: 30, dailyDays: 60 } });

    expect(periods(plugin)).toMatchObject({
      bundle_events: 30,
      bundle_event_heads: 60,
      insights_overview: 30,
      insights_overview_daily: 60,
      insights_overview_lifetime: null,
      insights_distribution: 60,
      insights_outcomes: 30,
    });
    const tables = (value: ReturnType<typeof insights>) =>
      resolveSchema([{ id: "insights", schema: value.schema }]).tables.map(
        ({ retention: _retention, ...table }) => table,
      );
    expect(tables(plugin)).toEqual(tables(insights()));
    expect(periods(insights({ retention: { rawDays: 7 } }))).toMatchObject({
      bundle_events: 7,
      bundle_event_heads: 400,
    });
  });

  it("refuses periods under a day, fractions, or a daily period under the raw one", () => {
    for (const retention of [
      { rawDays: 0 },
      { dailyDays: 0 },
      { rawDays: 1.5 },
      { rawDays: 30, dailyDays: 10 },
      { rawDays: 500 },
    ]) {
      expect(() => insights({ retention })).toThrow(HotUpdaterConfigError);
    }
  });

  it("reports its periods through its API and its admin route", async () => {
    const hotUpdater = createHotUpdater({
      clientAccess: "public",
      database: { name: "memory", adapter: createMemoryAdapter() },
      plugins: [insights({ retention: { rawDays: 30, dailyDays: 60 } })],
    });

    expect(hotUpdater.api.insights.retention).toEqual({
      rawDays: 30,
      dailyDays: 60,
    });
    const response = await hotUpdater.handlers.admin(
      new Request("https://admin.example.com/retention"),
    );
    await expect(response.json()).resolves.toEqual({
      rawDays: 30,
      dailyDays: 60,
    });
  });

  it("reads hourly rows only within the raw period", async () => {
    const harness = await createPluginTestHarness(
      insights({ retention: { rawDays: 30, dailyDays: 60 } }),
      { engine, adapter: createMemoryAdapter() },
    );
    harness.setNow(() => T);

    const usage = await harness.api.getAppUsage({
      channel: "production",
      platform: "ios",
      timeRange: { start: T - 40 * DAY, end: T },
      intervalMs: HOUR,
    });

    expect(usage.coverage).toEqual({ kind: "partial", sinceMs: T - 30 * DAY });
  });
});
