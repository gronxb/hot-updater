import type {
  HotUpdaterRouteContext,
  HotUpdaterServerRoute,
} from "@hot-updater/server/internal/first-party-plugin";

import type { CreateBundleEventRequest } from "../domain";
import type { AnalyticsProvider } from "../provider";
import { EVENT_BODY_MAX_BYTES, parseBundleEventRequest } from "./eventInput";
import {
  appendSafe,
  createAnalyticsInputParser,
  type AnalyticsRouteInput,
} from "./support";

export { EVENT_BODY_MAX_BYTES };

export function createIngestionRoute(
  provider: AnalyticsProvider,
): HotUpdaterServerRoute<AnalyticsRouteInput<CreateBundleEventRequest>> {
  return Object.freeze({
    access: Object.freeze({ kind: "public" }),
    id: "analytics.appendBundleEvent",
    input: createAnalyticsInputParser(
      provider,
      "eventIngestion",
      parseBundleEventRequest,
    ),
    method: "POST",
    path: "/events",
    async handle(
      _context: HotUpdaterRouteContext,
      input: AnalyticsRouteInput<CreateBundleEventRequest>,
    ) {
      if (input.kind === "response") return input.response;
      return appendSafe(() => provider.appendBundleEvent(input.value));
    },
  });
}
