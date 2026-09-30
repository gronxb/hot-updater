import type {
  BundleEventRow,
  InsightsCountEventsInput,
  InsightsCountLatestEventsInput,
  InsightsFindLatestEventsInput,
  InsightsGetAppUsageInput,
  InsightsGetReleaseActivityInput,
  InsightsListEventsInput,
} from "@hot-updater/plugin-core";

import { HotUpdaterConfigError } from "../../assembly/configError";
import type { HotUpdaterDatabase } from "../../database/database";
import { isDatabaseBusyError } from "../../insights/errors";
import { createInsightsProvider } from "../../insights/provider";
import {
  createInsightsRouteHandlers,
  INSIGHTS_ROUTES,
} from "../../insights/routes";
import { markBuiltIn } from "../builtIn";
import { definePlugin, type PluginEndpoint } from "../definePlugin";
import {
  deleteInstallation,
  deleteUser,
  type InsightsDeletion,
  type InsightsDeletionOptions,
} from "./deletion";
import { createInsightsModel } from "./model";
import {
  countEvents,
  countLatestEvents,
  findLatestEvents,
  getAppUsage,
  getReleaseActivity,
  listEvents,
} from "./reads";
import { recordEvent } from "./recordEvent";
import {
  createInsightsSchema,
  DAILY_RETENTION_DAYS,
  type InsightsRetention,
  type InsightsSchema,
  RAW_RETENTION_DAYS,
} from "./schema";

export type { InsightsDeletion, InsightsDeletionOptions } from "./deletion";
export { createInsightsModel } from "./model";
export { insightsIdentity, type InsightsIdentityParts } from "./recordEvent";
export {
  createInsightsSchema,
  DEFAULT_INSIGHTS_RETENTION,
  insightsSchema,
  type InsightsRetention,
  type InsightsSchema,
} from "./schema";

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
  /** Deletes one installation's events and latest event, a bounded batch a call. */
  deleteInstallation: (installId: string, options?: InsightsDeletionOptions) =>
    deleteInstallation(db, installId, options),
  /** Deletes every installation whose latest event names the user. */
  deleteUser: (userId: string, options?: InsightsDeletionOptions) =>
    deleteUser(db, userId, options),
});

export type InsightsApi = ReturnType<typeof createInsightsApi>;

/** Rows one admin DELETE removes, so a request stays short; callers repeat until `complete`. */
const DELETION_LIMIT = 500;

const deletionAnswer = async (
  deletion: () => Promise<InsightsDeletion>,
): Promise<Response> => {
  try {
    return Response.json(await deletion());
  } catch (error) {
    if (!isDatabaseBusyError(error)) throw error;
    return Response.json(
      { error: "Service unavailable" },
      { status: 503, headers: { "retry-after": "5" } },
    );
  }
};

/**
 * The admin routes that delete Insights data: one installation's, or that of
 * every installation whose latest event names `userId`. Each answers what it
 * deleted and whether anything remains; deleting what is gone deletes
 * nothing and completes.
 */
const deletionEndpoints = (api: InsightsApi): PluginEndpoint[] => [
  {
    access: "admin",
    method: "DELETE",
    path: "/installations/:installId",
    handler: async (_request, { installId }) => {
      let id: string;
      try {
        id = decodeURIComponent(installId!);
      } catch {
        return Response.json(
          { error: "Invalid route parameter: installId" },
          { status: 400 },
        );
      }
      return deletionAnswer(() =>
        api.deleteInstallation(id, { limit: DELETION_LIMIT }),
      );
    },
  },
  {
    access: "admin",
    method: "DELETE",
    path: "/installations",
    handler: async (request) => {
      const userId = new URL(request.url).searchParams.get("userId");
      if (!userId) {
        return Response.json(
          { error: "userId is required to delete installations." },
          { status: 400 },
        );
      }
      return deletionAnswer(() =>
        api.deleteUser(userId, { limit: DELETION_LIMIT }),
      );
    },
  },
];

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
 * Built-in Insights: bundle lifecycle events, each installation's latest
 * event, and the counters, gauges, and sketches its reads come from, each
 * kept for its retention. It serves `POST /events` to clients, and the
 * Insights reads, deletions, and retention to admins.
 */
export const insights = (options: InsightsOptions = {}) => {
  const retention = retentionOf(options);
  return markBuiltIn(
    definePlugin({
      id: "insights",
      // 1.1.0 splits daily and lifetime rollups from hourly ones, each with
      // its retention, so a database migrates before a server serves it.
      schemaVersion: "1.1.0",
      schema: createInsightsSchema(retention),
      init: ({ db, now }) => {
        const api = createInsightsApi(db, now, retention);
        const routes = createInsightsRouteHandlers(
          createInsightsProvider(createInsightsModel(api)),
        );
        return {
          api,
          endpoints: [
            ...INSIGHTS_ROUTES.map(({ access, method, path, handler }) => ({
              access,
              method,
              path,
              handler: (
                request: Request,
                params: Readonly<Record<string, string>>,
              ) => routes[handler](params, request),
            })),
            ...deletionEndpoints(api),
            {
              access: "admin",
              method: "GET",
              path: "/retention",
              handler: async () => Response.json(retention),
            },
          ],
        };
      },
      // Apps report their events through the SDK's Insights client plugin.
      cli: {
        clientPlugin: {
          module: "@hot-updater/react-native/plugins/insights",
          name: "insights",
        },
      },
    }),
  );
};
