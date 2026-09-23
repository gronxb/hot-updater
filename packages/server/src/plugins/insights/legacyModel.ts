import type { InsightsModel } from "@hot-updater/plugin-core";
import { createValidatedInsightsModel } from "@hot-updater/plugin-core/internal";

import type { InsightsApi } from "./index";

/** The plugin behind today's `InsightsModel`, validated at the same boundary, until E2 retires that contract. */
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
