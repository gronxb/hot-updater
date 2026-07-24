import type {
  HotUpdaterRequestParser,
  HotUpdaterRouteAccess,
} from "@hot-updater/server/internal/first-party-plugin";

import {
  AnalyticsScanLimitExceededError,
  AnalyticsUnavailableError,
} from "../errors";
import {
  resolveAnalyticsCapability,
  type AnalyticsProvider,
} from "../provider";

export type AnalyticsRouteCapability = "analyticsQueries" | "eventIngestion";

export type AnalyticsRouteInput<TValue> =
  | { readonly kind: "input"; readonly value: TValue }
  | { readonly kind: "response"; readonly response: Response };

export class AnalyticsBadRequestError extends Error {
  readonly name = "AnalyticsBadRequestError";
}

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });

export const badRequest = (message: string): Response =>
  jsonResponse({ error: message }, 400);

export const okJson = (body: unknown): Response => jsonResponse(body, 200);

export const scanSafe = async (
  operation: () => Promise<unknown>,
): Promise<Response> => {
  try {
    return okJson(await operation());
  } catch (error) {
    if (error instanceof AnalyticsScanLimitExceededError) {
      return jsonResponse(
        {
          error: {
            code: "ANALYTICS_SCAN_LIMIT_EXCEEDED",
            limit: error.limit,
          },
        },
        503,
      );
    }
    throw error;
  }
};

export const queryAccess = (
  value: "protected" | "public",
): HotUpdaterRouteAccess =>
  Object.freeze(
    value === "public" ? { kind: "public" } : { kind: "protected" },
  );

export const createAnalyticsInputParser = <TValue>(
  provider: AnalyticsProvider,
  routeCapability: AnalyticsRouteCapability,
  parse: (request: Request) => Promise<TValue> | TValue,
): HotUpdaterRequestParser<AnalyticsRouteInput<TValue>> =>
  Object.freeze({
    async parse(request) {
      const capability = await resolveAnalyticsCapability(
        provider,
        request.signal,
      );
      if (!capability.analytics || !capability[routeCapability]) {
        return {
          kind: "response",
          response: new Response(null, { status: 404 }),
        };
      }
      try {
        return { kind: "input", value: await parse(request) };
      } catch (error) {
        if (error instanceof AnalyticsBadRequestError) {
          return { kind: "response", response: badRequest(error.message) };
        }
        throw error;
      }
    },
  } satisfies HotUpdaterRequestParser<AnalyticsRouteInput<TValue>>);

export const requireRuntimeCapability = async (
  provider: AnalyticsProvider,
  routeCapability: AnalyticsRouteCapability,
  operation: string,
): Promise<void> => {
  const capability = await resolveAnalyticsCapability(
    provider,
    new AbortController().signal,
  );
  if (!capability.analytics || !capability[routeCapability]) {
    throw new AnalyticsUnavailableError(operation);
  }
};

export const requireRouteParam = (
  params: Readonly<Record<string, string>>,
  key: string,
): string => {
  const value = params[key];
  if (!value)
    throw new AnalyticsBadRequestError(`Missing route parameter: ${key}`);
  return value;
};
