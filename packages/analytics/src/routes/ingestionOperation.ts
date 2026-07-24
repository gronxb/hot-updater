import type { HotUpdaterServerRoute } from "@hot-updater/server/internal/first-party-plugin";

import type { CreateBundleEventRequest } from "../domain";
import type { AnalyticsProvider } from "../provider";
import { parseBundleEventRequest } from "./eventInput";
import {
  createAnalyticsInputParser,
  requireRuntimeCapability,
  type AnalyticsRouteInput,
} from "./support";

export const EVENT_BODY_MAX_BYTES = 16 * 1024;

export const appendBundleEventOperation = Object.freeze({
  name: "appendBundleEvent",
  createRoute(
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
      requestPolicy: Object.freeze({
        maximumBodyBytes: EVENT_BODY_MAX_BYTES,
        payloadTooLargeResponse: Object.freeze({
          body: Object.freeze({
            error: `Event payload exceeds ${EVENT_BODY_MAX_BYTES} bytes`,
          }),
          headers: Object.freeze({ "Content-Type": "application/json" }),
          status: 413,
        }),
      }),
      async handle(_context, input) {
        if (input.kind === "response") return input.response;
        await provider.appendBundleEvent(input.value);
        return new Response(null, { status: 204 });
      },
    } satisfies HotUpdaterServerRoute<
      AnalyticsRouteInput<CreateBundleEventRequest>
    >);
  },
  createRuntimeMethod(provider: AnalyticsProvider) {
    return async (input: CreateBundleEventRequest): Promise<void> => {
      await requireRuntimeCapability(
        provider,
        "eventIngestion",
        "appendBundleEvent",
      );
      return provider.appendBundleEvent(input);
    };
  },
});
