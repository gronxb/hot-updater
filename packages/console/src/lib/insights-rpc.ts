import type {
  ActiveInstallationOverview,
  ActiveInstallationWindow,
  InsightsProvider,
} from "@hot-updater/server";
import { createServerFn } from "@tanstack/react-start";

import type {
  InsightsInstallationViewRow,
  InsightsViewPage,
} from "./insights-view";

export type InsightsWindow = ActiveInstallationWindow;
export type ReportingInstallations = ActiveInstallationOverview;

type EventsPageInput = {
  readonly beforeReceivedAtMs: number;
  readonly cursor?: string;
  readonly limit: number;
};

type InstallationEventsPageInput = EventsPageInput & {
  readonly installId: string;
};

type InstallationsPageInput = {
  readonly cursor?: string;
  readonly identity: string;
  readonly limit: number;
};

const runtime = async (): Promise<InsightsProvider> => {
  const { prepareConfig } = await import("./server/config.server");
  const { hotUpdater } = await prepareConfig();
  return hotUpdater;
};

const readWindow = (input: { readonly window: InsightsWindow }) => input;
const readEventsPage = (input: EventsPageInput) => input;
const readInstallationEventsPage = (input: InstallationEventsPageInput) =>
  input;
const readInstallationPage = (input: InstallationsPageInput) => input;
const readInstallId = (input: { readonly installId: string }) => input;

export const getReportingInstallationsRpc = createServerFn({ method: "GET" })
  .validator(readWindow)
  .handler(async ({ data }) =>
    (await runtime()).getActiveInstallationOverview(data),
  );

export const pageInsightsEventsRpc = createServerFn({ method: "GET" })
  .validator(readEventsPage)
  .handler(async ({ data }) => (await runtime()).pageEvents(data));

export const pageInsightsInstallationEventsRpc = createServerFn({
  method: "GET",
})
  .validator(readInstallationEventsPage)
  .handler(async ({ data }) => (await runtime()).pageInstallationEvents(data));

export const getInsightsInstallationRpc = createServerFn({ method: "GET" })
  .validator(readInstallId)
  .handler(async ({ data }) =>
    (await runtime()).getInstallation(data.installId),
  );

export const findInsightsInstallationsRpc = createServerFn({ method: "GET" })
  .validator(readInstallationPage)
  .handler(async ({ data }) => {
    const insights = await runtime();
    const install = data.cursor
      ? null
      : await insights.getInstallation(data.identity);
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
