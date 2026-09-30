import type {
  InsightsEventPageInput,
  InsightsProvider,
  InsightsDeletion,
} from "@hot-updater/server/plugins/insights";

import { ConsoleFeatureUnavailableError } from "../console-features";
import {
  DEFAULT_INSIGHTS_RETENTION,
  type InsightsRetentionDays,
} from "../insights-retention";

/** The Insights reads the console pages use, and how long rows are kept. */
export type ConsoleInsightsReads = Omit<
  InsightsProvider,
  "appendBundleEvent"
> & {
  getRetention(): Promise<InsightsRetentionDays>;
};

/**
 * Deleting Insights data, a bounded batch a call: `complete` is false while
 * rows remain, and the caller asks again.
 */
export interface ConsoleInsightsDeletion {
  deleteInstallation(installId: string): Promise<InsightsDeletion>;
  deleteUser(userId: string): Promise<InsightsDeletion>;
}

/** A request to a self-hosted server's admin handler: a GET unless `init` names another method. */
export type FetchAdmin = (
  path: string,
  init?: { readonly method?: string },
) => Promise<Response>;

/** The `error` a failed admin route answered with, or a message naming its status. */
const errorOf = async (response: Response, path: string): Promise<Error> => {
  const body: unknown = await response.json().catch(() => null);
  return new Error(
    typeof body === "object" &&
      body !== null &&
      typeof Reflect.get(body, "error") === "string"
      ? String(Reflect.get(body, "error"))
      : `The server answered ${path.split("?")[0]} with ${response.status}.`,
  );
};

const withQuery = (
  path: string,
  input: Readonly<Record<string, number | string | undefined>>,
): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const value = query.toString();
  return value.length === 0 ? path : `${path}?${value}`;
};

const eventQuery = ({
  beforeReceivedAtMs,
  sinceMs,
  cursor,
  limit,
}: Omit<InsightsEventPageInput, "bundle">) => ({
  beforeReceivedAtMs,
  sinceMs,
  cursor,
  limit,
});

/**
 * A self-hosted server's Insights, read through the admin routes its
 * `insights()` plugin serves.
 */
export const createAdminInsightsReads = (
  fetchAdmin: FetchAdmin,
): ConsoleInsightsReads => {
  const read = async <T>(path: string): Promise<T | null> => {
    const response = await fetchAdmin(path);
    // These routes answer with no content only on a server without
    // insights(), one restarted without it after the console read its plugins.
    if (response.status === 204) {
      throw new ConsoleFeatureUnavailableError("insights", { remote: true });
    }
    if (response.status === 404) return null;
    if (!response.ok) throw await errorOf(response, path);
    return (await response.json()) as T;
  };
  const required = async <T>(path: string): Promise<T> => {
    const value = await read<T>(path);
    if (value === null) {
      throw new Error(
        `The server has no Insights route ${path.split("?")[0]}. Upgrade @hot-updater/server on the server.`,
      );
    }
    return value;
  };

  return {
    getReportingOverview: ({ platform, channel, window, bundleId }) =>
      required(withQuery("/overview", { platform, channel, window, bundleId })),
    listEvents: ({ bundle, ...input }) =>
      required(
        withQuery("/events", {
          ...eventQuery(input),
          ...(bundle === undefined
            ? {}
            : {
                platform: bundle.platform,
                channel: bundle.channel,
                bundleId: bundle.bundleId,
                outcome: bundle.outcome,
              }),
        }),
      ),
    listInstallationEvents: ({ installId, ...input }) =>
      required(
        withQuery(
          `/installations/${encodeURIComponent(installId)}/events`,
          eventQuery(input),
        ),
      ),
    getInstallation: ({ installId }) =>
      read(`/installations/${encodeURIComponent(installId)}`),
    pageInstallationsByCurrentUserId: ({ userId, cursor, limit }) =>
      required(withQuery("/installations", { userId, cursor, limit })),
    // A server from before configurable retention keeps the defaults.
    getRetention: async () =>
      (await read<InsightsRetentionDays>("/retention")) ??
      DEFAULT_INSIGHTS_RETENTION,
  };
};

/**
 * A self-hosted server's Insights deletion, through the admin `DELETE`
 * routes its `insights()` plugin serves. Each request deletes a bounded batch.
 */
export const createAdminInsightsDeletion = (
  fetchAdmin: FetchAdmin,
): ConsoleInsightsDeletion => {
  const remove = async (path: string): Promise<InsightsDeletion> => {
    const response = await fetchAdmin(path, { method: "DELETE" });
    // Its /version lists insights(), so a server without these routes predates them.
    if (response.status === 404 || response.status === 405) {
      throw new Error(
        "The server has no Insights deletion route. Upgrade @hot-updater/server on the server.",
      );
    }
    if (!response.ok) throw await errorOf(response, path);
    return (await response.json()) as InsightsDeletion;
  };
  return {
    deleteInstallation: (installId) =>
      remove(`/installations/${encodeURIComponent(installId)}`),
    deleteUser: (userId) => remove(withQuery("/installations", { userId })),
  };
};
