import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
} from "@hot-updater/plugin-core";

import { HotUpdaterSchemaMigrationRequiredError } from "../db/schemaReadiness";
import type { RouteHandler } from "../handlerTypes";
import type { EventHistoryPageInput } from "./domain";
import { InsightsBadRequestError } from "./errors";
import type { InsightsProvider } from "./types";

const FIELDS = [
  "scope",
  "bundleId",
  "installId",
  "beforeReceivedAtMs",
  "limit",
  "cursor",
];

const invalid = (): never => {
  throw new InsightsBadRequestError("Invalid event page query.");
};

const parseInput = (request: Request): EventHistoryPageInput => {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!FIELDS.includes(key) || params.getAll(key).length !== 1) invalid();
  }
  const integer = (key: string, fallback: number): number => {
    const value = params.get(key);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value)) invalid();
    const number = Number(value);
    if (!Number.isSafeInteger(number)) invalid();
    return number;
  };
  const limit = integer("limit", 50);
  const cursor = params.get("cursor");
  if (
    limit < 1 ||
    limit > 100 ||
    (cursor !== null &&
      (cursor.length === 0 ||
        cursor.length > 8_192 ||
        !params.has("beforeReceivedAtMs")))
  )
    invalid();
  const beforeReceivedAtMs = integer("beforeReceivedAtMs", Date.now());
  const kind = params.get("scope") ?? "all";
  const bundleId = params.get("bundleId");
  const installId = params.get("installId");
  let scope: EventHistoryPageInput["scope"];
  if (kind === "all" && bundleId === null && installId === null) {
    scope = { kind };
  } else if (
    kind === "bundle" &&
    installId === null &&
    bundleId !== null &&
    bundleId.length > 0 &&
    bundleId.length <= 1_024
  ) {
    scope = { kind, bundleId };
  } else if (
    kind === "installation" &&
    bundleId === null &&
    installId !== null &&
    installId.length > 0 &&
    installId.length <= 1_024
  ) {
    scope = { kind, installId };
  } else {
    return invalid();
  }
  return {
    scope,
    limit,
    beforeReceivedAtMs,
    ...(cursor === null ? {} : { cursor }),
  };
};

const json = (body: unknown, status: number): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });

// Additive v1 error envelope: do not change the legacy routes' response shapes.
export const createEventPageRouteHandler =
  (provider: InsightsProvider): RouteHandler =>
  async (_params, request) => {
    try {
      const input = parseInput(request);
      const events = provider.eventPages;
      if (events?.version !== 1 || !events.scopes.includes(input.scope.kind)) {
        return json(
          { error: { code: "INSIGHTS_EVENT_PAGES_UNSUPPORTED" } },
          501,
        );
      }
      return json(await events.getPage(input), 200);
    } catch (error) {
      if (
        error instanceof InsightsBadRequestError ||
        (error instanceof DatabasePluginInputError &&
          error.code === "invalid-query")
      ) {
        return json({ error: { code: "INSIGHTS_INVALID_EVENT_PAGE" } }, 400);
      }
      if (error instanceof InsightsQueryNotReadyError) {
        return json({ error: { code: "INSIGHTS_QUERY_NOT_READY" } }, 503);
      }
      if (error instanceof HotUpdaterSchemaMigrationRequiredError) {
        return json(
          { error: { code: "INSIGHTS_SCHEMA_MIGRATION_REQUIRED" } },
          503,
        );
      }
      return json({ error: { code: "INSIGHTS_EVENT_PAGE_FAILED" } }, 500);
    }
  };
