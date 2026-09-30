import { HotUpdaterConfigError } from "../../assembly/configError";
import type { HotUpdaterDatabase } from "../../database/database";
import { definePlugin, type PluginEndpoint } from "../definePlugin";
import type { BundleEventRow } from "./eventRow";
import { createInsightsModel } from "./model";
import type {
  InsightsCountEventsInput,
  InsightsCountLatestEventsInput,
  InsightsFindLatestEventsInput,
  InsightsGetAppUsageInput,
  InsightsGetReleaseActivityInput,
  InsightsListEventsInput,
} from "./modelTypes";
import { createInsightsProvider } from "./provider";
import {
  countEvents,
  countLatestEvents,
  findLatestEvents,
  getAppUsage,
  getReleaseActivity,
  listEvents,
} from "./reads";
import { recordEvent } from "./recordEvent";
import { createInsightsRouteHandlers, INSIGHTS_ROUTES } from "./routes";
import {
  createInsightsSchema,
  DAILY_RETENTION_DAYS,
  type InsightsRetention,
  type InsightsSchema,
  RAW_RETENTION_DAYS,
} from "./schema";

export type * from "./domain";
export type {
  BundleEventRow,
  BundleEventRowBase,
  DatabaseBundleEventMetadata,
} from "./eventRow";
export { createInsightsModel } from "./model";
export type * from "./modelTypes";
export { createInsightsProvider } from "./provider";
export { insightsIdentity, type InsightsIdentityParts } from "./recordEvent";
export {
  createInsightsSchema,
  DEFAULT_INSIGHTS_RETENTION,
  insightsSchema,
  type InsightsRetention,
  type InsightsSchema,
} from "./schema";
export type * from "./types";

const createInsightsApi = (
  db: HotUpdaterDatabase<InsightsSchema>,
  now: () => number,
  retention: InsightsRetention,
) => ({
  /** How long this plugin keeps its rows. */
  retention,
  /** Records one validated event row; a repeated id changes nothing. */
  recordEvent: (event: BundleEventRow) => recordEvent(db, event),
  listEvents: (input: InsightsListEventsInput) => listEvents(db, input),
  findLatestEvents: (input: InsightsFindLatestEventsInput) =>
    findLatestEvents(db, input),
  countLatestEvents: (input: InsightsCountLatestEventsInput) =>
    countLatestEvents(db, input),
  countEvents: (input: InsightsCountEventsInput) => countEvents(db, input),
  getReleaseActivity: (input: InsightsGetReleaseActivityInput) =>
    getReleaseActivity(db, input, now, retention),
  getAppUsage: (input: InsightsGetAppUsageInput) =>
    getAppUsage(db, input, now, retention),
});

export type InsightsApi = ReturnType<typeof createInsightsApi>;

export interface InsightsOptions {
  /**
   * How long to keep rows, in whole days: `rawDays` (90 by default) for raw
   * events and hourly rollups, `dailyDays` (400 by default) for daily
   * rollups and each installation's latest event. Each is at least 1, and
   * `dailyDays` at least `rawDays`.
   */
  readonly retention?: Partial<InsightsRetention>;
}

const retentionOf = ({ retention }: InsightsOptions): InsightsRetention => {
  const rawDays = retention?.rawDays ?? RAW_RETENTION_DAYS;
  const dailyDays = retention?.dailyDays ?? DAILY_RETENTION_DAYS;
  const whole = (days: number) => Number.isSafeInteger(days) && days >= 1;
  if (!whole(rawDays) || !whole(dailyDays) || dailyDays < rawDays) {
    throw new HotUpdaterConfigError(
      `insights({ retention }) takes whole days of at least 1, with dailyDays at least rawDays; got rawDays ${rawDays} and dailyDays ${dailyDays}.`,
    );
  }
  return { rawDays, dailyDays };
};

/**
 * Insights: bundle lifecycle events, each installation's latest
 * event, and the counters, gauges, and sketches its reads come from, each
 * kept for its retention. It serves `POST /events` to clients, and the
 * Insights reads and retention to admins.
 */
export const insights = (options: InsightsOptions = {}) => {
  const retention = retentionOf(options);
  return definePlugin({
    id: "insights",
    // Keeps its tables' names: bundle_events, bundle_event_heads, insights_*.
    namespace: false,
    // 1.1.0 splits daily and lifetime rollups from hourly ones, each with
    // its retention, so a database migrates before a server serves it.
    schemaVersion: "1.1.0",
    schema: createInsightsSchema(retention),
    init: ({ db, now }) => {
      const api = createInsightsApi(db, now, retention);
      const routes = createInsightsRouteHandlers(
        createInsightsProvider(createInsightsModel(api)),
      );
      // Declared, so the plugin's type names no runtime's Response.
      const endpoints: PluginEndpoint[] = [
        ...INSIGHTS_ROUTES.map(({ access, method, path, handler }) => ({
          access,
          method,
          path,
          handler: (
            request: Request,
            params: Readonly<Record<string, string>>,
          ) => routes[handler](params, request),
        })),
        {
          access: "admin",
          method: "GET",
          path: "/retention",
          handler: async () => Response.json(retention),
        },
      ];
      return { api, endpoints };
    },
    // Apps report their events through the SDK's Insights client plugin.
    cli: {
      clientPlugin: {
        module: "@hot-updater/react-native/plugins/insights",
        name: "insights",
      },
    },
  });
};
