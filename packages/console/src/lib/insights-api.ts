import type {
  InsightsInstallationPageInput,
  InsightsPageEventsInput,
  InsightsReportInput,
  InsightsReportPageInput,
} from "@hot-updater/plugin-core";
import { useQuery } from "@tanstack/react-query";

import {
  getInsightsReportRpc,
  pageInsightsEventsRpc,
  pageInsightsInstallationsRpc,
  pageInsightsReportRpc,
} from "./insights-rpc";

const INSIGHTS_STALE_TIME_MS = 30_000;
const INSIGHTS_PREPARATION_POLL_MS = 2_000;

export const insightsQueryKeys = {
  events: (input: InsightsPageEventsInput) =>
    ["insights", "events", input] as const,
  installations: (input: InsightsInstallationPageInput) =>
    ["insights", "installations", input] as const,
  report: (input: InsightsReportInput) =>
    ["insights", "report", input] as const,
  reportPage: (input: InsightsReportPageInput) =>
    ["insights", "report-page", input] as const,
};

const preparationPollInterval = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "state" in data &&
  (data.state === "preparing" || data.state === "stale")
    ? INSIGHTS_PREPARATION_POLL_MS
    : false;

export const useInsightsEventsQuery = (
  input: InsightsPageEventsInput,
  enabled = true,
) =>
  useQuery({
    enabled,
    queryFn: () => pageInsightsEventsRpc({ data: input }),
    queryKey: insightsQueryKeys.events(input),
    refetchInterval: ({ state }) => preparationPollInterval(state.data),
    refetchOnWindowFocus: true,
    staleTime: INSIGHTS_STALE_TIME_MS,
  });

export const useInsightsInstallationsQuery = (
  input: InsightsInstallationPageInput,
  enabled = true,
) =>
  useQuery({
    enabled,
    queryFn: () => pageInsightsInstallationsRpc({ data: input }),
    queryKey: insightsQueryKeys.installations(input),
    refetchInterval: ({ state }) => preparationPollInterval(state.data),
    refetchOnWindowFocus: true,
    staleTime: INSIGHTS_STALE_TIME_MS,
  });

export const useInsightsReportQuery = (
  input: InsightsReportInput,
  enabled = true,
) =>
  useQuery({
    enabled,
    queryFn: () => getInsightsReportRpc({ data: input }),
    queryKey: insightsQueryKeys.report(input),
    refetchInterval: ({ state }) => preparationPollInterval(state.data),
    refetchOnWindowFocus: true,
    staleTime: INSIGHTS_STALE_TIME_MS,
  });

export const useInsightsReportPageQuery = (
  input: InsightsReportPageInput,
  enabled = true,
) =>
  useQuery({
    enabled,
    queryFn: () => pageInsightsReportRpc({ data: input }),
    queryKey: insightsQueryKeys.reportPage(input),
    refetchOnWindowFocus: true,
    staleTime: INSIGHTS_STALE_TIME_MS,
  });
