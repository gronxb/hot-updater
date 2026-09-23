import type {
  BundleEventRow,
  InsightsCountEventsInput,
  InsightsCountLatestEventsInput,
  InsightsFindLatestEventsInput,
  InsightsGetAppUsageInput,
  InsightsGetReleaseActivityInput,
  InsightsListEventsInput,
} from "@hot-updater/plugin-core";

import { markBuiltIn } from "../builtIn";
import { definePlugin } from "../definePlugin";
import {
  countEvents,
  countLatestEvents,
  findLatestEvents,
  getAppUsage,
  getReleaseActivity,
  listEvents,
} from "./reads";
import { recordEvent } from "./recordEvent";
import { insightsSchema } from "./schema";

export { createInsightsModel } from "./legacyModel";
export { insightsIdentity, type InsightsIdentityParts } from "./recordEvent";
export { insightsSchema, type InsightsSchema } from "./schema";

/**
 * Built-in Insights: bundle lifecycle events, each installation's latest
 * event, and the counters, gauges, and sketches its reads come from.
 */
export const insights = () =>
  markBuiltIn(
    definePlugin({
      id: "insights",
      schemaVersion: "1.0.0",
      schema: insightsSchema,
      init: ({ db, now }) => ({
        api: {
          /** Records one validated event row; a repeated id changes nothing. */
          recordEvent: (event: BundleEventRow) => recordEvent(db, event),
          listEvents: (input: InsightsListEventsInput) => listEvents(db, input),
          findLatestEvents: (input: InsightsFindLatestEventsInput) =>
            findLatestEvents(db, input),
          countLatestEvents: (input: InsightsCountLatestEventsInput) =>
            countLatestEvents(db, input),
          countEvents: (input: InsightsCountEventsInput) =>
            countEvents(db, input),
          getReleaseActivity: (input: InsightsGetReleaseActivityInput) =>
            getReleaseActivity(db, input, now),
          getAppUsage: (input: InsightsGetAppUsageInput) =>
            getAppUsage(db, input, now),
        },
      }),
    }),
  );

export type InsightsApi = ReturnType<
  ReturnType<typeof insights>["init"]
>["api"];
