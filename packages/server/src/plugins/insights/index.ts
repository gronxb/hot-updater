import { DatabaseAdapterInputError } from "@hot-updater/plugin-core";

import { HotUpdaterConfigError } from "../../assembly/configError";
import { isDatabaseBusyError } from "../../database/busy";
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
  getUpdateFailures,
  type InsightsUpdateFailuresInput,
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
  BundleEventFailure,
  BundleEventFailureReason,
  BundleEventFailureStage,
  BundleEventRow,
  BundleEventRowBase,
  DatabaseBundleEventMetadata,
} from "./eventRow";
export type {
  InsightsFailureBreakdown,
  InsightsUpdateFailures,
  InsightsUpdateFailuresInput,
} from "./reads";
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
  /** A release's or a channel's update failures, and their breakdown over a time range. */
  getUpdateFailures: (input: InsightsUpdateFailuresInput) =>
    getUpdateFailures(db, input, now, retention),
});

export type InsightsApi = ReturnType<typeof createInsightsApi>;

/** `GET /failures`'s query: a scope, an optional release, and a time range or none. */
const readFailuresQuery = (url: URL): InsightsUpdateFailuresInput => {
  const query = url.searchParams;
  const time = (name: string) => {
    const value = query.get(name);
    return value === null ? undefined : Number(value);
  };
  const [start, end] = [time("start"), time("end")];
  const platform = query.get("platform");
  const releaseId = query.get("releaseId");
  if (
    (platform !== "ios" && platform !== "android") ||
    (start === undefined) !== (end === undefined)
  ) {
    throw new DatabaseAdapterInputError("invalid-query");
  }
  return {
    platform,
    channel: query.get("channel") ?? "",
    ...(releaseId === null ? {} : { releaseId }),
    ...(start === undefined ? {} : { timeRange: { start, end: end! } }),
  };
};

/**
 * The admin route of the update failures read: a release's (`releaseId`)
 * since its first report, or over `start`–`end`, or a channel's over a range,
 * which covers at most 30 days.
 */
const failuresEndpoint = (api: InsightsApi): PluginEndpoint => ({
  access: "admin",
  method: "GET",
  path: "/failures",
  handler: async (request) => {
    try {
      return Response.json(
        await api.getUpdateFailures(readFailuresQuery(new URL(request.url))),
        { headers: { "cache-control": "private, no-store" } },
      );
    } catch (error) {
      if (error instanceof DatabaseAdapterInputError) {
        return Response.json(
          {
            error:
              "Send platform and channel, and releaseId or start and end in epoch milliseconds, at most 30 days apart.",
          },
          { status: 400 },
        );
      }
      if (!isDatabaseBusyError(error)) throw error;
      return Response.json(
        { error: "Service unavailable" },
        { status: 503, headers: { "retry-after": "5" } },
      );
    }
  },
});

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
 * Insights: bundle lifecycle events and update failures, each
 * installation's latest event, and the counters, gauges, and sketches its
 * reads come from, each kept for its retention. It serves `POST /events` to
 * clients, and the Insights reads, update failures, and retention to admins.
 */
export const insights = (options: InsightsOptions = {}) => {
  const retention = retentionOf(options);
  return definePlugin({
    id: "insights",
    // Keeps its tables' names: bundle_events, bundle_event_heads, insights_*.
    namespace: false,
    // 1.2.0 adds update failures (their counters, sketches, and
    // breakdown) and drops heads' hour-row compatibility, so a database
    // migrates before a server serves it.
    schemaVersion: "1.2.0",
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
        failuresEndpoint(api),
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
