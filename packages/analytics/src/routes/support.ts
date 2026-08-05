import type {
  HotUpdaterRequestParser,
  HotUpdaterRouteAccess,
} from "@hot-updater/server/internal/first-party-plugin";

import { AnalyticsScanLimitExceededError } from "../errors";
import {
  AnalyticsSchemaNotReadyError,
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

export class AnalyticsPayloadTooLargeError extends Error {
  readonly name = "AnalyticsPayloadTooLargeError";

  constructor(readonly maximumBytes: number) {
    super(`Event payload exceeds ${maximumBytes} bytes`);
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    headers: { "cache-control": "private, no-store" },
    status,
  });
}

function schemaNotReadyResponse(): Response {
  return jsonResponse({ error: { code: "ANALYTICS_SCHEMA_NOT_READY" } }, 503);
}

export function okJson(body: unknown): Response {
  return jsonResponse(body, 200);
}

export async function scanSafe(
  operation: () => Promise<unknown>,
): Promise<Response> {
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
    if (error instanceof AnalyticsSchemaNotReadyError) {
      return schemaNotReadyResponse();
    }
    throw error;
  }
}

export async function appendSafe(
  operation: () => Promise<void>,
): Promise<Response> {
  try {
    await operation();
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof AnalyticsSchemaNotReadyError) {
      return schemaNotReadyResponse();
    }
    throw error;
  }
}

export function queryAccess(
  value: "protected" | "public",
): HotUpdaterRouteAccess {
  return Object.freeze({ kind: value });
}

export function createAnalyticsInputParser<TValue>(
  provider: AnalyticsProvider,
  routeCapability: AnalyticsRouteCapability,
  parse: (request: Request) => Promise<TValue> | TValue,
): HotUpdaterRequestParser<AnalyticsRouteInput<TValue>> {
  return Object.freeze({
    async parse(request) {
      const capability = await resolveAnalyticsCapability(
        provider,
        request.signal,
      );
      if (!capability.analytics || !capability[routeCapability]) {
        return {
          kind: "response",
          response: new Response(null, {
            headers: { "cache-control": "private, no-store" },
            status: 404,
          }),
        };
      }
      try {
        return { kind: "input", value: await parse(request) };
      } catch (error) {
        if (error instanceof AnalyticsBadRequestError) {
          return {
            kind: "response",
            response: jsonResponse({ error: error.message }, 400),
          };
        }
        if (error instanceof AnalyticsPayloadTooLargeError) {
          return {
            kind: "response",
            response: jsonResponse({ error: error.message }, 413),
          };
        }
        throw error;
      }
    },
  } satisfies HotUpdaterRequestParser<AnalyticsRouteInput<TValue>>);
}

export function requireRouteParam(
  params: Readonly<Record<string, string>>,
  key: string,
): string {
  const value = params[key];
  if (value === undefined || value.length === 0) {
    throw new AnalyticsBadRequestError(`Missing route parameter: ${key}`);
  }
  return value;
}
