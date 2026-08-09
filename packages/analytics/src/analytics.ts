import {
  defineFirstPartyServerPlugin,
  type FirstPartyServerPlugin,
} from "@hot-updater/server/internal/first-party-plugin";

import { InvalidAnalyticsProviderError } from "./errors";
import { analyticsProviderCapability } from "./internal/provider-capability";
import { parseAnalyticsProvider, type AnalyticsProvider } from "./provider";
import { createAnalyticsRoutes } from "./routes";

export type AnalyticsOptions = {
  readonly provider?: AnalyticsProvider;
  readonly queryAccess?: "protected" | "public";
};

type NormalizedAnalyticsOptions = {
  readonly provider?: AnalyticsProvider;
  readonly queryAccess: "protected" | "public";
};

const supportedOptionKeys = new Set(["provider", "queryAccess"]);

function isOptionsRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeAnalyticsOptions(input: unknown): NormalizedAnalyticsOptions {
  if (!isOptionsRecord(input)) {
    throw new TypeError("Analytics options must be an object.");
  }
  const unknownKey = Object.keys(input).find(
    (key) => !supportedOptionKeys.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TypeError(`Unsupported Analytics option: ${unknownKey}.`);
  }
  const queryAccess = input.queryAccess;
  if (
    queryAccess !== undefined &&
    queryAccess !== "protected" &&
    queryAccess !== "public"
  ) {
    throw new TypeError("Invalid Analytics queryAccess option.");
  }
  let provider: AnalyticsProvider | undefined;
  try {
    provider =
      input.provider === undefined
        ? undefined
        : parseAnalyticsProvider(input.provider);
  } catch (error) {
    if (error instanceof InvalidAnalyticsProviderError) {
      throw new TypeError("Invalid Analytics provider option.");
    }
    throw error;
  }
  return Object.freeze({
    ...(provider === undefined ? {} : { provider }),
    queryAccess: queryAccess ?? "protected",
  });
}

function createPlugin(
  options: NormalizedAnalyticsOptions,
): FirstPartyServerPlugin {
  return defineFirstPartyServerPlugin({
    id: "analytics",
    requires:
      options.provider === undefined
        ? Object.freeze([
            Object.freeze({
              missing: "error" as const,
              token: analyticsProviderCapability,
            }),
          ])
        : Object.freeze([]),
    setup(context) {
      const provider =
        options.provider ??
        context.capabilities.require(analyticsProviderCapability);
      return Object.freeze({
        routes: createAnalyticsRoutes(provider, {
          queryAccess: options.queryAccess,
        }),
      });
    },
  });
}

export function analytics(options?: AnalyticsOptions): FirstPartyServerPlugin;
export function analytics(options: unknown = {}): FirstPartyServerPlugin {
  return createPlugin(normalizeAnalyticsOptions(options));
}
