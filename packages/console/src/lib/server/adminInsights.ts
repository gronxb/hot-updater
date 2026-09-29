import type {
  InsightsEventPageInput,
  InsightsProvider,
} from "@hot-updater/server";

/** The Insights reads the console pages use. */
export type ConsoleInsightsReads = Omit<InsightsProvider, "appendBundleEvent">;

/** The server runs without the `insights()` plugin. */
export class InsightsOffError extends Error {
  override readonly name = "InsightsOffError";

  constructor() {
    super("Insights is off: the server runs without the insights() plugin.");
  }
}

/** A GET on a self-hosted server's admin handler. */
export type FetchAdmin = (path: string) => Promise<Response>;

const isOff = (response: Response) =>
  response.status === 204 &&
  response.headers.get("x-hot-updater-insights") === "disabled";

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
 * `insights()` plugin serves. A server without the plugin answers them with
 * 204 and `x-hot-updater-insights: disabled`.
 */
export const createAdminInsightsReads = (fetchAdmin: FetchAdmin) => {
  const read = async <T>(path: string): Promise<T | null> => {
    const response = await fetchAdmin(path);
    if (isOff(response)) throw new InsightsOffError();
    if (response.status === 404) return null;
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const message =
        typeof body === "object" &&
        body !== null &&
        typeof Reflect.get(body, "error") === "string"
          ? String(Reflect.get(body, "error"))
          : `The server answered ${path.split("?")[0]} with ${response.status}.`;
      throw new Error(message);
    }
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

  const reads: ConsoleInsightsReads = {
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
  };

  return {
    reads,
    /** Asks the server whether it runs Insights: one page of one event. */
    status: async (): Promise<"on" | "off"> =>
      isOff(await fetchAdmin("/events?limit=1")) ? "off" : "on",
  };
};
