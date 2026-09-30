import type {
  ReportingOverview,
  InsightsEventPageInput,
  InsightsInstallationEventPageInput,
  ActiveInstallationWindow,
} from "@hot-updater/server";
import type { InsightsScope } from "@hot-updater/server/plugins/insights";
import { createServerFn } from "@tanstack/react-start";

import { consoleAccess } from "./console-access";
import type {
  InsightsInstallationViewRow,
  InsightsViewPage,
} from "./insights-view";

export type InsightsWindow = ActiveInstallationWindow;
export type ReportingInstallations = ReportingOverview;
export type InsightsOverviewInput = InsightsScope & {
  readonly window: InsightsWindow;
  readonly bundleId?: string;
};

type EventsPageInput = InsightsEventPageInput;

type InstallationEventsPageInput = InsightsInstallationEventPageInput;

type InstallationsPageInput = {
  readonly cursor?: string;
  readonly identity: string;
  readonly limit: number;
};

/** The Insights reads, once the console's access check and the feature guard pass. */
const insightsReads = async () => {
  const [{ prepareConfig }, { requireFeature }] = await Promise.all([
    import("./server/config.server"),
    import("./server/runtime.server"),
  ]);
  const { runtime } = await prepareConfig();
  return requireFeature(runtime, "insights");
};

const readOverview = (input: InsightsOverviewInput) => input;
const readEventsPage = (input: EventsPageInput) => input;
const readInstallationEventsPage = (input: InstallationEventsPageInput) =>
  input;
const readInstallationPage = (input: InstallationsPageInput) => input;
const readInstallId = (input: { readonly installId: string }) => input;

export const getReportingInstallationsRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(readOverview)
  .handler(async ({ data }) =>
    (await insightsReads()).getReportingOverview(data),
  );

export const listInsightsEventsRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(readEventsPage)
  .handler(async ({ data }) => (await insightsReads()).listEvents(data));

export const listInsightsInstallationEventsRpc = createServerFn({
  method: "GET",
})
  .middleware([consoleAccess])
  .validator(readInstallationEventsPage)
  .handler(async ({ data }) =>
    (await insightsReads()).listInstallationEvents(data),
  );

export const getInsightsInstallationRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(readInstallId)
  .handler(async ({ data }) => (await insightsReads()).getInstallation(data));

/** How long the server's `insights()` keeps rows. */
export const getInsightsRetentionRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .handler(async () => (await insightsReads()).getRetention());

export const findInsightsInstallationsRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(readInstallationPage)
  .handler(async ({ data }) => {
    const insights = await insightsReads();
    const install = data.cursor
      ? null
      : await insights.getInstallation({ installId: data.identity });
    const matches = await insights.pageInstallationsByCurrentUserId({
      cursor: data.cursor,
      limit: Math.max(1, data.limit - (install === null ? 0 : 1)),
      userId: data.identity,
    });
    return {
      data:
        install === null
          ? matches.data
          : [
              install,
              ...matches.data.filter(
                ({ installId }) => installId !== install.installId,
              ),
            ],
      nextCursor: matches.nextCursor,
    } satisfies InsightsViewPage<InsightsInstallationViewRow>;
  });
