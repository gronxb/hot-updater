import type { RemoteDatabase } from "@hot-updater/plugin-core";

import type { InsightsApi } from "./index";
import { createInsightsModel } from "./model";
import { createInsightsProvider } from "./provider";
import type {
  InsightsUpdateFailures,
  InsightsUpdateFailuresInput,
} from "./reads";
import type { InsightsRetention } from "./schema";
import type { InsightsEventPageInput, InsightsProvider } from "./types";

/**
 * The Insights reads tooling shows, the Console and the CLI: the routes'
 * reads, update failures, and how long rows are kept.
 */
export type InsightsReads = Omit<InsightsProvider, "appendBundleEvent"> & {
  getRetention(): Promise<InsightsRetention>;
  getUpdateFailures(
    input: InsightsUpdateFailuresInput,
  ): Promise<InsightsUpdateFailures>;
};

/** The reads over the `insights()` API tooling assembled on the server's database. */
export const createInsightsReads = (api: InsightsApi): InsightsReads => ({
  ...createInsightsProvider(createInsightsModel(api)),
  getRetention: async () => api.retention,
  getUpdateFailures: api.getUpdateFailures,
});

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

export interface InsightsAdminReadsOptions {
  /**
   * The error for a server that runs without `insights()`, whose admin API
   * answers its routes with 404.
   */
  readonly unavailable?: () => Error;
}

/**
 * The reads over a self-hosted server's admin routes, which its `insights()`
 * serves, for tooling that reaches it through `standaloneRepository`.
 */
export const createInsightsAdminReads = (
  fetchAdmin: RemoteDatabase["fetchAdmin"],
  {
    unavailable = () =>
      new Error(
        "The server runs without insights(): its admin API serves no Insights routes.",
      ),
  }: InsightsAdminReadsOptions = {},
): InsightsReads => {
  const read = async <T>(path: string): Promise<T | null> => {
    const response = await fetchAdmin(path);
    if (response.status === 404) return null;
    if (!response.ok) throw await errorOf(response, path);
    return (await response.json()) as T;
  };
  // A route no plugin serves answers 404: the server runs without insights(),
  // as after a restart without it once the caller read its plugins.
  const required = async <T>(path: string): Promise<T> => {
    const value = await read<T>(path);
    if (value === null) throw unavailable();
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
    getUpdateFailures: ({ platform, channel, releaseId, timeRange }) =>
      required(
        withQuery("/failures", {
          platform,
          channel,
          releaseId,
          start: timeRange?.start,
          end: timeRange?.end,
        }),
      ),
    getRetention: () => required("/retention"),
  };
};
