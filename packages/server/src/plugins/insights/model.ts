import type { InsightsModel } from "@hot-updater/plugin-core";
import { createValidatedInsightsModel } from "@hot-updater/plugin-core/internal";

import type { InsightsApi } from "./index";

/**
 * The plugin's API as `InsightsModel`, validated at its boundary: what the
 * Insights routes, the console, and the e2e harness read through.
 */
export const createInsightsModel = (api: InsightsApi): InsightsModel =>
  createValidatedInsightsModel({
    recordEvent: ({ event }) => api.recordEvent(event),
    listEvents: api.listEvents,
    findLatestEvents: api.findLatestEvents,
    countLatestEvents: api.countLatestEvents,
    countEvents: api.countEvents,
    getReleaseActivity: api.getReleaseActivity,
    getAppUsage: api.getAppUsage,
  });
