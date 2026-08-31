import type { InsightsEventQueries } from "@hot-updater/plugin-core";
import { getInsightsEventPageCursorLimit } from "@hot-updater/plugin-core/internal";

import { compareEventNewest } from "./bounded/scan";
import type { InsightsEventPages } from "./domain";
import { InsightsBadRequestError } from "./errors";

export const createInsightsEventPages = (
  queries: InsightsEventQueries,
): InsightsEventPages => ({
  version: 1,
  scopes: queries.scopes,
  async getPage(input) {
    if (queries.version !== 1) {
      throw new InsightsBadRequestError("Unsupported event query version.");
    }
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      !Number.isSafeInteger(input.beforeReceivedAtMs) ||
      input.beforeReceivedAtMs < 0 ||
      (input.sinceReceivedAtMs !== undefined &&
        (!Number.isSafeInteger(input.sinceReceivedAtMs) ||
          input.sinceReceivedAtMs < 0 ||
          input.sinceReceivedAtMs > input.beforeReceivedAtMs)) ||
      !queries.scopes.includes(input.scope?.kind) ||
      (input.scope.kind !== "all" &&
        (() => {
          const id =
            input.scope.kind === "bundle"
              ? input.scope.bundleId
              : input.scope.installId;
          return (
            typeof id !== "string" ||
            (input.scope.kind === "bundle" &&
              (id.length === 0 || id.length > 1_024))
          );
        })()) ||
      (input.cursor !== undefined &&
        (typeof input.cursor !== "string" ||
          input.cursor.length === 0 ||
          input.cursor.length > getInsightsEventPageCursorLimit(input.scope)))
    ) {
      throw new InsightsBadRequestError("Invalid event page input.");
    }
    const page = await queries.page(input);
    // The provider owns lookahead and continuation. Cutting a provider page
    // here would lose unread rows hidden behind its continuation token.
    if (
      typeof page !== "object" ||
      page === null ||
      !Array.isArray(page.rows) ||
      page.rows.length > input.limit ||
      page.rows.some((row, index) => {
        const previous = page.rows[index - 1];
        return (
          typeof row !== "object" ||
          row === null ||
          typeof row.id !== "string" ||
          row.id.length === 0 ||
          ![
            "UPDATE_APPLIED",
            "RECOVERED",
            "RELEASE_ADOPTED",
            "UNCHANGED",
          ].includes(row.type) ||
          !Number.isSafeInteger(row.received_at_ms) ||
          row.received_at_ms < 0 ||
          row.received_at_ms < (input.sinceReceivedAtMs ?? 0) ||
          row.received_at_ms >= input.beforeReceivedAtMs ||
          (previous !== undefined && compareEventNewest(previous, row) >= 0) ||
          (input.scope.kind === "installation" &&
            (row.install_id !== input.scope.installId ||
              (row.type !== "UPDATE_APPLIED" && row.type !== "RECOVERED"))) ||
          (input.scope.kind === "bundle" &&
            !(
              (row.type === "UPDATE_APPLIED" &&
                row.to_bundle_id === input.scope.bundleId) ||
              (row.type === "RECOVERED" &&
                row.from_bundle_id === input.scope.bundleId)
            ))
        );
      }) ||
      new Set(page.rows.map((row) => row.id)).size !== page.rows.length ||
      (page.nextCursor !== null &&
        (typeof page.nextCursor !== "string" ||
          page.nextCursor.length === 0 ||
          page.nextCursor.length >
            getInsightsEventPageCursorLimit(input.scope) ||
          page.nextCursor === input.cursor))
    ) {
      throw new Error(
        "Insights event page did not respect its bounded continuation contract.",
      );
    }
    return {
      data: page.rows.map((row) => ({
        id: row.id,
        installId: row.install_id,
        type: row.type,
        fromBundleId: row.from_bundle_id,
        toBundleId: row.to_bundle_id,
        username: row.username,
        userId: row.user_id,
        platform: row.platform,
        appVersion: row.app_version,
        channel: row.channel,
        cohort: row.cohort,
        receivedAtMs: row.received_at_ms,
      })),
      pagination: {
        limit: input.limit,
        beforeReceivedAtMs: input.beforeReceivedAtMs,
        sinceReceivedAtMs: input.sinceReceivedAtMs ?? 0,
        nextCursor: page.nextCursor,
        hasNext: page.nextCursor !== null,
        consistency: "live",
      },
    };
  },
});
