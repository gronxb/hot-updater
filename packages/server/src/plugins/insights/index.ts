import type { BundleEventRow } from "@hot-updater/plugin-core";

import { markBuiltIn } from "../builtIn";
import { definePlugin } from "../definePlugin";
import { recordEvent } from "./recordEvent";
import { insightsSchema } from "./schema";

export { insightsIdentity, type InsightsIdentityParts } from "./recordEvent";
export { insightsSchema, type InsightsSchema } from "./schema";

/**
 * Built-in Insights: bundle lifecycle events, each installation's latest
 * event, and the counters, gauges, and sketches reads come from.
 */
export const insights = () =>
  markBuiltIn(
    definePlugin({
      id: "insights",
      schemaVersion: "1.0.0",
      schema: insightsSchema,
      init: ({ db }) => ({
        api: {
          /** Records one validated event row; a repeated id changes nothing. */
          recordEvent: (event: BundleEventRow) => recordEvent(db, event),
        },
      }),
    }),
  );
