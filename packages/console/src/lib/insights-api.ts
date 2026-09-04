import { useQuery } from "@tanstack/react-query";

import {
  findInsightsInstallationsRpc,
  getInsightsInstallationRpc,
  getReportingInstallationsRpc,
  pageInsightsEventsRpc,
  pageInsightsInstallationEventsRpc,
  type InsightsWindow,
  type ReportingInstallations,
} from "./insights-rpc";

export type { InsightsWindow, ReportingInstallations };

const STALE_TIME_MS = 30_000;

const queryKeys = {
  reportingInstallations: (window: InsightsWindow) =>
    ["insights", "reporting-installations", window] as const,
  events: (input: {
    readonly beforeReceivedAtMs: number;
    readonly cursor?: string;
    readonly limit: number;
  }) => ["insights", "events", input] as const,
  installations: (input: {
    readonly cursor?: string;
    readonly identity: string;
    readonly limit: number;
  }) => ["insights", "installations", input] as const,
  installation: (installId: string) =>
    ["insights", "installation", installId] as const,
  installationEvents: (input: {
    readonly beforeReceivedAtMs: number;
    readonly cursor?: string;
    readonly installId: string;
    readonly limit: number;
  }) => ["insights", "installation-events", input] as const,
};

export const useReportingInstallationsQuery = (window: InsightsWindow) =>
  useQuery({
    queryKey: queryKeys.reportingInstallations(window),
    queryFn: () => getReportingInstallationsRpc({ data: { window } }),
    refetchOnWindowFocus: true,
    staleTime: STALE_TIME_MS,
  });

export const useInsightsEventsQuery = (
  input: {
    readonly beforeReceivedAtMs: number;
    readonly cursor?: string;
    readonly limit: number;
  },
  enabled: boolean,
) =>
  useQuery({
    queryKey: queryKeys.events(input),
    queryFn: () => pageInsightsEventsRpc({ data: input }),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: STALE_TIME_MS,
  });

export const useInsightsInstallationsQuery = (
  input: {
    readonly cursor?: string;
    readonly identity: string;
    readonly limit: number;
  },
  enabled: boolean,
) =>
  useQuery({
    queryKey: queryKeys.installations(input),
    queryFn: () => findInsightsInstallationsRpc({ data: input }),
    enabled: enabled && input.identity.length > 0,
    staleTime: STALE_TIME_MS,
  });

export const useInsightsInstallationQuery = (
  installId: string,
  enabled: boolean,
) =>
  useQuery({
    queryKey: queryKeys.installation(installId),
    queryFn: () => getInsightsInstallationRpc({ data: { installId } }),
    enabled: enabled && installId.length > 0,
    staleTime: STALE_TIME_MS,
  });

export const useInsightsInstallationEventsQuery = (
  input: {
    readonly beforeReceivedAtMs: number;
    readonly cursor?: string;
    readonly installId: string;
    readonly limit: number;
  },
  enabled: boolean,
) =>
  useQuery({
    queryKey: queryKeys.installationEvents(input),
    queryFn: () => pageInsightsInstallationEventsRpc({ data: input }),
    enabled: enabled && input.installId.length > 0,
    refetchOnWindowFocus: true,
    staleTime: STALE_TIME_MS,
  });
