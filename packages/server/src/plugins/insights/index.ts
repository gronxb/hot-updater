import type {
  BundleEventRow,
  InsightsCountEventsInput,
  InsightsCountLatestEventsInput,
  InsightsFindLatestEventsInput,
  InsightsGetAppUsageInput,
  InsightsGetReleaseActivityInput,
  InsightsListEventsInput,
} from "@hot-updater/plugin-core";

import type { HotUpdaterDatabase } from "../../database/database";
import { createInsightsProvider } from "../../insights/provider";
import {
  createInsightsRouteHandlers,
  INSIGHTS_ROUTES,
} from "../../insights/routes";
import { markBuiltIn } from "../builtIn";
import { definePlugin } from "../definePlugin";
import { createInsightsModel } from "./legacyModel";
import {
  countEvents,
  countLatestEvents,
  findLatestEvents,
  getAppUsage,
  getReleaseActivity,
  listEvents,
} from "./reads";
import { recordEvent } from "./recordEvent";
import { insightsSchema, type InsightsSchema } from "./schema";

export { createInsightsModel } from "./legacyModel";
export { insightsIdentity, type InsightsIdentityParts } from "./recordEvent";
export { insightsSchema, type InsightsSchema } from "./schema";

const createInsightsApi = (
  db: HotUpdaterDatabase<InsightsSchema>,
  now: () => number,
) => ({
  /** Records one validated event row; a repeated id changes nothing. */
  recordEvent: (event: BundleEventRow) => recordEvent(db, event),
  listEvents: (input: InsightsListEventsInput) => listEvents(db, input),
  findLatestEvents: (input: InsightsFindLatestEventsInput) =>
    findLatestEvents(db, input),
  countLatestEvents: (input: InsightsCountLatestEventsInput) =>
    countLatestEvents(db, input),
  countEvents: (input: InsightsCountEventsInput) => countEvents(db, input),
  getReleaseActivity: (input: InsightsGetReleaseActivityInput) =>
    getReleaseActivity(db, input, now),
  getAppUsage: (input: InsightsGetAppUsageInput) => getAppUsage(db, input, now),
});

export type InsightsApi = ReturnType<typeof createInsightsApi>;

/**
 * Built-in Insights: bundle lifecycle events, each installation's latest
 * event, and the counters, gauges, and sketches its reads come from. It
 * serves `POST /events` to clients and the Insights reads to admins.
 */
export const insights = () =>
  markBuiltIn(
    definePlugin({
      id: "insights",
      schemaVersion: "1.0.0",
      schema: insightsSchema,
      init: ({ db, now }) => {
        const api = createInsightsApi(db, now);
        const routes = createInsightsRouteHandlers(
          createInsightsProvider(createInsightsModel(api)),
        );
        return {
          api,
          endpoints: INSIGHTS_ROUTES.map(
            ({ access, method, path, handler }) => ({
              access,
              method,
              path,
              handler: (
                request: Request,
                params: Readonly<Record<string, string>>,
              ) => routes[handler](params, request),
            }),
          ),
        };
      },
    }),
  );
