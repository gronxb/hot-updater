import type {
  InsightsEventPageInput,
  InsightsProvider,
} from "@hot-updater/server/plugins/insights";

import { ConsoleFeatureUnavailableError } from "../console-features";
import type { InsightsRetentionDays } from "../insights-retention";

/** The Insights reads the console pages use, and how long rows are kept. */
export type ConsoleInsightsReads = Omit<
  InsightsProvider,
  "appendBundleEvent"
> & {
  getRetention(): Promise<InsightsRetentionDays>;
};

/** A GET on a self-hosted server's admin handler. */
export type FetchAdmin = (path: string) => Promise<Response>;

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
    if (response.status === 404) return null;
    if (!response.ok) throw await errorOf(response, path);
    return (await response.json()) as T;
  };
  // A route no plugin serves answers 404: the server runs without insights(),
  // as after a restart without it once the console read its plugins.
  const required = async <T>(path: string): Promise<T> => {
    const value = await read<T>(path);
    if (value === null) {
      throw new ConsoleFeatureUnavailableError("insights", { remote: true });
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
    getRetention: () => required("/retention"),
  };
};
